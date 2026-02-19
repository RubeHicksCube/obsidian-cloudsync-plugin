import type CloudSyncPlugin from "./main";

export type SyncState = "idle" | "syncing" | "error";

export class StatusBar {
  private plugin: CloudSyncPlugin;
  private statusBarEl: HTMLElement;
  private state: SyncState = "idle";
  private message: string = "";
  private progress: string = "";

  constructor(plugin: CloudSyncPlugin, statusBarEl: HTMLElement) {
    this.plugin = plugin;
    this.statusBarEl = statusBarEl;
    this.render();
  }

  setState(state: SyncState, message?: string): void {
    this.state = state;
    this.message = message || "";
    this.progress = "";
    this.render();
  }

  /**
   * Set sync progress with file count.
   */
  setProgress(current: number, total: number, message?: string): void {
    this.state = "syncing";
    this.progress = `${current}/${total}`;
    this.message = message || "";
    this.render();
  }

  private render(): void {
    this.statusBarEl.empty();
    this.statusBarEl.addClass("cloudsync-status-bar");

    const icon = this.statusBarEl.createSpan({ cls: `sync-icon ${this.state}` });
    // Set title on the icon for accessibility
    icon.setAttribute("aria-label", this.state);

    let text: string;
    switch (this.state) {
      case "idle":
        if (this.plugin.settings.lastSyncTime > 0) {
          const ago = this.timeAgo(this.plugin.settings.lastSyncTime);
          text = `Synced ${ago}`;
        } else {
          text = "CloudSync: Ready";
        }
        break;
      case "syncing":
        if (this.progress) {
          text = `Syncing ${this.progress} files...`;
        } else {
          text = this.message || "Syncing...";
        }
        break;
      case "error":
        text = this.message || "Sync error";
        break;
    }

    this.statusBarEl.createSpan({ text });
  }

  private timeAgo(timestamp: number): string {
    const now = Date.now();
    const diffMs = now - timestamp;
    const diffSec = Math.floor(diffMs / 1000);

    if (diffSec < 60) return "just now";
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHours = Math.floor(diffMin / 60);
    if (diffHours < 24) return `${diffHours}h ago`;
    const diffDays = Math.floor(diffHours / 24);
    return `${diffDays}d ago`;
  }
}
