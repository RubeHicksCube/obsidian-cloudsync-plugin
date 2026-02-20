import { Notice, Plugin, TFile, debounce } from "obsidian";
import { CloudSyncAPI } from "./api";
import { CryptoEngine } from "./crypto";
import {
  CloudSyncSettings,
  CloudSyncSettingTab,
  DEFAULT_SETTINGS,
} from "./settings";
import { StatusBar } from "./status";
import { SyncEngine } from "./sync";
import { WebSocketClient } from "./ws";

export default class CloudSyncPlugin extends Plugin {
  settings!: CloudSyncSettings;
  api!: CloudSyncAPI;
  crypto!: CryptoEngine;
  syncEngine!: SyncEngine;
  statusBar!: StatusBar;
  wsClient!: WebSocketClient;

  private autoSyncTimer: ReturnType<typeof setInterval> | null = null;
  private debouncedSync: ReturnType<typeof debounce>;

  constructor(app: import("obsidian").App, manifest: import("obsidian").PluginManifest) {
    super(app, manifest);
    // Debounce file-change sync: wait 30 seconds after the last change
    this.debouncedSync = debounce(
      () => {
        if (this.api.isLoggedIn() && !this.syncEngine.isSyncing) {
          this.syncEngine.sync(true);
        }
      },
      30_000,
      true
    );
  }

  async onload(): Promise<void> {
    console.log("CloudSync: Loading plugin");

    // Load settings
    await this.loadSettings();

    // Initialize components
    this.api = new CloudSyncAPI(this);
    this.crypto = new CryptoEngine();
    this.syncEngine = new SyncEngine(this);
    this.wsClient = new WebSocketClient(this);

    // Status bar
    const statusBarEl = this.addStatusBarItem();
    this.statusBar = new StatusBar(this, statusBarEl);

    // Settings tab
    this.addSettingTab(new CloudSyncSettingTab(this.app, this));

    // Ribbon icon for manual sync
    this.addRibbonIcon("refresh-cw", "CloudSync: Sync now", async () => {
      await this.syncNow();
    });

    // Commands
    this.addCommand({
      id: "cloudsync-sync-now",
      name: "Sync now (bidirectional)",
      callback: async () => {
        await this.syncNow();
      },
    });

    this.addCommand({
      id: "cloudsync-push-now",
      name: "Push now (upload local changes to server)",
      callback: async () => {
        await this.pushNow();
      },
    });

    this.addCommand({
      id: "cloudsync-pull-now",
      name: "Pull now (download server changes to local)",
      callback: async () => {
        await this.pullNow();
      },
    });

    this.addCommand({
      id: "cloudsync-view-status",
      name: "View sync status",
      callback: () => {
        this.showSyncStatus();
      },
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
        // Trigger debounced sync for both interval mode (>0) and only-on-change (-1)
        if (this.settings.autoSyncInterval !== 0) {
          this.debouncedSync();
        }
      }
    };
    this.registerEvent(this.app.vault.on("modify", onVaultChange));
    this.registerEvent(this.app.vault.on("create", onVaultChange));
    this.registerEvent(this.app.vault.on("delete", onVaultChange));
    this.registerEvent(this.app.vault.on("rename", onVaultChange));

    // Start auto-sync timer
    this.restartAutoSync();

    // Run initial sync after a short delay to let the vault load
    if (this.api.isLoggedIn()) {
      setTimeout(() => {
        this.syncNow();
      }, 5_000);

      // Connect WebSocket for real-time sync
      this.wsClient.connect();
    }
  }

  async onunload(): Promise<void> {
    console.log("CloudSync: Unloading plugin");
    this.stopAutoSync();
    this.wsClient.disconnect();
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  /**
   * Trigger a bidirectional sync cycle.
   */
  async syncNow(): Promise<void> {
    await this.syncEngine.sync();
  }

  /** Upload local changes to the server only. Conflicts resolve local-wins. */
  async pushNow(): Promise<void> {
    await this.syncEngine.sync(false, 'push');
  }

  /** Download server changes to local only. Conflicts resolve server-wins. */
  async pullNow(): Promise<void> {
    await this.syncEngine.sync(false, 'pull');
  }

  /**
   * Show a notice with the current sync status.
   */
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
    lines.push(
      `Encryption: ${s.encryptionPassphrase ? "enabled" : "disabled"}`
    );

    if (this.syncEngine.isSyncing) {
      lines.push("Status: Syncing...");
    } else {
      lines.push("Status: Idle");
    }

    new Notice(lines.join("\n"), 10_000);
  }

  /**
   * Restart the auto-sync interval timer.
   */
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
          await this.syncEngine.sync(true);
        }
      }, intervalMs);
    }
  }

  /**
   * Stop the auto-sync interval timer.
   */
  private stopAutoSync(): void {
    if (this.autoSyncTimer !== null) {
      clearInterval(this.autoSyncTimer);
      this.autoSyncTimer = null;
    }
  }

  /**
   * Change the encryption passphrase.
   * Generates a new salt, clears the key cache, and triggers a full re-upload
   * so all files on the server are re-encrypted with the new key.
   */
  async changePassphrase(newPassphrase: string): Promise<void> {
    // Generate a new salt for the new passphrase
    const newSalt = this.crypto.generateSalt();

    // Update settings and clear the cached key
    this.settings.encryptionPassphrase = newPassphrase;
    this.settings.encryptionSalt = newSalt;
    this.crypto.clearCache();
    // Reset lastSyncTime so all files are treated as needing re-upload
    this.settings.lastSyncTime = 0;
    await this.saveSettings();

    // Push the new salt to the server with force=true so all other devices
    // adopt it on their next sync and can decrypt the re-encrypted files.
    await this.api.pushEncryptionSalt(newSalt, true);

    // Re-upload all files encrypted with the new passphrase+salt
    await this.syncNow();
  }
}
