import { Notice, TFile, MarkdownView, normalizePath } from "obsidian";
import type CloudSyncPlugin from "./main";
import type { FileManifestEntry, SyncInstruction } from "./api";
import { sha256Hex } from "./crypto";

/**
 * The sync engine handles the full sync lifecycle:
 * 1. Build a manifest of all local vault files (path, SHA-256 hash, size, modified_at)
 * 2. POST the manifest to /api/sync/delta to get instructions
 * 3. Execute each instruction (upload, download, conflict handling)
 * 4. POST /api/sync/complete to record the sync cursor
 *
 * Hashes are always computed on PLAINTEXT content so the server can
 * compare them across devices (encryption happens after hashing for uploads,
 * decryption happens before anything for downloads).
 */

/** Controls which directions data flows during a sync cycle. */
export type SyncMode = 'bidirectional' | 'push' | 'pull';

interface CachedFileInfo {
  hash: string;
  mtime: number;
  size: number;
}

type CompiledPattern =
  | { kind: 'prefix'; value: string }
  | { kind: 'exact'; value: string }
  | { kind: 'regex'; re: RegExp };

const VALID_ACTIONS = new Set<string>(["upload", "download", "delete", "conflict"]);

export class SyncEngine {
  private plugin: CloudSyncPlugin;
  private syncing = false;
  /** Cache of file hashes keyed by path. Only recompute when mtime/size changes. */
  private hashCache: Map<string, CachedFileInfo> = new Map();
  /** True when local vault changes have been detected since last sync. */
  private dirty = false;

  // Pre-compiled exclude patterns — rebuilt only when the list changes.
  private _patternCache: CompiledPattern[] = [];
  private _patternCacheKey = "";

  /**
   * True when at least one download was deferred this cycle because the file
   * was open in an editor while the user was typing. The sync cursor is NOT
   * advanced when this is true so the next auto-sync retries those files.
   */
  private _hasDeferredDownloads = false;

  get hasDeferredDownloads(): boolean {
    return this._hasDeferredDownloads;
  }

  constructor(plugin: CloudSyncPlugin) {
    this.plugin = plugin;
  }

  get isSyncing(): boolean {
    return this.syncing;
  }

  get isDirty(): boolean {
    return this.dirty;
  }

  /** Mark the engine as having pending local changes. */
  markDirty(): void {
    this.dirty = true;
  }

