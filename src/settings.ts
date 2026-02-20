import { App, PluginSettingTab, Setting, Notice, AbstractInputSuggest, TFolder } from "obsidian";
import type CloudSyncPlugin from "./main";

// ── Vault path suggest ────────────────────────────────────────────────────────

class FileFolderSuggest extends AbstractInputSuggest<string> {
  private plugin: CloudSyncPlugin;
  private onSelect: (path: string) => void;

  constructor(
    app: App,
    inputEl: HTMLInputElement,
    plugin: CloudSyncPlugin,
    onSelect: (path: string) => void
  ) {
    super(app, inputEl);
    this.plugin = plugin;
    this.onSelect = onSelect;
  }

  getSuggestions(query: string): string[] {
    if (!query.trim()) return [];
    const lower = query.toLowerCase();
    const existing = new Set(this.plugin.settings.excludePatterns);
    const results: string[] = [];
    for (const file of this.plugin.app.vault.getAllLoadedFiles()) {
      const path = file instanceof TFolder ? file.path + "/" : file.path;
      if (path.toLowerCase().includes(lower) && !existing.has(path)) {
        results.push(path);
        if (results.length >= 20) break;
      }
    }
    return results;
  }

  renderSuggestion(path: string, el: HTMLElement): void {
    el.setText(path);
  }

  selectSuggestion(path: string, _evt: MouseEvent | KeyboardEvent): void {
    this.onSelect(path);
    this.setValue("");
    this.close();
  }
}

// ── Settings interface ────────────────────────────────────────────────────────

export interface CloudSyncSettings {
  serverUrl: string;
  username: string;
  password: string;
  /** -1 = only on change (debounced), 0 = disabled, >0 = interval in minutes */
  autoSyncInterval: number;
  encryptionPassphrase: string;
  // Stored after login (not user-editable)
  accessToken: string;
  refreshToken: string;
  userId: string;
  deviceId: string;
  // Account-wide encryption salt (adopted from server, hex-encoded)
  encryptionSalt: string;
  lastSyncTime: number;
  excludePatterns: string[];
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
  excludePatterns: [],
  lastSyncedPaths: [],
};

