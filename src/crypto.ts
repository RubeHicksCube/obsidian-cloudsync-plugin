/**
 * Client-side AES-256-GCM encryption using Web Crypto API.
 *
 * Key derivation: PBKDF2 with 100,000 iterations, SHA-256, random 16-byte salt.
 * Encryption: AES-256-GCM with random 12-byte IV.
 *
 * Encrypted format: [salt (16 bytes)] [iv (12 bytes)] [ciphertext + auth tag]
 *
 * The salt is only used on first key derivation and stored in plugin settings
 * so the same key is derived each time. The IV is unique per encryption.
 */

const PBKDF2_ITERATIONS = 100_000;
const SALT_LENGTH = 16;
const IV_LENGTH = 12;

export class CryptoEngine {
  private cachedKey: CryptoKey | null = null;
  private cachedPassphrase: string = "";
  private cachedSaltHex: string = "";

  /**
   * Derive an AES-256-GCM key from a passphrase and salt.
   */
  private async deriveKey(
    passphrase: string,
    salt: Uint8Array
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
        iterations: PBKDF2_ITERATIONS,
        hash: "SHA-256",
      },
      keyMaterial,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"]
    );
  }

  /**
   * Get or derive the encryption key, caching it for performance.
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
    this.cachedKey = await this.deriveKey(passphrase, salt);
    this.cachedPassphrase = passphrase;
    this.cachedSaltHex = saltHex;
    return this.cachedKey;
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
   * Returns: IV (12 bytes) + ciphertext (includes GCM auth tag).
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

    // Prepend IV to ciphertext
    const result = new Uint8Array(IV_LENGTH + ciphertext.byteLength);
    result.set(iv, 0);
    result.set(new Uint8Array(ciphertext), IV_LENGTH);

    return result.buffer;
  }

  /**
   * Decrypt data that was encrypted with encrypt().
   * Expects: IV (12 bytes) + ciphertext (includes GCM auth tag).
   */
  async decrypt(
    encryptedData: ArrayBuffer,
    passphrase: string,
    saltHex: string
  ): Promise<ArrayBuffer> {
    const key = await this.getKey(passphrase, saltHex);
    const dataView = new Uint8Array(encryptedData);

    if (dataView.byteLength < IV_LENGTH + 1) {
      throw new Error("Encrypted data is too short");
    }

    const iv = dataView.slice(0, IV_LENGTH);
    const ciphertext = dataView.slice(IV_LENGTH);

    try {
      return await crypto.subtle.decrypt(
        { name: "AES-GCM", iv },
        key,
        ciphertext
      );
    } catch {
      throw new Error(
        "Decryption failed. The passphrase may be incorrect or the data is corrupted."
      );
    }
  }

  /**
   * Clear the cached key (e.g., when passphrase changes).
   */
  clearCache(): void {
    this.cachedKey = null;
    this.cachedPassphrase = "";
    this.cachedSaltHex = "";
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

/**
 * Compute SHA-256 hash of data, returned as hex string.
 */
export async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return bytesToHex(new Uint8Array(hashBuffer));
}