  /**
   * Run a full sync cycle.
   * @param silent  Suppress notifications when there are no changes (auto-syncs).
   * @param mode    Bidirectional, push-only, or pull-only.
   * @param forced  When true (user-initiated), bypass typing protection and
   *                download even for files open in an editor. When false
   *                (auto-triggered), defer downloads for actively-edited files.
   */
  async sync(silent = false, mode: SyncMode = 'bidirectional', forced = false): Promise<void> {
    if (this.syncing) {
      if (!silent) new Notice("CloudSync: Sync already in progress");
      return;
    }

    if (!this.plugin.api.isLoggedIn()) {
      if (!silent) new Notice("CloudSync: Not logged in. Please log in first.");
      return;
    }

    this.syncing = true;
    this.plugin.statusBar.setState("syncing", "Building manifest...");

    try {
      // 1. Build local file manifest
      const manifest = await this.buildManifest();
      this.plugin.statusBar.setState(
        "syncing",
        `Checking ${manifest.length} files...`
      );

      // 2. Compute explicitly deleted paths: files that were present after the
      // last successful sync but are no longer in the vault.
      //
      // Safety guard: if more than 50% of last-synced files appear missing,
      // treat it as a possible accidental vault wipe and send no deletions.
      // The server will respond with Download instructions for the missing files,
      // restoring them rather than propagating the (likely accidental) deletion.
      const currentPathSet = new Set(manifest.map((f) => f.path));
      const lastPaths = this.plugin.settings.lastSyncedPaths ?? [];
      const deletedPaths: string[] = [];
      if (lastPaths.length > 0) {
        const candidates = lastPaths.filter((p) => !currentPathSet.has(p));
        const ratio = candidates.length / lastPaths.length;
        if (ratio <= 0.5) {
          deletedPaths.push(...candidates);
        } else {
          new Notice(
            `CloudSync: ${candidates.length} deletion(s) skipped — exceeded 50% safety threshold. ` +
            `Use "Push only" to force-propagate intentional deletions.`,
            8_000
          );
          console.warn(
            `CloudSync: ${candidates.length}/${lastPaths.length} tracked files appear deleted — ` +
            `ratio ${(ratio * 100).toFixed(0)}% exceeds 50% threshold, skipping explicit deletes ` +
            `(treating as possible vault wipe; server will send Download instructions instead)`
          );
        }
      }

      // 3. Get delta instructions from server.
      // In pull mode, don't report local deletions — we're only receiving changes.
      const effectiveDeletedPaths = mode === 'pull' ? [] : deletedPaths;
      const delta = await this.plugin.api.delta(manifest, effectiveDeletedPaths);

      // 3a. Validate instructions — reject anything with an unknown action or
      // missing/invalid path so a buggy or malicious server can't corrupt the vault.
      const rawInstructions = delta.instructions.filter((i) => {
        if (!i.path || typeof i.path !== "string" || !VALID_ACTIONS.has(i.action)) {
          console.warn(`CloudSync: Ignoring invalid sync instruction: ${JSON.stringify(i)}`);
          return false;
        }
        return true;
      });

      // 3b. Reconcile encryption salt — must happen BEFORE any downloads so we
      // decrypt with the correct key in this same sync cycle.
      await this.reconcileEncryptionSalt(delta.encryption_salt);

      // Filter instructions based on sync mode:
      //   push — only upload; conflicts resolve local-wins (no conflict copy created)
      //   pull — only download/delete; conflicts resolve server-wins (no upload)
      //   bidirectional — all instruction types (current behaviour)
      const instructions =
        mode === 'push'
          ? rawInstructions.filter(i => i.action === 'upload' || i.action === 'conflict')
          : mode === 'pull'
          ? rawInstructions.filter(i => i.action === 'download' || i.action === 'delete' || i.action === 'conflict')
          : rawInstructions;

      if (instructions.length === 0) {
        // Nothing to do in this mode
        await this.plugin.api.complete();
        this.plugin.settings.lastSyncTime = Date.now();
        this.plugin.settings.lastSyncedPaths = manifest.map((f) => f.path);
        await this.plugin.saveSettings();
        this.dirty = false;
        this.plugin.statusBar.setState("idle");
        return;
      }

      // 4. Process instructions
      let uploaded = 0;
      let downloaded = 0;
      let deleted = 0;
      let conflicts = 0;
      let errors = 0;
      let downloadErrors = 0; // tracked separately: download failures block cursor advance
      let deferred = 0;        // downloads skipped due to active editing
      this._hasDeferredDownloads = false;
      const total = instructions.length;

      for (let i = 0; i < instructions.length; i++) {
        const instruction = instructions[i];
        try {
          switch (instruction.action) {
            case "upload":
              this.plugin.statusBar.setProgress(
                i + 1,
                total,
                `Uploading: ${instruction.path}`
              );
              await this.withRetry(() => this.handleUpload(instruction), instruction.path);
              uploaded++;
              break;

            case "download":
              this.plugin.statusBar.setProgress(
                i + 1,
                total,
                `Downloading: ${instruction.path}`
              );
              if (!forced && this.shouldDeferDownload(instruction.path)) {
                deferred++;
                this._hasDeferredDownloads = true;
                console.log(`CloudSync: Deferred download of "${instruction.path}" — file open in editor, user is typing`);
              } else if (await this.withRetry(() => this.handleDownload(instruction), instruction.path)) {
                downloaded++;
              }
              break;

            case "conflict":
              this.plugin.statusBar.setProgress(
                i + 1,
                total,
                `Resolving conflict: ${instruction.path}`
              );
              if (mode === 'push') {
                // Local wins: upload without downloading a conflict copy
                await this.withRetry(() => this.handleUpload(instruction), instruction.path);
                uploaded++;
              } else if (mode === 'pull') {
                // Server wins: overwrite local without uploading.
                // Defer if typing protection applies.
                if (!forced && this.shouldDeferDownload(instruction.path)) {
                  deferred++;
                  this._hasDeferredDownloads = true;
                  console.log(`CloudSync: Deferred pull-conflict for "${instruction.path}" — file open in editor, user is typing`);
                } else if (await this.withRetry(() => this.handleDownload(instruction), instruction.path)) {
                  downloaded++;
                }
              } else {
                // Bidirectional: handleConflict saves server copy under a conflict
                // path and uploads local version. The user's active edit is never
                // overwritten, so no deferral needed.
                await this.handleConflict(instruction);
                conflicts++;
              }
              break;

            case "delete":
              this.plugin.statusBar.setProgress(
                i + 1,
                total,
                `Deleting: ${instruction.path}`
              );
              await this.handleDelete(instruction);
              deleted++;
              break;
          }
        } catch (e: unknown) {
          errors++;
          if (instruction.action === "download" || instruction.action === "conflict") {
            downloadErrors++;
          }
          const msg = e instanceof Error ? e.message : String(e);
          const status = (e as { status?: number }).status;
          const prefix = status ? `[HTTP ${status}] ` : "";
          console.error(`CloudSync: Error processing ${instruction.path}: ${prefix}${msg}`);
        }
      }

      // 5. Complete sync — only advance the server cursor if all downloads
      // succeeded AND none were deferred due to active editing.
      // Skipping complete() preserves the cursor so the next auto-sync
      // retries the missing/deferred files automatically.
      if (downloadErrors === 0 && deferred === 0) {
        await this.plugin.api.complete();
        this.plugin.settings.lastSyncTime = Date.now();
        this.plugin.settings.lastSyncedPaths = manifest.map((f) => f.path);
        await this.plugin.saveSettings();
        this.dirty = false;
      } else {
        if (downloadErrors > 0) {
          console.warn(
            `CloudSync: ${downloadErrors} download(s) failed — cursor not advanced, will retry on next sync.`
          );
        }
        if (deferred > 0) {
          console.log(
            `CloudSync: ${deferred} download(s) deferred (files open in editor) — cursor not advanced, will flush when idle.`
          );
        }
      }

      // Report results (skip notification in silent mode when nothing happened)
      const parts: string[] = [];
      if (uploaded > 0) parts.push(`${uploaded} uploaded`);
      if (downloaded > 0) parts.push(`${downloaded} downloaded`);
      if (deleted > 0) parts.push(`${deleted} deleted`);
      if (conflicts > 0) parts.push(`${conflicts} conflicts`);
      if (deferred > 0) parts.push(`${deferred} deferred`);
      if (errors > 0) parts.push(`${errors} errors`);

      if (!silent || parts.length > 0) {
        const summary = parts.length > 0 ? parts.join(", ") : "no changes";
        const opName = mode === 'push' ? 'Push' : mode === 'pull' ? 'Pull' : 'Sync';
        new Notice(`CloudSync: ${opName} complete (${summary})`);
      }
      this.plugin.statusBar.setState("idle");
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("CloudSync: Sync failed:", msg);
      new Notice(`CloudSync: Sync failed - ${msg}`);
      this.plugin.statusBar.setState("error", `Error: ${msg}`);
    } finally {
      this.syncing = false;
    }
  }

