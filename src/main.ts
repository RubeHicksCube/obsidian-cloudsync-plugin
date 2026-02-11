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

export default class CloudSyncPlugin extends Plugin {
  settings!: CloudSyncSettings;
  api!: CloudSyncAPI;
  crypto!: CryptoEngine;
  syncEngine!: SyncEngine;
  statusBar!: StatusBar;

  private autoSyncTimer: ReturnType<typeof setInterval> | null = null;
  private debouncedSync: ReturnType<typeof debounce>;
  private fileChangeRef: ReturnType<typeof this.app.vault.on> | null = null;

  constructor(app: import("obsidian").App, manifest: import("obsidian").PluginManifest) {
    super(app, manifest);
    // Debounce file-change sync: wait 30 seconds after the last change
    this.debouncedSync = debounce(
      () => {
        if (this.api.isLoggedIn() && !this.syncEngine.isSyncing) {
          this.syncNow();
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

    // Initialize encryption salt if passphrase is set but no salt exists
    if (this.settings.encryptionPassphrase && !this.settings.encryptionSalt) {
      this.settings.encryptionSalt = this.crypto.generateSalt();
      await this.saveSettings();
    }

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
      name: "Sync now",
      callback: async () => {
        await this.syncNow();
      },
    });

    this.addCommand({
      id: "cloudsync-view-status",
      name: "View sync status",
      callback: () => {
        this.showSyncStatus();
      },
    });

    // Watch for file changes (debounced auto-sync trigger)
    this.fileChangeRef = this.app.vault.on("modify", (file) => {
      if (
        file instanceof TFile &&
        !file.path.startsWith(".obsidian/") &&
        this.settings.autoSyncInterval > 0
      ) {
        this.debouncedSync();
      }
    });
    this.registerEvent(this.fileChangeRef);

    // Start auto-sync timer
    this.restartAutoSync();

    // Run initial sync after a short delay to let the vault load
    if (this.api.isLoggedIn()) {
      setTimeout(() => {
        this.syncNow();
      }, 5_000);
    }
  }

  async onunload(): Promise<void> {
    console.log("CloudSync: Unloading plugin");
    this.stopAutoSync();
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  /**
   * Trigger a sync cycle.
   */
  async syncNow(): Promise<void> {
    // Ensure salt is generated if passphrase is set
    if (this.settings.encryptionPassphrase && !this.settings.encryptionSalt) {
      this.settings.encryptionSalt = this.crypto.generateSalt();
      await this.saveSettings();
    }

    await this.syncEngine.sync();
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

    lines.push(
      `Auto-sync: ${s.autoSyncInterval > 0 ? `every ${s.autoSyncInterval} min` : "disabled"}`
    );
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
        if (this.api.isLoggedIn() && !this.syncEngine.isSyncing) {
          await this.syncNow();
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
}