// ── Settings tab ──────────────────────────────────────────────────────────────

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

    // Connection status banner
    const isLoggedIn = !!this.plugin.settings.accessToken;
    const statusEl = containerEl.createDiv({
      cls: `connection-status ${isLoggedIn ? "connected" : "disconnected"}`,
    });
    statusEl.setText(
      isLoggedIn
        ? `Connected as ${this.plugin.settings.username} (Device: ${this.plugin.settings.deviceId.substring(0, 8)}...)`
        : "Not connected"
    );

    // ── Server ──────────────────────────────────────────────────────────────
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

    // ── Authentication ───────────────────────────────────────────────────────
    containerEl.createEl("h3", { text: "Authentication" });

    new Setting(containerEl)
      .setName("Username")
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
      .setName("Account")
      .addButton((btn) =>
        btn.setButtonText("Login").onClick(async () => {
          try {
            await this.plugin.api.login();
            new Notice("CloudSync: Logged in successfully");
            this.display();
          } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            new Notice(`CloudSync: Login failed — ${msg}`);
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
            new Notice(`CloudSync: Registration failed — ${msg}`);
          }
        })
      );

    if (isLoggedIn) {
      new Setting(containerEl)
        .setName("Session")
        .setDesc("Clears stored tokens from this device")
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

    // ── Encryption ───────────────────────────────────────────────────────────
    containerEl.createEl("h3", { text: "Encryption" });

    const encryptionActive = !!this.plugin.settings.encryptionSalt;

    if (encryptionActive) {
      // Locked — show status and change option only
      new Setting(containerEl)
        .setName("Encryption")
        .setDesc("Active — files are encrypted with AES-256-GCM before leaving this device. All synced devices use the same key.")
        .addButton((btn) =>
          btn
            .setButtonText("Change Passphrase")
            .setWarning()
            .onClick(async () => {
              const newPassphrase = prompt("Enter new encryption passphrase:");
              if (!newPassphrase) return;
              const confirm = prompt("Confirm new passphrase:");
              if (newPassphrase !== confirm) {
                new Notice("CloudSync: Passphrases do not match");
                return;
              }
              try {
                await this.plugin.changePassphrase(newPassphrase);
                new Notice("CloudSync: Passphrase changed. Re-uploading all files…");
                this.display();
              } catch (e: unknown) {
                const msg = e instanceof Error ? e.message : String(e);
                new Notice(`CloudSync: Passphrase change failed — ${msg}`);
              }
            })
        );
    } else {
      // Not yet active — allow setting a passphrase
      const pendingNote = this.plugin.settings.encryptionPassphrase
        ? " Passphrase is set and will activate on the next sync."
        : "";
      new Setting(containerEl)
        .setName("Encryption passphrase")
        .setDesc(
          "Encrypt all files client-side before uploading. Leave empty to sync without encryption. " +
          "All devices must use the same passphrase." +
          pendingNote
        )
        .addText((text) => {
          text.inputEl.type = "password";
          text
            .setPlaceholder("Enter a passphrase…")
            .setValue(this.plugin.settings.encryptionPassphrase)
            .onChange(async (value) => {
              this.plugin.settings.encryptionPassphrase = value;
              await this.plugin.saveSettings();
            });
        });
    }

    // ── Sync ────────────────────────────────────────────────────────────────
    containerEl.createEl("h3", { text: "Sync" });

    new Setting(containerEl)
      .setName("Auto-sync")
      .setDesc("When to automatically sync changes to the server.")
      .addDropdown((dd) =>
        dd
          .addOption("0", "Disabled")
          .addOption("-1", "Only on change")
          .addOption("5", "Every 5 minutes")
          .addOption("10", "Every 10 minutes")
          .addOption("15", "Every 15 minutes")
          .addOption("30", "Every 30 minutes")
          .addOption("60", "Every hour")
          .setValue(String(this.plugin.settings.autoSyncInterval))
          .onChange(async (value) => {
            this.plugin.settings.autoSyncInterval = parseInt(value, 10);
            await this.plugin.saveSettings();
            this.plugin.restartAutoSync();
          })
      );

    if (this.plugin.settings.lastSyncTime > 0) {
      new Setting(containerEl)
        .setName("Last sync")
        .setDesc(new Date(this.plugin.settings.lastSyncTime).toLocaleString())
        .addButton((btn) =>
          btn.setButtonText("Sync now").onClick(async () => {
            await this.plugin.syncNow();
          })
        );
    } else {
      new Setting(containerEl)
        .setName("Manual sync")
        .addButton((btn) =>
          btn.setButtonText("Sync now").onClick(async () => {
            await this.plugin.syncNow();
          })
        );
    }

    new Setting(containerEl)
      .setName("Directional sync")
      .setDesc(
        "Push: upload local files to server — local wins on conflicts, server changes are ignored. " +
        "Pull: download server files to local — server wins on conflicts, local uploads are skipped. " +
        "Use Push when you paste files locally that have older timestamps and don't want them overwritten."
      )
      .addButton((btn) =>
        btn.setButtonText("Push only").onClick(async () => {
          await this.plugin.pushNow();
        })
      )
      .addButton((btn) =>
        btn.setButtonText("Pull only").onClick(async () => {
          await this.plugin.pullNow();
        })
      );

    // ── Exclude from sync ────────────────────────────────────────────────────
    containerEl.createEl("h3", { text: "Exclude from sync" });

    // Chips container — rendered first, updated in-place when list changes
    const chipsContainer = containerEl.createDiv({ cls: "cloudsync-chip-list" });
    this.renderChips(chipsContainer);

    // File/folder search input
    let addText: { getValue: () => string; setValue: (v: string) => typeof addText };
    new Setting(containerEl)
      .setName("Add exclusion")
      .setDesc("Search vault files and folders, or type a glob pattern (e.g. *.tmp) and press Enter.")
      .addText((text) => {
        text.setPlaceholder("Search files and folders…");
        addText = text;

        // Vault path suggestions
        new FileFolderSuggest(this.app, text.inputEl, this.plugin, async (path) => {
          await this.addPattern(path, chipsContainer);
        });

        // Custom pattern entry via Enter
        text.inputEl.addEventListener("keydown", async (e: KeyboardEvent) => {
          if (e.key === "Enter") {
            const val = text.getValue().trim();
            if (val) {
              await this.addPattern(val, chipsContainer);
              text.setValue("");
            }
          }
        });
      });
  }

  private async addPattern(pattern: string, chipsContainer: HTMLElement): Promise<void> {
    if (!this.plugin.settings.excludePatterns.includes(pattern)) {
      this.plugin.settings.excludePatterns.push(pattern);
      await this.plugin.saveSettings();
      this.renderChips(chipsContainer);
    }
  }

  private renderChips(container: HTMLElement): void {
    container.empty();
    if (this.plugin.settings.excludePatterns.length === 0) {
      container.createEl("div", { text: "No exclusions added.", cls: "cloudsync-chip-empty" });
      return;
    }
    for (const pattern of [...this.plugin.settings.excludePatterns]) {
      const chip = container.createDiv({ cls: "cloudsync-chip" });
      chip.createEl("span", { text: pattern, cls: "cloudsync-chip-text" });
      const btn = chip.createEl("button", { cls: "cloudsync-chip-remove", text: "×" });
      btn.setAttribute("aria-label", `Remove ${pattern}`);
      btn.addEventListener("click", async () => {
        this.plugin.settings.excludePatterns =
          this.plugin.settings.excludePatterns.filter((p) => p !== pattern);
        await this.plugin.saveSettings();
        this.renderChips(container);
      });
    }
  }
}