  /**
   * Build a manifest of all files in the vault.
   * Uses a hash cache to avoid re-reading files that haven't changed
   * (same mtime and size). Only files with a new mtime or size are
   * read and hashed — unchanged files reuse their cached hash.
   */
  private async buildManifest(): Promise<FileManifestEntry[]> {
    const vault = this.plugin.app.vault;
    const files = vault.getFiles();
    const manifest: FileManifestEntry[] = [];
    const seenPaths = new Set<string>();
    let cacheHits = 0;

    for (const file of files) {
      if (this.shouldSkip(file.path)) continue;
      seenPaths.add(file.path);

      const mtime = Math.floor(file.stat.mtime / 1000);
      const size = file.stat.size;

      // Check cache: if mtime and size are unchanged, reuse the cached hash
      const cached = this.hashCache.get(file.path);
      if (cached && cached.mtime === mtime && cached.size === size) {
        manifest.push({
          path: file.path,
          hash: cached.hash,
          size: cached.size,
          modified_at: mtime,
        });
        cacheHits++;
        continue;
      }

      // File is new or changed — read and hash it
      try {
        const content = await vault.readBinary(file);
        const hash = await sha256Hex(content);

        this.hashCache.set(file.path, { hash, mtime, size: content.byteLength });

        manifest.push({
          path: file.path,
          hash,
          size: content.byteLength,
          modified_at: mtime,
        });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn(`CloudSync: Could not read ${file.path}: ${msg}`);
      }
    }

    // Clean up cache entries for files that no longer exist
    for (const path of this.hashCache.keys()) {
      if (!seenPaths.has(path)) {
        this.hashCache.delete(path);
      }
    }

    console.log(
      `CloudSync: Manifest built — ${manifest.length} files, ${cacheHits} cached, ${manifest.length - cacheHits} hashed`
    );

    return manifest;
  }

