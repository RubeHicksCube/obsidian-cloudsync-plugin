import { App, Modal, PluginSettingTab, Setting, Notice, AbstractInputSuggest, TFolder } from "obsidian";
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
  // Active vault — set from server vault list after login
  vaultId: string;
  vaultName: string;
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
  vaultId: "default",
  vaultName: "",
};

// ── Change Passphrase Modal ────────────────────────────────────────────────────

class ChangePassphraseModal extends Modal {
  private plugin: CloudSyncPlugin;

  constructor(app: App, plugin: CloudSyncPlugin) {
    super(app);
    this.plugin = plugin;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl("h2", { text: "Change Encryption Passphrase" });
    contentEl.createEl("p", {
      text: "Warning: this re-encrypts all files with the new passphrase. All other devices must update their passphrase before they can sync again.",
      attr: { style: "color: var(--text-muted); margin-bottom: 12px;" },
    });

    let newPassphrase = "";
    let confirmPassphrase = "";

    new Setting(contentEl)
      .setName("New passphrase")
      .addText((text) => {
        text.inputEl.type = "password";
        text.setPlaceholder("Enter new passphrase…");
        text.onChange((value) => { newPassphrase = value; });
      });

    new Setting(contentEl)
      .setName("Confirm passphrase")
      .addText((text) => {
        text.inputEl.type = "password";
        text.setPlaceholder("Confirm new passphrase…");
        text.onChange((value) => { confirmPassphrase = value; });
      });

    new Setting(contentEl)
      .addButton((btn) =>
        btn
          .setButtonText("Change Passphrase")
          .setWarning()
          .onClick(async () => {
            if (!newPassphrase) {
              new Notice("CloudSync: Passphrase cannot be empty");
              return;
            }
            if (newPassphrase !== confirmPassphrase) {
              new Notice("CloudSync: Passphrases do not match");
              return;
            }
            this.close();
            try {
              await this.plugin.changePassphrase(newPassphrase);
              new Notice("CloudSync: Passphrase changed. Re-uploading all files…");
            } catch (e: unknown) {
              const msg = e instanceof Error ? e.message : String(e);
              new Notice(`CloudSync: Passphrase change failed — ${msg}`);
            }
          })
      )
      .addButton((btn) =>
        btn.setButtonText("Cancel").onClick(() => this.close())
      );
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

// ── Create Vault Modal ────────────────────────────────────────────────────────

class CreateVaultModal extends Modal {
  private plugin: CloudSyncPlugin;
  private onConfirm: (name: string) => Promise<void>;

  constructor(app: App, plugin: CloudSyncPlugin, onConfirm: (name: string) => Promise<void>) {
    super(app);
    this.plugin = plugin;
    this.onConfirm = onConfirm;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl("h2", { text: "Create New Vault" });
    contentEl.createEl("p", {
      text: "Give your vault a name. Each vault is a separate file namespace — files in one vault are not visible to other vaults.",
    });

    let vaultName = "";
    new Setting(contentEl)
      .setName("Vault name")
      .addText((text) => {
        text.setPlaceholder("e.g. Personal, Work, Archive…");
        text.onChange((value) => { vaultName = value; });
        // Allow Enter key to confirm
        text.inputEl.addEventListener("keydown", async (e: KeyboardEvent) => {
          if (e.key === "Enter" && vaultName.trim()) {
            this.close();
            await this.onConfirm(vaultName.trim());
          }
        });
        // Auto-focus
        setTimeout(() => text.inputEl.focus(), 50);
      });

    new Setting(contentEl)
      .addButton((btn) =>
        btn
          .setButtonText("Create")
          .setCta()
          .onClick(async () => {
            if (!vaultName.trim()) {
              new Notice("CloudSync: Vault name cannot be empty");
              return;
            }
            this.close();
            await this.onConfirm(vaultName.trim());
          })
      )
      .addButton((btn) =>
        btn.setButtonText("Cancel").onClick(() => this.close())
      );
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

// ── Settings tab ──────────────────────────────────────────────────────────────

export class CloudSyncSettingTab extends PluginSettingTab {
  plugin: CloudSyncPlugin;

  constructor(app: App, plugin: CloudSyncPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  async display(): Promise<void> {
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
            const authResp = await this.plugin.api.login();
            // Auto-configure encryption from server vault key
            await this.plugin.handleVaultKeyFromAuth(authResp);
            // Auto-select first vault if none is set
            await this.plugin.autoSelectVault();
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
            await this.plugin.autoSelectVault();
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

    // ── Vault ────────────────────────────────────────────────────────────────
    if (isLoggedIn) {
      containerEl.createEl("h3", { text: "Vault" });

      // Load vaults from server
      let vaults: import("./api").VaultInfo[] = [];
      try {
        vaults = await this.plugin.api.listVaults();
        // Auto-select first vault if none selected
        if (vaults.length > 0 && !this.plugin.settings.vaultId) {
          this.plugin.settings.vaultId = vaults[0].id;
          this.plugin.settings.vaultName = vaults[0].name;
          await this.plugin.saveSettings();
        }
      } catch {
        // Server may be unreachable — show cached vault name
      }

      const vaultSetting = new Setting(containerEl)
        .setName("Active vault")
        .setDesc(
          "Files sync to the selected vault. Each vault is isolated — switching vaults shows different files."
        );

      if (vaults.length > 0) {
        vaultSetting.addDropdown((dd) => {
          for (const v of vaults) {
            dd.addOption(v.id, v.name);
          }
          dd.setValue(this.plugin.settings.vaultId || vaults[0].id);
          dd.onChange(async (value) => {
            const vault = vaults.find((v) => v.id === value);
            this.plugin.settings.vaultId = value;
            this.plugin.settings.vaultName = vault?.name ?? value;
            this.plugin.settings.lastSyncTime = 0;
            this.plugin.settings.lastSyncedPaths = [];
            await this.plugin.saveSettings();
            new Notice(`CloudSync: Switched to vault "${vault?.name ?? value}"`);
          });
        });
      } else if (this.plugin.settings.vaultName) {
        vaultSetting.setDesc(`Active vault: ${this.plugin.settings.vaultName} (offline)`);
      }

      vaultSetting.addButton((btn) =>
        btn.setButtonText("+ New vault").onClick(() => {
          new CreateVaultModal(this.app, this.plugin, async (name) => {
            try {
              const v = await this.plugin.api.createVault(name);
              this.plugin.settings.vaultId = v.id;
              this.plugin.settings.vaultName = v.name;
              this.plugin.settings.lastSyncTime = 0;
              this.plugin.settings.lastSyncedPaths = [];
              await this.plugin.saveSettings();
              new Notice(`CloudSync: Created and switched to vault "${v.name}"`);
              this.display();
            } catch (e: unknown) {
              const msg = e instanceof Error ? e.message : String(e);
              new Notice(`CloudSync: Failed to create vault — ${msg}`);
            }
          }).open();
        })
      );
    }

    // ── Encryption ───────────────────────────────────────────────────────────
    containerEl.createEl("h3", { text: "Encryption" });

    const hasSalt = !!this.plugin.settings.encryptionSalt;
    const hasPassphrase = !!this.plugin.settings.encryptionPassphrase;

    if (hasSalt && hasPassphrase) {
      new Setting(containerEl)
        .setName("Encryption")
        .setDesc(
          "Active — files are encrypted with AES-256-GCM before leaving this device. " +
          "The encryption key is synced automatically from your account."
        );
    } else if (hasSalt && !hasPassphrase) {
      // Account has encryption configured but this device hasn't loaded the key yet.
      new Setting(containerEl)
        .setName("Encryption — key not loaded")
        .setDesc(
          "The server has encryption configured but the key hasn't loaded on this device. " +
          "Log out and log back in to load it automatically, or click 'Load from account'."
        )
        .addButton((btn) =>
          btn
            .setButtonText("Load from account")
            .setCta()
            .onClick(async () => {
              try {
                const authResp = await this.plugin.api.login();
                await this.plugin.handleVaultKeyFromAuth(authResp);
                this.display();
              } catch (e: unknown) {
                const msg = e instanceof Error ? e.message : String(e);
                new Notice(`CloudSync: Could not load encryption key — ${msg}`);
              }
            })
        );
    } else {
      new Setting(containerEl)
        .setName("Encryption")
        .setDesc(
          "Not configured — files are synced without encryption. " +
          "To enable encryption, see the Advanced section below."
        );
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

    new Setting(containerEl)
      .setName("Repair server files")
      .setDesc(
        "Re-uploads all local files to the server using the current encryption key. " +
        "Use this if files on the server cannot be decrypted on other devices (e.g., uploaded " +
        "via a proxy that corrupted the encrypted data). Only files present on this device are repaired."
      )
      .addButton((btn) =>
        btn
          .setButtonText("Force re-upload all")
          .setWarning()
          .onClick(async () => {
            try {
              await this.plugin.syncEngine.reEncryptLocal();
              new Notice("CloudSync: Re-upload complete. Files should now be decryptable on all devices.");
            } catch (e: unknown) {
              const msg = e instanceof Error ? e.message : String(e);
              new Notice(`CloudSync: Re-upload failed — ${msg}`);
            }
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

    // ── Advanced ─────────────────────────────────────────────────────────────
    const advancedDetails = containerEl.createEl("details");
    advancedDetails.createEl("summary", { text: "Advanced" });
    const advancedEl = advancedDetails.createDiv();

    new Setting(advancedEl)
      .setName("Change encryption passphrase")
      .setDesc(
        "Generates a new encryption key and re-uploads all local files. " +
        "Other devices will need to log out and log back in to receive the new key automatically."
      )
      .addButton((btn) =>
        btn
          .setButtonText("Change Passphrase")
          .setWarning()
          .onClick(() => {
            new ChangePassphraseModal(this.plugin.app, this.plugin).open();
          })
      );

    if (!hasPassphrase && !hasSalt) {
      new Setting(advancedEl)
        .setName("Set encryption passphrase")
        .setDesc(
          "Enable client-side encryption for this account. Leave empty to sync without encryption. " +
          "Once set, all devices on this account will encrypt files automatically."
        )
        .addText((text) => {
          text.inputEl.type = "password";
          text
            .setPlaceholder("Enter a passphrase…")
            .setValue(this.plugin.settings.encryptionPassphrase)
            .onChange(async (value) => {
              this.plugin.settings.encryptionPassphrase = value;
              await this.plugin.saveSettings();
              void this.plugin.pushVaultKey();
            });
        });
    }
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
