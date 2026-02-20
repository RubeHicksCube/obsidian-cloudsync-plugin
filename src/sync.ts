import { Notice, TFile, normalizePath } from "obsidian";
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

export class SyncEngine {
  private plugin: CloudSyncPlugin;
  private syncing = false;
  /** Cache of file hashes keyed by path. Only recompute when mtime/size changes. */
  private hashCache: Map<string, CachedFileInfo> = new Map();
  /** True when local vault changes have been detected since last sync. */
  private dirty = false;

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
   * @param silent If true, suppress notifications when there are no changes.
   */
  async sync(silent = false, mode: SyncMode = 'bidirectional'): Promise<void> {
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

      // 3a. Reconcile encryption salt — must happen BEFORE any downloads so we
      // decrypt with the correct key in this same sync cycle.
      await this.reconcileEncryptionSalt(delta.encryption_salt);

      // Filter instructions based on sync mode:
      //   push — only upload; conflicts resolve local-wins (no conflict copy created)
      //   pull — only download/delete; conflicts resolve server-wins (no upload)
      //   bidirectional — all instruction types (current behaviour)
      const instructions =
        mode === 'push'
          ? delta.instructions.filter(i => i.action === 'upload' || i.action === 'conflict')
          : mode === 'pull'
          ? delta.instructions.filter(i => i.action === 'download' || i.action === 'delete' || i.action === 'conflict')
          : delta.instructions;

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
              if (await this.handleDownload(instruction)) {
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
                // Server wins: overwrite local without uploading
                if (await this.handleDownload(instruction)) downloaded++;
              } else {
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

      // 5. Complete sync — only advance the server cursor if all downloads succeeded.
      // Skipping complete() when downloads failed prevents the server cursor from
      // advancing on a partial sync, so the next auto-sync retries the missing files.
      if (downloadErrors === 0) {
        await this.plugin.api.complete();
        this.plugin.settings.lastSyncTime = Date.now();
        // Record the current vault state so the next sync can detect local deletions.
        this.plugin.settings.lastSyncedPaths = manifest.map((f) => f.path);
        await this.plugin.saveSettings();
        this.dirty = false;
      } else {
        console.warn(
          `CloudSync: ${downloadErrors} download(s) failed — skipping complete() so the sync cursor is not advanced. Will retry on next sync.`
        );
      }

      // Report results (skip notification in silent mode when nothing happened)
      const parts: string[] = [];
      if (uploaded > 0) parts.push(`${uploaded} uploaded`);
      if (downloaded > 0) parts.push(`${downloaded} downloaded`);
      if (deleted > 0) parts.push(`${deleted} deleted`);
      if (conflicts > 0) parts.push(`${conflicts} conflicts`);
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

    let data = await this.plugin.api.download(instruction.file_id);

    // Decrypt if passphrase is set
    if (this.isEncryptionEnabled()) {
      data = await this.plugin.crypto.decrypt(
        data,
        this.plugin.settings.encryptionPassphrase,
        this.plugin.settings.encryptionSalt
      );
    }

    const vault = this.plugin.app.vault;
    const normalizedPath = normalizePath(instruction.path);
    const existing = vault.getAbstractFileByPath(normalizedPath);

    // If we already have this file, check whether the content actually differs.
    // The server may have a stale hash (e.g. encrypted blob hash) that doesn't
    // match our plaintext hash, causing a false "download" instruction.
    if (existing instanceof TFile) {
      const localData = await vault.readBinary(existing);
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

    // New file — write it
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
   * Handle a delete instruction: the server has already marked this file as
   * deleted (propagated from another device via deleted_paths). Remove the
   * local copy so all devices converge on the same state.
   *
   * Note: we do NOT call api.deleteFile() here — the server already recorded
   * the deletion. Calling it again would hit an already-soft-deleted row,
   * get 0 rows affected, and return 404.
   */
  private async handleDelete(instruction: SyncInstruction): Promise<void> {
    const vault = this.plugin.app.vault;
    const file = vault.getAbstractFileByPath(instruction.path);
    if (file instanceof TFile) {
      await vault.delete(file);
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
   * Ensure all parent directories for a given file path exist.
   */
  private async ensureDirectory(filePath: string): Promise<void> {
    const parts = filePath.split("/");
    if (parts.length <= 1) return;

    const dirPath = parts.slice(0, -1).join("/");
    const vault = this.plugin.app.vault;

    if (!vault.getAbstractFileByPath(dirPath)) {
      await vault.createFolder(dirPath);
    }
  }

  /**
   * Check if a file should be skipped during sync.
   * Uses built-in rules plus user-configured exclude patterns.
   */
  private shouldSkip(path: string): boolean {
    // Skip hidden files (Unix-style) — always
    if (path.startsWith(".")) return true;
    // Skip plugin's own data
    if (path === "data.json") return true;

    // Check user-configured exclude patterns
    for (const pattern of this.plugin.settings.excludePatterns) {
      if (this.matchesPattern(path, pattern)) return true;
    }

    return false;
  }

  /**
   * Simple glob-style pattern matching.
   * Supports: * (any chars except /), ** (any chars including /),
   * trailing / (matches directory prefix).
   */
  private matchesPattern(path: string, pattern: string): boolean {
    // Trailing slash matches any path starting with the pattern prefix
    if (pattern.endsWith("/")) {
      return path.startsWith(pattern) || path.startsWith(pattern.slice(0, -1));
    }

    // Exact match
    if (path === pattern) return true;

    // Convert glob to regex
    let regex = "^";
    for (let i = 0; i < pattern.length; i++) {
      const ch = pattern[i];
      if (ch === "*" && pattern[i + 1] === "*") {
        regex += ".*";
        i++; // Skip second *
        if (pattern[i + 1] === "/") i++; // Skip trailing / after **
      } else if (ch === "*") {
        regex += "[^/]*";
      } else if (ch === "?" || ch === "." || ch === "(" || ch === ")" || ch === "[" || ch === "]" || ch === "{" || ch === "}" || ch === "+" || ch === "^" || ch === "$" || ch === "|" || ch === "\\") {
        regex += "\\" + ch;
      } else {
        regex += ch;
      }
    }
    regex += "$";

    try {
      return new RegExp(regex).test(path);
    } catch {
      return false;
    }
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
            `CloudSync: Upload attempt ${attempt} failed for ${path} — retrying in ${delay / 1000}s`
          );
          await new Promise((r) => setTimeout(r, delay));
        }
      }
    }
    throw lastError;
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
    } else if (this.plugin.settings.encryptionPassphrase) {
      // Case 2: first device to set up encryption — push our salt.
      if (!this.plugin.settings.encryptionSalt) {
        this.plugin.settings.encryptionSalt = this.plugin.crypto.generateSalt();
        await this.plugin.saveSettings();
      }
      try {
        await this.plugin.api.pushEncryptionSalt(this.plugin.settings.encryptionSalt);
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
