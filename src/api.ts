import { requestUrl, RequestUrlParam, RequestUrlResponse } from "obsidian";
import type CloudSyncPlugin from "./main";

// ── Server response types ──

export interface AuthResponse {
  access_token: string;
  refresh_token: string;
  user_id: string;
  device_id: string;
  is_admin: boolean;
}

export interface FileManifestEntry {
  path: string;
  hash: string;
  size: number;
  modified_at: number;
}

export interface SyncInstruction {
  path: string;
  action: "upload" | "download" | "delete" | "conflict";
  file_id: string | null;
  server_hash: string | null;
  server_modified_at: number | null;
}

export interface DeltaResponse {
  instructions: SyncInstruction[];
  server_time: number;
}

export interface UploadResponse {
  file_id: string;
  version: number;
}

export interface CompleteResponse {
  message: string;
  server_version: number;
}

export interface FileInfo {
  id: string;
  path: string;
  current_version: number;
  hash: string;
  size: number;
  is_deleted: boolean;
  created_at: number;
  updated_at: number;
}

export interface VersionInfo {
  id: string;
  version: number;
  hash: string;
  size: number;
  device_id: string | null;
  created_at: number;
}

export interface DeviceInfo {
  id: string;
  name: string;
  device_type: string | null;
  last_seen_at: number;
  created_at: number;
  revoked: boolean;
}

// ── API Client ──

export class CloudSyncAPI {
  private plugin: CloudSyncPlugin;
  private refreshing: Promise<void> | null = null;

  constructor(plugin: CloudSyncPlugin) {
    this.plugin = plugin;
  }

  private get baseUrl(): string {
    return this.plugin.settings.serverUrl;
  }

  private get accessToken(): string {
    return this.plugin.settings.accessToken;
  }

  // ── Auth endpoints (public, no token needed) ──

  async register(): Promise<AuthResponse> {
    const s = this.plugin.settings;
    if (!s.username || !s.password) {
      throw new Error("Username and password are required");
    }
    const resp = await this.request("POST", "/api/auth/register", {
      username: s.username,
      password: s.password,
      device_name: `Obsidian (${this.getDeviceName()})`,
    }, false);
    const data = resp as AuthResponse;
    await this.storeAuth(data);
    return data;
  }

  async login(): Promise<AuthResponse> {
    const s = this.plugin.settings;
    if (!s.username || !s.password) {
      throw new Error("Username and password are required");
    }
    const resp = await this.request("POST", "/api/auth/login", {
      username: s.username,
      password: s.password,
      device_name: `Obsidian (${this.getDeviceName()})`,
      device_type: "obsidian",
    }, false);
    const data = resp as AuthResponse;
    await this.storeAuth(data);
    return data;
  }

  async logout(): Promise<void> {
    if (this.plugin.settings.refreshToken) {
      await this.request("POST", "/api/auth/logout", {
        refresh_token: this.plugin.settings.refreshToken,
      }, false);
    }
    this.plugin.settings.accessToken = "";
    this.plugin.settings.refreshToken = "";
    this.plugin.settings.userId = "";
    this.plugin.settings.deviceId = "";
    await this.plugin.saveSettings();
  }

  private async refreshTokens(): Promise<void> {
    if (!this.plugin.settings.refreshToken) {
      throw new Error("No refresh token available. Please log in again.");
    }
    const resp = await this.request("POST", "/api/auth/refresh", {
      refresh_token: this.plugin.settings.refreshToken,
    }, false);
    const data = resp as AuthResponse;
    await this.storeAuth(data);
  }

  private async storeAuth(data: AuthResponse): Promise<void> {
    this.plugin.settings.accessToken = data.access_token;
    this.plugin.settings.refreshToken = data.refresh_token;
    this.plugin.settings.userId = data.user_id;
    this.plugin.settings.deviceId = data.device_id;
    await this.plugin.saveSettings();
  }

  // ── Sync endpoints ──

  async delta(files: FileManifestEntry[]): Promise<DeltaResponse> {
    return (await this.authRequest("POST", "/api/sync/delta", {
      files,
      device_id: this.plugin.settings.deviceId,
    })) as DeltaResponse;
  }

