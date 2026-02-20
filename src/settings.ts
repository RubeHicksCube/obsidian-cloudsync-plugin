import { App, PluginSettingTab, Setting, Notice } from "obsidian";
import type CloudSyncPlugin from "./main";

export interface CloudSyncSettings {
  serverUrl: string;
  username: string;
  password: string;
  autoSyncInterval: number; // minutes, 0 = disabled
  encryptionPassphrase: string;
  // Stored after login (not user-editable)
  accessToken: string;
  refreshToken: string;
  userId: string;
  deviceId: string;
  // Encryption salt (generated once, hex-encoded)
  encryptionSalt: string;
  // Last sync timestamp
  lastSyncTime: number;
  // Selective sync: glob patterns to exclude
  excludePatterns: string[];
  // Paths present in the vault after the last successful sync.
  // Used to detect locally deleted files between syncs.
  lastSyncedPaths: string[];
}

export const DEFAULT_SETTINGS: CloudSyncSettings = {
  serverUrl: "http://localhost:3000",
  username: "",
  password: "",
  autoSyncInterval: 5,
  encryptionPassphrase: "",
  accessToken: "",
  refreshToken: "",
  userId: "",
  deviceId: "",
  encryptionSalt: "",
  lastSyncTime: 0,
  excludePatterns: [
    ".obsidian/workspace.json",
    ".obsidian/workspace-mobile.json",
    ".trash/",
  ],
  lastSyncedPaths: [],
};

export class CloudSyncSettingTab extends PluginSettingTab {
  plugin: CloudSyncPlugin;

