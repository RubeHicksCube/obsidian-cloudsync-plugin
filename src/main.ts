import { Notice, Plugin, TFile, debounce, requestUrl } from "obsidian";
import type { AuthResponse } from "./api";
import { CloudSyncAPI } from "./api";
import { CryptoEngine, deriveAccountKey, encryptVaultKey, decryptVaultKey } from "./crypto";
import {
  CloudSyncSettings,
  CloudSyncSettingTab,
  DEFAULT_SETTINGS,
} from "./settings";
import { StatusBar } from "./status";
import { SyncEngine } from "./sync";
import { WebSocketClient } from "./ws";

const GITHUB_REPO = "RubeHicksCube/obsidian-cloudsync-plugin";
const GITHUB_API  = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;

export default class CloudSyncPlugin extends Plugin {
  settings!: CloudSyncSettings;
  api!: CloudSyncAPI;
  crypto!: CryptoEngine;
  syncEngine!: SyncEngine;
  statusBar!: StatusBar;
  wsClient!: WebSocketClient;

  private autoSyncTimer: ReturnType<typeof setInterval> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  /** Epoch ms of the last keydown event — used to gate downloads during active editing. */
  lastInputTime = 0;

  /**
   * Returns true if the user has pressed a key within the last 15 seconds.
   * Used by the sync engine to decide whether to defer downloads for open files.
   */
  isUserTyping(): boolean {
    return Date.now() - this.lastInputTime < 15_000;
  }

  /**
   * Debounced sync triggered by vault file-change events.
   * Fires 3 s after the last modification. Always treated as auto (not forced)
   * so typing protection applies.
   */
  private debouncedSync: ReturnType<typeof debounce>;

  constructor(app: import("obsidian").App, manifest: import("obsidian").PluginManifest) {
    super(app, manifest);
    this.debouncedSync = debounce(
      () => {
        if (this.api.isLoggedIn() && !this.syncEngine.isSyncing) {
          this.syncAuto();
        }
      },
      3_000,
      true
    );
  }

  async onload(): Promise<void> {
    console.log("CloudSync: Loading plugin");

    await this.loadSettings();

    this.api = new CloudSyncAPI(this);
    this.crypto = new CryptoEngine();
    this.syncEngine = new SyncEngine(this);
    this.wsClient = new WebSocketClient(this);

    const statusBarEl = this.addStatusBarItem();
    this.statusBar = new StatusBar(this, statusBarEl);

    this.addSettingTab(new CloudSyncSettingTab(this.app, this));

    this.addRibbonIcon("refresh-cw", "CloudSync: Sync now", async () => {
      await this.syncNow();
    });

    this.addCommand({
      id: "cloudsync-sync-now",
      name: "Sync now (bidirectional)",
      callback: async () => { await this.syncNow(); },
    });

    this.addCommand({
      id: "cloudsync-push-now",
      name: "Push now (upload local changes to server)",
      callback: async () => { await this.pushNow(); },
    });

    this.addCommand({
      id: "cloudsync-pull-now",
      name: "Pull now (download server changes to local)",
      callback: async () => { await this.pullNow(); },
    });

    this.addCommand({
      id: "cloudsync-view-status",
      name: "View sync status",
      callback: () => { this.showSyncStatus(); },
    });

    // Track the last keypress so the sync engine can detect active editing.
    // When typing protection is on, downloads for open files are deferred
    // until the user has been idle for 15 seconds.
    this.registerDomEvent(document, "keydown", () => {
      this.lastInputTime = Date.now();

      // Restart the idle timer — fires a background sync 15 s after the last
      // keystroke to flush any downloads that were deferred during editing.
      if (this.idleTimer) clearTimeout(this.idleTimer);
      if (this.api.isLoggedIn() && this.settings.autoSyncInterval !== 0) {
        this.idleTimer = setTimeout(() => {
          this.idleTimer = null;
          if (!this.syncEngine.isSyncing) {
            this.syncAuto();
          }
        }, 15_000);
      }
    });

    // Watch for file changes — mark sync engine dirty and trigger debounced sync.
    // Ignore events while syncing so downloads don't trigger another sync cycle.
    const onVaultChange = (file: import("obsidian").TAbstractFile) => {
      if (
        file instanceof TFile &&
        !file.path.startsWith(".obsidian/") &&
        !this.syncEngine.isSyncing
      ) {
        this.syncEngine.markDirty();
        if (this.settings.autoSyncInterval !== 0) {
          this.debouncedSync();
        }
      }
    };
    this.registerEvent(this.app.vault.on("modify", onVaultChange));
    this.registerEvent(this.app.vault.on("create", onVaultChange));
    this.registerEvent(this.app.vault.on("delete", onVaultChange));
    this.registerEvent(this.app.vault.on("rename", onVaultChange));

    this.restartAutoSync();

    if (this.api.isLoggedIn()) {
      // Initial sync after vault loads, then connect WS so it can't race
      // with the first sync cycle and deliver a stale cursor position.
      setTimeout(async () => {
        await this.syncNow();
        this.wsClient.connect();
      }, 5_000);

      // Check for plugin updates in the background (non-blocking).
      if (this.settings.autoUpdate) {
        setTimeout(() => this.checkForUpdates(false), 10_000);
      }
    }
  }

