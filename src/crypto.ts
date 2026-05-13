/**
 * Client-side AES-256-GCM encryption using Web Crypto API.
 *
 * Key derivation: PBKDF2 with 600,000 iterations, SHA-256, random 16-byte salt.
 * Encryption: AES-256-GCM with random 12-byte IV.
 *
 * Blob format (v1): [MAGIC "CSYN" (4)] [version=0x01 (1)] [IV (12)] [ciphertext + GCM auth tag]
 *
 * Legacy blobs (no magic prefix) were encrypted with 100,000 PBKDF2 iterations
 * and are detected by the absence of the magic header. They are still decrypted
 * correctly; new encryptions always use the v1 format with 600,000 iterations.
 */

const PBKDF2_ITERATIONS = 600_000;
const LEGACY_PBKDF2_ITERATIONS = 100_000;
const SALT_LENGTH = 16;
const IV_LENGTH = 12;

// Magic prefix that can't appear at the start of a legacy IV by coincidence
// (probability 1/2^32). "CSYN" in ASCII.
const FORMAT_MAGIC = new Uint8Array([0x43, 0x53, 0x59, 0x4e]);
const FORMAT_VERSION = 0x01;
const HEADER_LENGTH = FORMAT_MAGIC.length + 1; // 5 bytes

export class CryptoEngine {
  private cachedKey: CryptoKey | null = null;
  private cachedPassphrase: string = "";
  private cachedSaltHex: string = "";

  // Separate cache for the legacy 100k-iteration key (used only for decryption).
  private legacyCachedKey: CryptoKey | null = null;
  private legacyCachedPassphrase: string = "";
  private legacyCachedSaltHex: string = "";

  /**
   * Derive an AES-256-GCM key from a passphrase and salt.
   */
  private async deriveKey(
    passphrase: string,
    salt: Uint8Array,
    iterations: number
  ): Promise<CryptoKey> {
    const encoder = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey(
      "raw",
      encoder.encode(passphrase),
      "PBKDF2",
      false,
      ["deriveKey"]
    );

    return await crypto.subtle.deriveKey(
      {
        name: "PBKDF2",
        salt: salt.buffer as ArrayBuffer,
        iterations,
        hash: "SHA-256",
      },
      keyMaterial,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"]
    );
  }

  /**
   * Get or derive the current encryption key (600k iterations).
   */
  private async getKey(passphrase: string, saltHex: string): Promise<CryptoKey> {
    if (
      this.cachedKey &&
      this.cachedPassphrase === passphrase &&
      this.cachedSaltHex === saltHex
    ) {
      return this.cachedKey;
    }

    const salt = hexToBytes(saltHex);
    this.cachedKey = await this.deriveKey(passphrase, salt, PBKDF2_ITERATIONS);
    this.cachedPassphrase = passphrase;
    this.cachedSaltHex = saltHex;
    return this.cachedKey;
  }

  /**
   * Get or derive the legacy key (100k iterations) for reading old blobs.
   */
  private async getLegacyKey(passphrase: string, saltHex: string): Promise<CryptoKey> {
    if (
      this.legacyCachedKey &&
      this.legacyCachedPassphrase === passphrase &&
      this.legacyCachedSaltHex === saltHex
    ) {
      return this.legacyCachedKey;
    }

    const salt = hexToBytes(saltHex);
    this.legacyCachedKey = await this.deriveKey(passphrase, salt, LEGACY_PBKDF2_ITERATIONS);
    this.legacyCachedPassphrase = passphrase;
    this.legacyCachedSaltHex = saltHex;
    return this.legacyCachedKey;
  }

  /**
   * Generate a new random salt (hex-encoded).
   */
  generateSalt(): string {
    const salt = new Uint8Array(SALT_LENGTH);
    crypto.getRandomValues(salt);
    return bytesToHex(salt);
  }

  /**
   * Encrypt plaintext data.
   * Returns v1 format: [MAGIC(4)] [version(1)] [IV(12)] [ciphertext + GCM tag].
   */
  async encrypt(
    data: ArrayBuffer,
    passphrase: string,
    saltHex: string
  ): Promise<ArrayBuffer> {
    const key = await this.getKey(passphrase, saltHex);
    const iv = new Uint8Array(IV_LENGTH);
    crypto.getRandomValues(iv);

    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      key,
      data
    );