  constructor(app: App, plugin: CloudSyncPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass("cloudsync-settings");

    containerEl.createEl("h2", { text: "CloudSync Settings" });

    // Connection status
    const isLoggedIn = !!this.plugin.settings.accessToken;
    const statusEl = containerEl.createDiv({
      cls: `connection-status ${isLoggedIn ? "connected" : "disconnected"}`,
    });
    statusEl.setText(
      isLoggedIn
        ? `Connected as ${this.plugin.settings.username} (Device: ${this.plugin.settings.deviceId.substring(0, 8)}...)`
        : "Not connected"
    );

    // Server configuration
    containerEl.createEl("h3", { text: "Server" });

    new Setting(containerEl)
      .setName("Server URL")
      .setDesc("The URL of your ObsidianCloudSync server")
      .addText((text) =>
        text
          .setPlaceholder("http://localhost:3000")
          .setValue(this.plugin.settings.serverUrl)
          .onChange(async (value) => {
            this.plugin.settings.serverUrl = value.replace(/\/+$/, "");
            await this.plugin.saveSettings();
          })
      );

    // Authentication
    containerEl.createEl("h3", { text: "Authentication" });

    new Setting(containerEl)
      .setName("Username")
      .setDesc("Your account username")
      .addText((text) =>
        text
          .setPlaceholder("username")
          .setValue(this.plugin.settings.username)
          .onChange(async (value) => {
            this.plugin.settings.username = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Password")
      .setDesc("Your account password")
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setPlaceholder("password")
          .setValue(this.plugin.settings.password)
          .onChange(async (value) => {
            this.plugin.settings.password = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Login")
      .setDesc("Log in to the CloudSync server")
      .addButton((btn) =>
        btn.setButtonText("Login").onClick(async () => {
          try {
            await this.plugin.api.login();
            new Notice("CloudSync: Logged in successfully");
            this.display();
          } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            new Notice(`CloudSync: Login failed - ${msg}`);
          }
        })
      )
      .addButton((btn) =>
        btn.setButtonText("Register").onClick(async () => {
          try {
            await this.plugin.api.register();
            new Notice("CloudSync: Registered and logged in");
            this.display();
          } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            new Notice(`CloudSync: Registration failed - ${msg}`);
          }
        })
      );

    if (isLoggedIn) {
      new Setting(containerEl)
        .setName("Logout")
        .setDesc("Log out and clear stored tokens")
        .addButton((btn) =>
          btn
            .setButtonText("Logout")
            .setWarning()
            .onClick(async () => {
              try {
                await this.plugin.api.logout();
              } catch {
                // Ignore logout errors
              }
              this.plugin.settings.accessToken = "";
              this.plugin.settings.refreshToken = "";
              this.plugin.settings.userId = "";
              this.plugin.settings.deviceId = "";
              await this.plugin.saveSettings();
              this.plugin.wsClient?.disconnect();
              new Notice("CloudSync: Logged out");
              this.display();
            })
        );
    }

    // Encryption
    containerEl.createEl("h3", { text: "Encryption" });

    new Setting(containerEl)
      .setName("Encryption passphrase")
      .setDesc(
        "Files are encrypted client-side with AES-256-GCM before uploading. " +
          "Leave empty to disable encryption. " +
          "WARNING: If you lose this passphrase, your data cannot be recovered."
      )
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setPlaceholder("encryption passphrase")
          .setValue(this.plugin.settings.encryptionPassphrase)
          .onChange(async (value) => {
            this.plugin.settings.encryptionPassphrase = value;
            await this.plugin.saveSettings();
          });
      });

    if (this.plugin.settings.encryptionPassphrase && isLoggedIn) {
      new Setting(containerEl)
        .setName("Change passphrase")
        .setDesc(
          "Re-encrypts all vault files with a new passphrase, then triggers a full re-upload. " +
            "This will take time proportional to your vault size."
        )
        .addButton((btn) =>
          btn
            .setButtonText("Change Passphrase")
            .setWarning()
            .onClick(async () => {
              const newPassphrase = prompt(
                "Enter new encryption passphrase:"
              );
              if (!newPassphrase) return;
              const confirm = prompt(
                "Confirm new passphrase (type it again):"
              );
              if (newPassphrase !== confirm) {
                new Notice("CloudSync: Passphrases do not match");
                return;
              }
              try {
                await this.plugin.changePassphrase(newPassphrase);
                new Notice(
                  "CloudSync: Passphrase changed. Full re-upload will begin."
                );
                this.display();
              } catch (e: unknown) {
                const msg = e instanceof Error ? e.message : String(e);
                new Notice(`CloudSync: Passphrase change failed - ${msg}`);
              }
            })
        );
    }

    // Sync options
    containerEl.createEl("h3", { text: "Sync" });

    new Setting(containerEl)
      .setName("Auto-sync interval")
      .setDesc(
        "How often to automatically sync (in minutes). Set to 0 to disable auto-sync."
      )
      .addText((text) =>
        text
          .setPlaceholder("5")
          .setValue(String(this.plugin.settings.autoSyncInterval))
          .onChange(async (value) => {
            const num = parseInt(value, 10);
            if (!isNaN(num) && num >= 0) {
              this.plugin.settings.autoSyncInterval = num;
              await this.plugin.saveSettings();
              this.plugin.restartAutoSync();
            }
          })
      );

    // Selective sync
    new Setting(containerEl)
      .setName("Exclude patterns")
      .setDesc(
        "File paths to exclude from sync (one per line). Supports simple glob patterns: " +
          "use * for wildcard, end with / to match folders."
      )
      .addTextArea((text) => {
        text.inputEl.rows = 5;
        text.inputEl.cols = 40;
        text
          .setPlaceholder(
            ".obsidian/workspace.json\n.obsidian/workspace-mobile.json\n.trash/"
          )
          .setValue(this.plugin.settings.excludePatterns.join("\n"))
          .onChange(async (value) => {
            this.plugin.settings.excludePatterns = value
              .split("\n")
              .map((s) => s.trim())
              .filter((s) => s.length > 0);
            await this.plugin.saveSettings();
          });
      });

    // Last sync info
    if (this.plugin.settings.lastSyncTime > 0) {
      const lastSync = new Date(
        this.plugin.settings.lastSyncTime
      ).toLocaleString();
      new Setting(containerEl)
        .setName("Last sync")
        .setDesc(lastSync)
        .addButton((btn) =>
          btn.setButtonText("Sync now").onClick(async () => {
            await this.plugin.syncNow();
          })
        );
    }
  }
}
