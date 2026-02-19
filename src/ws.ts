import type CloudSyncPlugin from "./main";

/**
 * WebSocket client for real-time sync notifications.
 * Connects to the server's /api/ws endpoint and triggers
 * a delta sync when other devices upload or delete files.
 */
export class WebSocketClient {
  private plugin: CloudSyncPlugin;
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = 1000; // Start at 1s, exponential backoff
  private maxReconnectDelay = 30000;
  private alive = false;

  constructor(plugin: CloudSyncPlugin) {
    this.plugin = plugin;
  }

  /**
   * Connect to the WebSocket endpoint.
   */
  connect(): void {
    if (!this.plugin.api.isLoggedIn()) return;

    const serverUrl = this.plugin.settings.serverUrl;
    const token = this.plugin.settings.accessToken;

    // Convert http(s) to ws(s)
    const wsUrl = serverUrl
      .replace(/^https:\/\//, "wss://")
      .replace(/^http:\/\//, "ws://");

    const url = `${wsUrl}/api/ws?token=${encodeURIComponent(token)}`;

    try {
      this.ws = new WebSocket(url);
      this.alive = true;

      this.ws.onopen = () => {
        console.log("CloudSync WS: Connected");
        this.reconnectDelay = 1000; // Reset backoff on successful connect
      };

      this.ws.onmessage = (event) => {
        this.handleMessage(event.data);
      };

      this.ws.onclose = (event) => {
        console.log(
          `CloudSync WS: Closed (code=${event.code}, reason=${event.reason})`
        );
        this.ws = null;
        if (this.alive) {
          this.scheduleReconnect();
        }
      };

      this.ws.onerror = () => {
        // onclose will fire after onerror, so reconnect logic is there
        console.warn("CloudSync WS: Connection error");
      };
    } catch (e) {
      console.warn("CloudSync WS: Failed to connect:", e);
      this.scheduleReconnect();
    }
  }

  /**
   * Disconnect and stop reconnecting.
   */
  disconnect(): void {
    this.alive = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  /**
   * Handle incoming WebSocket messages.
   */
  private handleMessage(data: string): void {
    try {
      const msg = JSON.parse(data);
      if (msg.type === "sync_update") {
        console.log(
          `CloudSync WS: Sync update - ${msg.action} ${msg.file_path}`
        );
        // Trigger a delta sync after a short debounce
        if (!this.plugin.syncEngine.isSyncing) {
          // Small delay to batch multiple rapid updates
          setTimeout(() => {
            if (!this.plugin.syncEngine.isSyncing) {
              this.plugin.syncNow();
            }
          }, 2000);
        }
      }
    } catch {
      // Ignore non-JSON messages (pings, etc.)
    }
  }

  /**
   * Schedule a reconnect with exponential backoff.
   */
  private scheduleReconnect(): void {
    if (!this.alive) return;

    console.log(
      `CloudSync WS: Reconnecting in ${this.reconnectDelay / 1000}s...`
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.reconnectDelay);

    // Exponential backoff: 1s, 2s, 4s, 8s, 16s, 30s max
    this.reconnectDelay = Math.min(
      this.reconnectDelay * 2,
      this.maxReconnectDelay
    );
  }

  get isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }
}