  /**
   * Handle an upload instruction: read file, optionally encrypt, upload.
   */
  private async handleUpload(instruction: SyncInstruction): Promise<void> {
    const vault = this.plugin.app.vault;
    const file = vault.getAbstractFileByPath(instruction.path);

    if (!(file instanceof TFile)) {
      throw new Error(`File not found in vault: ${instruction.path}`);
    }

    const plaintext = await vault.readBinary(file);
    const plaintextHash = await sha256Hex(plaintext);

    // Encrypt if passphrase is set, then drop the plaintext reference so the
    // GC can reclaim it before the upload. For large files this halves peak
    // memory usage during the network transfer.
    let data: ArrayBuffer;
    if (this.isEncryptionEnabled()) {
      data = await this.plugin.crypto.encrypt(
        plaintext,
        this.plugin.settings.encryptionPassphrase,
        this.plugin.settings.encryptionSalt
      );
    } else {
      data = plaintext;
    }

    await this.plugin.api.upload(instruction.path, data, plaintextHash);
  }

  /**
   * Handle a download instruction: download, optionally decrypt, write file.
   */
  private async handleDownload(instruction: SyncInstruction): Promise<boolean> {
    if (!instruction.file_id) {
      throw new Error(`No file_id for download: ${instruction.path}`);
    }

    // Guard: if the server has encryption configured but this device has no
    // passphrase set, writing the raw encrypted blob would corrupt the vault
    // file. Throw a descriptive error so the user knows what to fix.
    if (this.plugin.settings.encryptionSalt && !this.plugin.settings.encryptionPassphrase) {
      throw new Error(
        `Cannot download "${instruction.path}" — server has encryption configured but no ` +
        `passphrase is set on this device. Enter your encryption passphrase in plugin settings.`
      );
    }

    const rawData = await this.plugin.api.download(instruction.file_id);
    let data: ArrayBuffer;

    // Decrypt if passphrase is set
    if (this.isEncryptionEnabled()) {
      try {
        data = await this.plugin.crypto.decrypt(
          rawData,
          this.plugin.settings.encryptionPassphrase,
          this.plugin.settings.encryptionSalt
        );
      } catch (decryptErr) {
        // Decryption failed — the blob may have been uploaded before encryption
        // was configured (stored as plaintext). Try to recover gracefully.
        const rawHash = await sha256Hex(rawData);
        const vault = this.plugin.app.vault;
        const normalizedPath = normalizePath(instruction.path);
        const existing = vault.getAbstractFileByPath(normalizedPath);

        if (existing instanceof TFile) {
          const localData = await vault.readBinary(existing);
          const localHash = await sha256Hex(localData);

          if (localHash === rawHash) {
            // Local file already has the same content as the raw (plaintext) blob.
            // This file was uploaded without encryption; local copy is correct.
            console.warn(
              `CloudSync: Decryption skipped for "${instruction.path}" — ` +
              `blob matches local content (uploaded before encryption was enabled). Fixing server hash.`
            );
            await this.plugin.api.fixHash(instruction.file_id, localHash);
            return false;
          }
        }

        // If the raw blob hash matches the server's recorded hash the blob is
        // genuinely plaintext (not an encryption failure) — use it as-is.
        if (instruction.server_hash && rawHash === instruction.server_hash) {
          console.warn(
            `CloudSync: Using plaintext blob for "${instruction.path}" — ` +
            `file was uploaded before encryption was enabled.`
          );
          data = rawData;
        } else {
          // Truly unrecoverable — wrong passphrase or corrupted blob.
          throw decryptErr;
        }
      }
    } else {
      data = rawData;
    }

    const vault = this.plugin.app.vault;
    const normalizedPath = normalizePath(instruction.path);
    const existing = vault.getAbstractFileByPath(normalizedPath);

    // If we already have this file, check whether the content actually differs.
    // The server may have a stale hash (e.g. encrypted blob hash) that doesn't
    // match our plaintext hash, causing a false "download" instruction.
    if (existing instanceof TFile) {
      let localData: ArrayBuffer;
      try {
        localData = await vault.readBinary(existing);
      } catch {
        // File is locked (EBUSY on Windows) or unreadable — skip this file for
        // this sync cycle. It will be retried on the next sync.
        console.warn(`CloudSync: Could not read "${instruction.path}" for comparison (file may be locked) — skipping`);
        return false;
      }
      const localHash = await sha256Hex(localData);
      const downloadedHash = await sha256Hex(data);

      if (localHash === downloadedHash) {
        // Content is identical — fix the server's hash, skip the write
        await this.plugin.api.fixHash(instruction.file_id, localHash);
        return false; // nothing was written
      }

      await vault.modifyBinary(existing, data);
      return true;
    }

    // New file — ensure all parent directories exist, then write
    await this.ensureDirectory(normalizedPath);
    await vault.createBinary(normalizedPath, data);
    return true;
  }