  async upload(path: string, data: ArrayBuffer): Promise<UploadResponse> {
    return (await this.authUpload("/api/sync/upload", path, data)) as UploadResponse;
  }

  async download(fileId: string): Promise<ArrayBuffer> {
    return await this.authDownload(`/api/sync/download/${fileId}`);
  }

  async deleteFile(fileId: string): Promise<void> {
    await this.authRequest("DELETE", `/api/sync/delete/${fileId}`);
  }

  async complete(): Promise<CompleteResponse> {
    return (await this.authRequest("POST", "/api/sync/complete", {
      device_id: this.plugin.settings.deviceId,
    })) as CompleteResponse;
  }

  // ── File management endpoints ──

  async listFiles(includeDeleted = false): Promise<FileInfo[]> {
    const query = includeDeleted ? "?include_deleted=true" : "";
    return (await this.authRequest("GET", `/api/files${query}`)) as FileInfo[];
  }

  async fileVersions(fileId: string): Promise<VersionInfo[]> {
    return (await this.authRequest(
      "GET",
      `/api/files/${fileId}/versions`
    )) as VersionInfo[];
  }

  async rollback(fileId: string, version: number): Promise<FileInfo> {
    return (await this.authRequest(
      "POST",
      `/api/files/${fileId}/rollback`,
      { version }
    )) as FileInfo;
  }

  // ── Device management endpoints ──

  async listDevices(): Promise<DeviceInfo[]> {
    return (await this.authRequest("GET", "/api/devices")) as DeviceInfo[];
  }

  async revokeDevice(deviceId: string): Promise<void> {
    await this.authRequest("DELETE", `/api/devices/${deviceId}`);
  }

  // ── Internal HTTP methods ──

  /**
   * Make an authenticated JSON request with automatic 401 retry.
   */
  private async authRequest(
    method: string,
    path: string,
    body?: unknown
  ): Promise<unknown> {
    try {
      return await this.request(method, path, body, true);
    } catch (e: unknown) {
      if (e instanceof ApiError && e.status === 401) {
        await this.handleTokenRefresh();
        return await this.request(method, path, body, true);
      }
      throw e;
    }
  }

  /**
   * Upload a file via multipart/form-data with automatic 401 retry.
   */
  private async authUpload(
    path: string,
    filePath: string,
    fileData: ArrayBuffer
  ): Promise<unknown> {
    try {
      return await this.uploadRequest(path, filePath, fileData);
    } catch (e: unknown) {
      if (e instanceof ApiError && e.status === 401) {
        await this.handleTokenRefresh();
        return await this.uploadRequest(path, filePath, fileData);
      }
      throw e;
    }
  }

  /**
   * Download binary data with automatic 401 retry.
   */
  private async authDownload(path: string): Promise<ArrayBuffer> {
    try {
      return await this.downloadRequest(path);
    } catch (e: unknown) {
      if (e instanceof ApiError && e.status === 401) {
        await this.handleTokenRefresh();
        return await this.downloadRequest(path);
      }
      throw e;
    }
  }

  /**
   * Coalesce concurrent refresh calls into a single request.
   */
  private async handleTokenRefresh(): Promise<void> {
    if (!this.refreshing) {
      this.refreshing = this.refreshTokens().finally(() => {
        this.refreshing = null;
      });
    }
    await this.refreshing;
  }

  /**
   * Make a JSON request.
   */
  private async request(
    method: string,
    path: string,
    body?: unknown,
    auth = true
  ): Promise<unknown> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (auth && this.accessToken) {
      headers["Authorization"] = `Bearer ${this.accessToken}`;
    }

    const params: RequestUrlParam = {
      url: `${this.baseUrl}${path}`,
      method,
      headers,
      throw: false,
    };

    if (body !== undefined) {
      params.body = JSON.stringify(body);
    }

    const resp: RequestUrlResponse = await requestUrl(params);