  async onunload(): Promise<void> {
    console.log("CloudSync: Unloading plugin");
    this.stopAutoSync();
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    this.statusBar.destroy();
    this.wsClient.disconnect();
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  // ── Sync entry points ────────────────────────────────────────────────────

  /**
   * User-initiated bidirectional sync. Bypasses typing protection so the user
   * always gets the full result when they explicitly ask for a sync.
   */
  async syncNow(): Promise<void> {
    await this.syncEngine.sync(false, 'bidirectional', true);
  }

  /**
   * Background auto-sync — respects typing protection. Downloads for files
   * currently open in an editor are deferred until the user goes idle.
   */
  async syncAuto(): Promise<void> {
    await this.syncEngine.sync(true, 'bidirectional', false);
  }

  /** User-initiated push: upload local → server. Always forced. */
  async pushNow(): Promise<void> {
    await this.syncEngine.sync(false, 'push', true);
  }

  /** User-initiated pull: download server → local. Always forced. */
  async pullNow(): Promise<void> {
    await this.syncEngine.sync(false, 'pull', true);
  }

  // ── Auto-sync timer ───────────────────────────────────────────────────────

  restartAutoSync(): void {
    this.stopAutoSync();

    if (this.settings.autoSyncInterval > 0) {
      const intervalMs = this.settings.autoSyncInterval * 60 * 1000;
      this.autoSyncTimer = setInterval(async () => {
        if (
          this.api.isLoggedIn() &&
          !this.syncEngine.isSyncing &&
          this.syncEngine.isDirty
        ) {
          await this.syncAuto();
        }
      }, intervalMs);
    }
  }

  private stopAutoSync(): void {
    if (this.autoSyncTimer !== null) {
      clearInterval(this.autoSyncTimer);
      this.autoSyncTimer = null;
    }
  }

  // ── Status display ────────────────────────────────────────────────────────

  private showSyncStatus(): void {
    const s = this.settings;
    const lines: string[] = [];

    if (this.api.isLoggedIn()) {
      lines.push(`Logged in as: ${s.username}`);
      lines.push(`Device ID: ${s.deviceId.substring(0, 8)}...`);
    } else {
      lines.push("Not logged in");
    }

    if (s.lastSyncTime > 0) {
      lines.push(`Last sync: ${new Date(s.lastSyncTime).toLocaleString()}`);
    } else {
      lines.push("Never synced");
    }

    const syncMode =
      s.autoSyncInterval === -1 ? "only on change" :
      s.autoSyncInterval === 0  ? "disabled" :
      `every ${s.autoSyncInterval} min`;
    lines.push(`Auto-sync: ${syncMode}`);
    lines.push(`Encryption: ${s.encryptionPassphrase ? "enabled" : "disabled"}`);
    lines.push(`Typing protection: ${s.typingProtection ? "on" : "off"}`);

    if (this.syncEngine.isSyncing) {
      lines.push("Status: Syncing...");
    } else if (this.isUserTyping()) {
      lines.push("Status: Typing (downloads deferred)");
    } else {
      lines.push("Status: Idle");
    }

    new Notice(lines.join("\n"), 10_000);
  }

  // ── Auto-updater ──────────────────────────────────────────────────────────

  /**
   * Check GitHub releases for a newer plugin version.
   * @param userInitiated When true (from the settings button), shows a notice
   *   even when already up to date.
   */
  async checkForUpdates(userInitiated: boolean): Promise<void> {
    try {
      const resp = await requestUrl({
        url: GITHUB_API,
        method: "GET",
        headers: {
          "Accept": "application/vnd.github.v3+json",
          "User-Agent": "ObsidianCloudSync",
        },
        throw: false,
      });

      if (resp.status !== 200) {
        if (userInitiated) new Notice("CloudSync: Could not reach GitHub to check for updates.");
        return;
      }

      const release = resp.json as {
        tag_name: string;
        assets: Array<{ name: string; browser_download_url: string }>;
      };

      const latestRaw = release.tag_name ?? "";
      const latest = latestRaw.replace(/^v/, "");
      const current = this.manifest.version;

      if (!this.isNewerVersion(latest, current)) {
        if (userInitiated) {
          new Notice(`CloudSync: Up to date (v${current})`);
        }
        return;
      }

      const mainJsAsset = release.assets?.find((a) => a.name === "main.js");
      const manifestAsset = release.assets?.find((a) => a.name === "manifest.json");

      if (!mainJsAsset) {
        if (userInitiated) new Notice("CloudSync: Update found but release has no main.js asset.");
        return;
      }

      // Show a persistent notice with an install button.
      const frag = new DocumentFragment();
      const wrapper = frag.createEl("div");
      wrapper.createEl("strong", { text: `CloudSync v${latest} available` });
      wrapper.createEl("span", { text: ` (current: v${current})  ` });
      const installBtn = wrapper.createEl("button", { text: "Install & Reload" });
      installBtn.style.marginLeft = "6px";

      const notice = new Notice(frag, 0); // persistent until dismissed or installed
      installBtn.onclick = async () => {
        notice.hide();
        await this.installUpdate(
          mainJsAsset.browser_download_url,
          manifestAsset?.browser_download_url ?? null,
          latest
        );
      };
    } catch (e: unknown) {
      if (userInitiated) {
        const msg = e instanceof Error ? e.message : String(e);
        new Notice(`CloudSync: Update check failed — ${msg}`);
      }
    }
  }

  /**
   * Download and install a new plugin version, then reload.
   */
  private async installUpdate(
    mainJsUrl: string,
    manifestUrl: string | null,
    version: string
  ): Promise<void> {
    try {
      new Notice("CloudSync: Downloading update…");

      const pluginDir = `${this.app.vault.configDir}/plugins/${this.manifest.id}`;

      // Download main.js
      const mainResp = await requestUrl({ url: mainJsUrl, method: "GET", throw: false });
      if (mainResp.status !== 200) throw new Error(`Download failed: HTTP ${mainResp.status}`);
      await this.app.vault.adapter.writeBinary(`${pluginDir}/main.js`, mainResp.arrayBuffer);

      // Download manifest.json if available (updates the version Obsidian sees)
      if (manifestUrl) {
        const mfResp = await requestUrl({ url: manifestUrl, method: "GET", throw: false });
        if (mfResp.status === 200) {
          await this.app.vault.adapter.write(`${pluginDir}/manifest.json`, mfResp.text);
        }
      }

      new Notice(`CloudSync: v${version} installed. Reloading plugin…`);

      // Reload the plugin in-place without requiring Obsidian restart.
      // @ts-ignore — internal API, stable across Obsidian releases
      const plugins = this.app.plugins;
      await plugins.disablePlugin(this.manifest.id);
      await plugins.enablePlugin(this.manifest.id);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      new Notice(`CloudSync: Update install failed — ${msg}`);
    }
  }

  /**
   * Returns true if version string `a` is strictly greater than `b`.
   * Compares major.minor.patch numerically.
   */
  private isNewerVersion(a: string, b: string): boolean {
    const pa = a.split(".").map(Number);
    const pb = b.split(".").map(Number);
    for (let i = 0; i < 3; i++) {
      const va = pa[i] ?? 0;
      const vb = pb[i] ?? 0;
      if (va > vb) return true;
      if (va < vb) return false;
    }
    return false;
  }

  // ── Key management ────────────────────────────────────────────────────────

  async changePassphrase(newPassphrase: string): Promise<void> {
    const newSalt = this.crypto.generateSalt();

    this.settings.encryptionPassphrase = newPassphrase;
    this.settings.encryptionSalt = newSalt;
    this.crypto.clearCache();
    this.settings.lastSyncTime = 0;
    await this.saveSettings();

    await this.api.pushEncryptionSalt(newSalt, true);
    await this.pushVaultKey();
    await this.syncEngine.reEncryptLocal();
    await this.syncNow();
  }

  async pushVaultKey(): Promise<void> {
    const { encryptionPassphrase, password, username } = this.settings;
    if (!encryptionPassphrase || !password || !username) return;
    try {
      const accountKey = await deriveAccountKey(password, username);
      const ciphertext = await encryptVaultKey(encryptionPassphrase, accountKey);
      await this.api.setVaultKey(ciphertext);
    } catch (e) {
      console.warn("CloudSync: Could not push vault key:", e);
    }
  }

  async autoSelectVault(): Promise<void> {
    try {
      const vaults = await this.api.listVaults();
      if (vaults.length > 0 && !this.settings.vaultId) {
        this.settings.vaultId = vaults[0].id;
        this.settings.vaultName = vaults[0].name;
        await this.saveSettings();
      }
    } catch (e) {
      console.warn("CloudSync: Could not fetch vault list:", e);
    }
  }

  async handleVaultKeyFromAuth(authResp: AuthResponse): Promise<void> {
    if (!authResp.encrypted_vault_key) return;
    const { password, username } = this.settings;
    if (!password || !username) return;
    try {
      const accountKey = await deriveAccountKey(password, username);
      const passphrase = await decryptVaultKey(authResp.encrypted_vault_key, accountKey);
      if (passphrase !== this.settings.encryptionPassphrase) {
        this.settings.encryptionPassphrase = passphrase;
        await this.saveSettings();
        new Notice("CloudSync: Encryption passphrase synced from account — encrypted files are now readable.");
      }
    } catch (e) {
      console.warn("CloudSync: Could not decrypt vault key:", e);
      new Notice("CloudSync: Could not load encryption key from account. Check your password is saved correctly in settings.");
    }
  }
}
