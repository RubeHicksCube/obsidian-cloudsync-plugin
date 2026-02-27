import { Notice, Plugin, TFile, debounce } from "obsidian";
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
      3_000,
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
    this.statusBar.destroy();
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
    const newSalt = this.crypto.generateSalt();

    this.settings.encryptionPassphrase = newPassphrase;
    this.settings.encryptionSalt = newSalt;
    this.crypto.clearCache();
    this.settings.lastSyncTime = 0;
    await this.saveSettings();

    await this.api.pushEncryptionSalt(newSalt, true);

    // Push the re-encrypted vault key so other devices pick up the new passphrase.
    await this.pushVaultKey();

    // Force re-upload every locally-present file with the new encryption key.
    // This bypasses the delta hash-comparison which would otherwise skip
    // unchanged files (same plaintext hash → "no action") and leave their
    // server-side blobs encrypted with the old key.
    await this.syncEngine.reEncryptLocal();

    // Normal bidirectional sync to pull any server-side files we don't have locally.
    // Note: files that only exist on the server and were uploaded by another device
    // with the old key will still fail to decrypt until that device re-pushes them.
    await this.syncNow();
  }

  /**
   * Encrypt the current vault passphrase with a key derived from the account
   * credentials and store it on the server. Called after passphrase setup or
   * change so any device that logs in can auto-configure encryption.
   *
   * Security: the server stores an opaque AES-256-GCM ciphertext. It cannot
   * decrypt it without knowing the account password (used for PBKDF2 client-side).
   */
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

  /**
   * Fetch the vault list and auto-select the first vault if none is configured.
   * Called after login and register so the vault dropdown is pre-populated.
   */
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

  /**
   * Decrypt the vault key from a login/refresh response and apply it.
   * Always called on login — if the server has a vault key, this device
   * adopts the account passphrase so encrypted files are readable immediately.
   * Called after every successful login or token refresh.
   */
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
