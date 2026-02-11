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