    // v1 layout: MAGIC(4) + version(1) + IV(12) + ciphertext
    const result = new Uint8Array(HEADER_LENGTH + IV_LENGTH + ciphertext.byteLength);
    result.set(FORMAT_MAGIC, 0);
    result[FORMAT_MAGIC.length] = FORMAT_VERSION;
    result.set(iv, HEADER_LENGTH);
    result.set(new Uint8Array(ciphertext), HEADER_LENGTH + IV_LENGTH);

    return result.buffer;
  }

  /**
   * Decrypt data produced by encrypt() or the old legacy format.
   *
   * Detects format automatically:
   *   - v1 blob: starts with MAGIC "CSYN" → use 600k-iteration key
   *   - legacy blob: no magic prefix → use 100k-iteration key
   */
  async decrypt(
    encryptedData: ArrayBuffer,
    passphrase: string,
    saltHex: string
  ): Promise<ArrayBuffer> {
    const dataView = new Uint8Array(encryptedData);

    // Detect v1 format by magic prefix
    const hasV1Magic =
      dataView.byteLength >= HEADER_LENGTH + IV_LENGTH + 1 &&
      dataView[0] === FORMAT_MAGIC[0] &&
      dataView[1] === FORMAT_MAGIC[1] &&
      dataView[2] === FORMAT_MAGIC[2] &&
      dataView[3] === FORMAT_MAGIC[3];

    if (hasV1Magic) {
      const version = dataView[FORMAT_MAGIC.length];
      if (version !== FORMAT_VERSION) {
        throw new Error(
          `Unknown encryption format version: 0x${version.toString(16).padStart(2, "0")}. ` +
          `Please update the CloudSync plugin.`
        );
      }
      const iv = dataView.slice(HEADER_LENGTH, HEADER_LENGTH + IV_LENGTH);
      const ciphertext = dataView.slice(HEADER_LENGTH + IV_LENGTH);
      const key = await this.getKey(passphrase, saltHex);
      try {
        return await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
      } catch {
        throw new Error(
          "Decryption failed. The passphrase may be incorrect or the data is corrupted."
        );
      }
    }

    // Legacy format: [IV(12)] [ciphertext + GCM tag], 100k iterations
    if (dataView.byteLength < IV_LENGTH + 1) {
      throw new Error("Encrypted data is too short");
    }
    const iv = dataView.slice(0, IV_LENGTH);
    const ciphertext = dataView.slice(IV_LENGTH);
    const key = await this.getLegacyKey(passphrase, saltHex);
    try {
      return await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
    } catch {
      throw new Error(
        "Decryption failed. The passphrase may be incorrect or the data is corrupted."
      );
    }
  }

  /**
   * Clear the cached keys (e.g., when passphrase changes).
   */
  clearCache(): void {
    this.cachedKey = null;
    this.cachedPassphrase = "";
    this.cachedSaltHex = "";
    this.legacyCachedKey = null;
    this.legacyCachedPassphrase = "";
    this.legacyCachedSaltHex = "";
  }
}

// ── Utility functions ──

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

// ── Vault key wrapping (cross-device passphrase sharing) ─────────────────────

/**
 * Derive a per-account "wrapping key" from the login credentials.
 * The derivation is client-side only — the server never sees the raw password
 * or this key. Used to encrypt/decrypt the vault passphrase stored on the server.
 */
export async function deriveAccountKey(password: string, username: string): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    enc.encode(password),
    "PBKDF2",
    false,
    ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: enc.encode(username),
      iterations: 100_000,
      hash: "SHA-256",
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

/**
 * Encrypt the vault passphrase with the account wrapping key.
 * Returns hex-encoded: IV (12 bytes) + AES-256-GCM ciphertext.
 */
export async function encryptVaultKey(
  passphrase: string,
  accountKey: CryptoKey
): Promise<string> {
  const enc = new TextEncoder();
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    accountKey,
    enc.encode(passphrase)
  );
  const result = new Uint8Array(12 + ciphertext.byteLength);
  result.set(iv, 0);
  result.set(new Uint8Array(ciphertext), 12);
  return bytesToHex(result);
}

/**
 * Decrypt the vault passphrase from the server-stored hex blob.
 */
export async function decryptVaultKey(
  ciphertextHex: string,
  accountKey: CryptoKey
): Promise<string> {
  const data = hexToBytes(ciphertextHex);
  if (data.length < 13) throw new Error("Invalid vault key ciphertext");
  const iv = data.slice(0, 12);
  const ciphertext = data.slice(12);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    accountKey,
    ciphertext
  );
  return new TextDecoder().decode(plaintext);
}

/**
 * Compute SHA-256 hash of data, returned as hex string.
 */
export async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return bytesToHex(new Uint8Array(hashBuffer));
}