  /**
   * Handle a conflict: download the server version with a .conflict suffix,
   * then upload the local version so both copies are preserved.
   */
  private async handleConflict(instruction: SyncInstruction): Promise<void> {
    // First, if there is a server version, download it with a conflict suffix
    if (instruction.file_id) {
      let serverData = await this.plugin.api.download(instruction.file_id);

      if (this.isEncryptionEnabled()) {
        serverData = await this.plugin.crypto.decrypt(
          serverData,
          this.plugin.settings.encryptionPassphrase,
          this.plugin.settings.encryptionSalt
        );
      }

      const conflictPath = this.makeConflictPath(instruction.path);
      await this.ensureDirectory(conflictPath);

      const vault = this.plugin.app.vault;
      const existing = vault.getAbstractFileByPath(conflictPath);
      if (existing instanceof TFile) {
        await vault.modifyBinary(existing, serverData);
      } else {
        await vault.createBinary(conflictPath, serverData);
      }

      new Notice(
        `CloudSync: Conflict on "${instruction.path}" - server version saved as "${conflictPath}"`
      );
    }

    // Then upload the local version to the server so it becomes the current version
    const vault = this.plugin.app.vault;
    const localFile = vault.getAbstractFileByPath(instruction.path);
    if (localFile instanceof TFile) {
      const plaintext = await vault.readBinary(localFile);
      const plaintextHash = await sha256Hex(plaintext);
      let data: ArrayBuffer = plaintext;
      if (this.isEncryptionEnabled()) {
        data = await this.plugin.crypto.encrypt(
          plaintext,
          this.plugin.settings.encryptionPassphrase,
          this.plugin.settings.encryptionSalt
        );
      }
      await this.plugin.api.upload(instruction.path, data, plaintextHash);
    }
  }

  /**
   * Handle a delete instruction: move the local file to system trash so it
   * can be recovered if the deletion was propagated in error.
   *
   * Note: we do NOT call api.deleteFile() here — the server already recorded
   * the deletion. Calling it again would hit an already-soft-deleted row,
   * get 0 rows affected, and return 404.
   */
  private async handleDelete(instruction: SyncInstruction): Promise<void> {
    const vault = this.plugin.app.vault;
    const file = vault.getAbstractFileByPath(instruction.path);
    if (file instanceof TFile) {
      // Move to system trash (recoverable) rather than permanent deletion.
      // Falls back to Obsidian's .trash folder when system trash is unavailable.
      await vault.trash(file, true);
    }
  }

  /**
   * Create a conflict path by adding .conflict-{timestamp} before the extension.
   */
  private makeConflictPath(originalPath: string): string {
    const timestamp = new Date()
      .toISOString()
      .replace(/[:.]/g, "-")
      .slice(0, 19);
    const lastDot = originalPath.lastIndexOf(".");
    if (lastDot === -1) {
      return `${originalPath}.conflict-${timestamp}`;
    }
    const base = originalPath.substring(0, lastDot);
    const ext = originalPath.substring(lastDot);
    return `${base}.conflict-${timestamp}${ext}`;
  }