    if (resp.status >= 400) {
      let message = `HTTP ${resp.status}`;
      try {
        const errBody = resp.json;
        if (errBody && errBody.error) {
          message = errBody.error;
        } else if (errBody && errBody.message) {
          message = errBody.message;
        }
      } catch {
        // use status as message
      }
      throw new ApiError(message, resp.status);
    }

    // Some endpoints may return empty body
    if (resp.status === 204 || !resp.text) {
      return {};
    }

    return resp.json;
  }

  /**
   * Upload a file as multipart/form-data.
   * Obsidian's requestUrl doesn't natively support multipart, so we
   * manually build the multipart body.
   */
  private async uploadRequest(
    path: string,
    filePath: string,
    fileData: ArrayBuffer
  ): Promise<unknown> {
    const boundary = "----CloudSync" + Date.now().toString(36) + Math.random().toString(36);

    // Build multipart body manually
    const encoder = new TextEncoder();

    const pathPart =
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="path"\r\n\r\n` +
      `${filePath}\r\n`;

    const filePart =
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${filePath.split("/").pop()}"\r\n` +
      `Content-Type: application/octet-stream\r\n\r\n`;

    const ending = `\r\n--${boundary}--\r\n`;

    const pathBytes = encoder.encode(pathPart);
    const filePartBytes = encoder.encode(filePart);
    const endingBytes = encoder.encode(ending);
    const fileBytes = new Uint8Array(fileData);

    // Combine all parts
    const totalLength =
      pathBytes.byteLength +
      filePartBytes.byteLength +
      fileBytes.byteLength +
      endingBytes.byteLength;

    const combined = new Uint8Array(totalLength);
    let offset = 0;
    combined.set(pathBytes, offset);
    offset += pathBytes.byteLength;
    combined.set(filePartBytes, offset);
    offset += filePartBytes.byteLength;
    combined.set(fileBytes, offset);
    offset += fileBytes.byteLength;
    combined.set(endingBytes, offset);

    const headers: Record<string, string> = {
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
    };
    if (this.accessToken) {
      headers["Authorization"] = `Bearer ${this.accessToken}`;
    }

    const resp: RequestUrlResponse = await requestUrl({
      url: `${this.baseUrl}${path}`,
      method: "POST",
      headers,
      body: combined.buffer,
      throw: false,
    });

    if (resp.status >= 400) {
      let message = `HTTP ${resp.status}`;
      try {
        const errBody = resp.json;
        if (errBody && errBody.error) message = errBody.error;
        else if (errBody && errBody.message) message = errBody.message;
      } catch {
        // use status
      }
      throw new ApiError(message, resp.status);
    }

    return resp.json;
  }

  /**
   * Download binary data from the server.
   */
  private async downloadRequest(path: string): Promise<ArrayBuffer> {
    const headers: Record<string, string> = {};
    if (this.accessToken) {
      headers["Authorization"] = `Bearer ${this.accessToken}`;
    }

    const resp: RequestUrlResponse = await requestUrl({
      url: `${this.baseUrl}${path}`,
      method: "GET",
      headers,
      throw: false,
    });

    if (resp.status >= 400) {
      let message = `HTTP ${resp.status}`;
      try {
        const errBody = resp.json;
        if (errBody && errBody.error) message = errBody.error;
        else if (errBody && errBody.message) message = errBody.message;
      } catch {
        // use status
      }
      throw new ApiError(message, resp.status);
    }

    return resp.arrayBuffer;
  }

  // ── Helpers ──

  private getDeviceName(): string {
    try {
      // Try to get a meaningful device name
      if (typeof navigator !== "undefined" && navigator.userAgent) {
        if (navigator.userAgent.includes("Windows")) return "Windows";
        if (navigator.userAgent.includes("Mac")) return "macOS";
        if (navigator.userAgent.includes("Linux")) return "Linux";
        if (navigator.userAgent.includes("Android")) return "Android";
        if (navigator.userAgent.includes("iPhone") || navigator.userAgent.includes("iPad"))
          return "iOS";
      }
    } catch {
      // ignore
    }
    return "Desktop";
  }

  isLoggedIn(): boolean {
    return !!this.plugin.settings.accessToken;
  }
}

export class ApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}
