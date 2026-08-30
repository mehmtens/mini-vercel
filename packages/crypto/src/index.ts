import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16; // 128-bit IV for AES-GCM
const TAG_LENGTH = 16; // 128-bit authentication tag

export const MASTER_KEY_HEX_REGEX = /^[0-9a-fA-F]{64}$/;

/**
 * Validates whether a master key string matches the canonical 64-hex character (32-byte) format
 */
export function isValidMasterKey(masterKey: string): boolean {
  return typeof masterKey === 'string' && MASTER_KEY_HEX_REGEX.test(masterKey.trim());
}

/**
 * Generates a canonical 64-hex character (32-byte) master key
 */
export function generateMasterKey(): string {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Derives a consistent 32-byte key buffer from a 64-hex character master key
 * Falls back safely to SHA-256 if non-hex key is provided
 */
export function deriveKey(masterKey: string): Buffer {
  if (!masterKey) {
    throw new Error('Master key is required for cryptographic operations');
  }

  const trimmed = masterKey.trim();
  if (isValidMasterKey(trimmed)) {
    return Buffer.from(trimmed, 'hex');
  }

  // Fallback digest for arbitrary strings
  return crypto.createHash('sha256').update(trimmed, 'utf8').digest();
}

/**
 * Encrypts a plaintext string using AES-256-GCM
 * Returns composite encryptedValue (ciphertext:tag in hex) and iv in hex
 */
export function encrypt(
  text: string,
  masterKey: string
): { encryptedValue: string; iv: string; tag: string } {
  if (!text) {
    throw new Error('Plaintext cannot be empty');
  }
  if (!masterKey) {
    throw new Error('Master key is required for encryption');
  }

  const key = deriveKey(masterKey);
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');

  const tag = cipher.getAuthTag();
  const tagHex = tag.toString('hex');
  const ivHex = iv.toString('hex');

  // Format: ciphertext:tag for easy composite storage
  const encryptedValue = `${encrypted}:${tagHex}`;

  return {
    encryptedValue,
    iv: ivHex,
    tag: tagHex,
  };
}

/**
 * Decrypts an AES-256-GCM encrypted string with authentication tag validation
 */
export function decrypt(
  encryptedText: string,
  iv: string,
  masterKey: string,
  tag?: string
): string {
  if (!encryptedText || !iv || !masterKey) {
    throw new Error('encryptedText, iv, and masterKey are required for decryption');
  }

  let ciphertextHex = encryptedText;
  let tagHex = tag;

  // Handle composite format ciphertext:tag
  if (!tagHex && encryptedText.includes(':')) {
    const parts = encryptedText.split(':');
    ciphertextHex = parts[0];
    tagHex = parts[1];
  }

  if (!tagHex) {
    throw new Error('Authentication tag is missing for AES-GCM decryption');
  }

  const key = deriveKey(masterKey);
  const ivBuffer = Buffer.from(iv, 'hex');
  const tagBuffer = Buffer.from(tagHex, 'hex');

  const decipher = crypto.createDecipheriv(ALGORITHM, key, ivBuffer);
  decipher.setAuthTag(tagBuffer);

  let decrypted = decipher.update(ciphertextHex, 'hex', 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
}

/**
 * Verifies a GitHub Webhook HMAC-SHA256 signature against the raw request body
 * Handles 'sha256=' prefix and uses constant-time comparison
 */
export function verifyGitHubWebhookSignature(
  rawBody: string | Buffer,
  signature: string | undefined | null,
  secret: string
): boolean {
  if (!rawBody || !signature || !secret) {
    return false;
  }

  try {
    const cleanSignature = signature.startsWith('sha256=')
      ? signature.slice(7)
      : signature;

    const bodyBuffer = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody, 'utf8');
    const hmac = crypto.createHmac('sha256', secret);
    hmac.update(bodyBuffer);
    const expectedSignature = hmac.digest('hex');

    const expectedBuffer = Buffer.from(expectedSignature, 'hex');
    const actualBuffer = Buffer.from(cleanSignature, 'hex');

    if (expectedBuffer.length !== actualBuffer.length) {
      return false;
    }

    return crypto.timingSafeEqual(expectedBuffer, actualBuffer);
  } catch {
    return false;
  }
}

/**
 * Generates a standard RFC4122 UUID v4
 */
export function generateUuid(): string {
  return crypto.randomUUID();
}

/**
 * Generates a prefixed unique ID (e.g., dpl_3f8a9b1c2d3e or prj_9a8b7c6d5e4f)
 */
export function generateId(prefix: string = 'id', length: number = 12): string {
  const randomHex = crypto.randomBytes(Math.ceil(length / 2)).toString('hex').slice(0, length);
  return `${prefix}_${randomHex}`;
}

/**
 * Generates a short simulated 7-character Git commit hash
 */
export function generateCommitHash(): string {
  return crypto.randomBytes(4).toString('hex').slice(0, 7);
}

/**
 * Calculates SHA-256 hash of a string or buffer
 */
export function hashData(data: string | Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/**
 * Generates a cryptographically secure random token (e.g. for webhooks or API tokens)
 */
export function generateSecureToken(bytes: number = 32): string {
  return crypto.randomBytes(bytes).toString('hex');
}

/**
 * Creates an HMAC SHA-256 signature for payload verification
 */
export function createHmacSignature(payload: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

/**
 * Validates HMAC SHA-256 signature in constant time
 */
export function verifyHmacSignature(payload: string, signature: string, secret: string): boolean {
  const expected = createHmacSignature(payload, secret);
  if (expected.length !== signature.length) {
    return false;
  }
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}