  /**
   * Ensure all parent directories for a given file path exist, creating
   * them recursively if needed. Handles arbitrarily deep directory trees.
   */
  private async ensureDirectory(filePath: string): Promise<void> {
    const parts = filePath.split("/");
    if (parts.length <= 1) return;

    const vault = this.plugin.app.vault;
    let current = "";
    for (const part of parts.slice(0, -1)) {
      current = current ? `${current}/${part}` : part;
      if (!vault.getAbstractFileByPath(current)) {
        await vault.createFolder(current);
      }
    }
  }

  /**
   * Check if a file should be skipped during sync.
   *
   * Uses pre-compiled patterns for performance — patterns are compiled once
   * per sync (or when the exclude list changes) rather than on every file.
   */
  private shouldSkip(path: string): boolean {
    // Skip hidden files and Obsidian internals — always
    if (path.startsWith(".")) return true;
    // Skip plugin's own data
    if (path === "data.json") return true;
    // Skip conflict copies — these are local-only annotations, not source files.
    // Uploading them would create infinite conflict chains across devices.
    if (path.includes(".conflict-")) return true;

    // Check user-configured exclude patterns (pre-compiled)
    for (const compiled of this.getCompiledPatterns()) {
      switch (compiled.kind) {
        case 'prefix':
          if (path === compiled.value || path.startsWith(compiled.value + "/")) return true;
          break;
        case 'exact':
          if (path === compiled.value) return true;
          break;
        case 'regex':
          if (compiled.re.test(path)) return true;
          break;
      }
    }

    return false;
  }

  /**
   * Returns true if the given vault path is currently open in any Obsidian
   * markdown editor leaf. Non-markdown files (canvas, PDF, etc.) are not
   * checked since they can't have in-progress text edits.
   */
  private isFileOpenInEditor(path: string): boolean {
    return this.plugin.app.workspace
      .getLeavesOfType("markdown")
      .some((leaf) => (leaf.view as MarkdownView).file?.path === path);
  }

  /**
   * Returns true when a download should be held back for this sync cycle.
   *
   * Conditions for deferral (ALL must be true):
   *   1. Typing protection is enabled in settings.
   *   2. The file is currently open in an Obsidian editor.
   *   3. The user has pressed a key within the last 15 seconds.
   *
   * Point 3 is the key gate: once the user stops typing, the idle timer
   * (started on every keydown in main.ts) fires a background sync after
   * 15 s, at which point this check returns false and the download proceeds.
   */
  private shouldDeferDownload(path: string): boolean {
    if (!this.plugin.settings.typingProtection) return false;
    if (!this.isFileOpenInEditor(path)) return false;
    return this.plugin.isUserTyping();
  }

  /**
   * Return pre-compiled exclude patterns, rebuilding only when the pattern list changes.
   */
  private getCompiledPatterns(): CompiledPattern[] {
    const key = this.plugin.settings.excludePatterns.join("\0");
    if (key === this._patternCacheKey) return this._patternCache;

    this._patternCacheKey = key;
    this._patternCache = this.plugin.settings.excludePatterns.map((p): CompiledPattern => {
      if (p.endsWith("/")) {
        return { kind: 'prefix', value: p.slice(0, -1) };
      }
      if (!p.includes("*") && !p.includes("?")) {
        return { kind: 'exact', value: p };
      }
      // Convert glob to regex
      let regex = "^";
      for (let i = 0; i < p.length; i++) {
        const ch = p[i];
        if (ch === "*" && p[i + 1] === "*") {
          regex += ".*";
          i++;
          if (p[i + 1] === "/") i++;
        } else if (ch === "*") {
          regex += "[^/]*";
        } else if ("?.()[]{+^$|\\".includes(ch)) {
          regex += "\\" + ch;
        } else {
          regex += ch;
        }
      }
      regex += "$";
      try {
        return { kind: 'regex', re: new RegExp(regex) };
      } catch {
        return { kind: 'exact', value: p };
      }
    });

    return this._patternCache;
  }

  /**
   * Retry an async operation up to maxAttempts times with linear backoff.
   * Retries on network errors and 5xx responses. Does not retry on
   * definitive client errors (401, 403, 404, 413) that won't improve.
   */
  private async withRetry<T>(
    fn: () => Promise<T>,
    path: string,
    maxAttempts = 3
  ): Promise<T> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await fn();
      } catch (e: unknown) {
        lastError = e;
        const status = (e as { status?: number }).status;
        // Don't retry definitive client errors
        if (status === 401 || status === 403 || status === 404 || status === 413) {
          throw e;
        }
        if (attempt < maxAttempts) {
          const delay = attempt * 2000; // 2 s, 4 s
          console.warn(
            `CloudSync: Attempt ${attempt} failed for ${path} — retrying in ${delay / 1000}s`
          );
          await new Promise((r) => setTimeout(r, delay));
        }
      }
    }
    throw lastError;
  }

  /**
   * Force re-encrypt and re-upload every local vault file, bypassing the
   * delta hash-comparison logic. Called after changePassphrase so that all
   * locally-present files get new encrypted blobs with the new key.
   *
   * Files that only exist on the server cannot be re-encrypted here — they
   * require the originating device to push them after adopting the new key.
   */
  async reEncryptLocal(): Promise<void> {
    if (this.syncing) throw new Error("Sync already in progress");
    if (!this.plugin.api.isLoggedIn()) throw new Error("Not logged in");

    this.syncing = true;
    this.plugin.statusBar.setState("syncing", "Re-encrypting files...");

    try {
      const manifest = await this.buildManifest();
      let uploaded = 0;
      let errors = 0;
      const total = manifest.length;

      for (let i = 0; i < manifest.length; i++) {
        const entry = manifest[i];
        this.plugin.statusBar.setProgress(i + 1, total, `Re-encrypting: ${entry.path}`);
        const instruction: import("./api").SyncInstruction = {
          path: entry.path,
          action: "upload",
          file_id: null,
          server_hash: null,
          server_modified_at: null,
        };
        try {
          await this.withRetry(() => this.handleUpload(instruction), entry.path);
          uploaded++;
        } catch (e: unknown) {
          errors++;
          const msg = e instanceof Error ? e.message : String(e);
          console.error(`CloudSync: Re-encrypt failed for ${entry.path}: ${msg}`);
        }
      }

      console.log(
        `CloudSync: Re-encrypted ${uploaded} local file(s)${errors > 0 ? `, ${errors} error(s)` : ""}`
      );
    } finally {
      this.syncing = false;
      this.plugin.statusBar.setState("idle");
    }
  }

  /**
   * Synchronise the local encryption salt with the server's authoritative value.
   *
   * Three cases:
   * 1. Server has a salt → adopt it (clears key cache if it changed).
   * 2. Server has no salt, user has a passphrase → we are the first device;
   *    generate a salt if needed, then push it to the server.
   * 3. Server has no salt, no passphrase → nothing to do.
   */
  private async reconcileEncryptionSalt(serverSalt: string): Promise<void> {
    if (serverSalt) {
      // Case 1: adopt the server's salt.
      if (this.plugin.settings.encryptionSalt !== serverSalt) {
        this.plugin.settings.encryptionSalt = serverSalt;
        this.plugin.crypto.clearCache();
        await this.plugin.saveSettings();
      }
      // Ensure the vault key is on the server so other devices can auto-configure.
      // This covers users who had encryption before the vault key feature was added,
      // and also handles silent failures from earlier push attempts.
      if (this.plugin.settings.encryptionPassphrase) {
        void this.plugin.pushVaultKey();
      }
    } else if (this.plugin.settings.encryptionPassphrase) {
      // Case 2: first device to set up encryption — push our salt.
      if (!this.plugin.settings.encryptionSalt) {
        this.plugin.settings.encryptionSalt = this.plugin.crypto.generateSalt();
        await this.plugin.saveSettings();
      }
      try {
        await this.plugin.api.pushEncryptionSalt(this.plugin.settings.encryptionSalt);
        // Also push the encrypted vault key so other devices can auto-configure.
        void this.plugin.pushVaultKey();
      } catch {
        // Non-critical — another device may have set it concurrently
      }
    }
    // Case 3: no passphrase, no server salt — encryption not configured.
  }

  /**
   * Check if encryption is enabled.
   */
  private isEncryptionEnabled(): boolean {
    return (
      !!this.plugin.settings.encryptionPassphrase &&
      !!this.plugin.settings.encryptionSalt
    );
  }
}
