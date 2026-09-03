import { describe, it, expect } from 'vitest';
import {
  encrypt,
  decrypt,
  verifyGitHubWebhookSignature,
  createHmacSignature,
  generateUuid,
  generateId,
  generateCommitHash,
  hashData,
  generateSecureToken,
  isValidMasterKey,
  generateMasterKey,
} from './index';

describe('@doplo/crypto Unit Tests', () => {
  // Canonical 64-character hex master key (32 bytes)
  const canonicalMasterKey = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  const sampleSecret = 'DATABASE_URL=postgresql://user:pass@localhost:5432/db';

  describe('Master Key Format Validation', () => {
    it('validates 64-hex character master key correctly', () => {
      expect(isValidMasterKey(canonicalMasterKey)).toBe(true);
      expect(isValidMasterKey(generateMasterKey())).toBe(true);
      expect(isValidMasterKey('short-key')).toBe(false);
      expect(isValidMasterKey('0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdeg')).toBe(false); // invalid hex char 'g'
      expect(isValidMasterKey('')).toBe(false);
    });
  });

  describe('AES-256-GCM Encryption & Decryption', () => {
    it('encrypts and decrypts secret plaintext correctly with canonical 64-hex key', () => {
      const { encryptedValue, iv, tag } = encrypt(sampleSecret, canonicalMasterKey);

      expect(encryptedValue).toBeDefined();
      expect(iv).toHaveLength(32); // 16 bytes = 32 hex chars
      expect(tag).toHaveLength(32); // 16 bytes = 32 hex chars

      // Decrypt using composite string
      const decrypted = decrypt(encryptedValue, iv, canonicalMasterKey);
      expect(decrypted).toBe(sampleSecret);

      // Decrypt using explicit tag
      const parts = encryptedValue.split(':');
      const decryptedExplicit = decrypt(parts[0], iv, canonicalMasterKey, tag);
      expect(decryptedExplicit).toBe(sampleSecret);
    });

    it('generates unique IVs on consecutive encryptions of the same plaintext', () => {
      const enc1 = encrypt(sampleSecret, canonicalMasterKey);
      const enc2 = encrypt(sampleSecret, canonicalMasterKey);

      expect(enc1.iv).not.toBe(enc2.iv);
      expect(enc1.encryptedValue).not.toBe(enc2.encryptedValue);
    });

    it('throws error when decrypting with incorrect master key (auth tag check fails)', () => {
      const { encryptedValue, iv } = encrypt(sampleSecret, canonicalMasterKey);
      const wrongKey = 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210';

      expect(() => decrypt(encryptedValue, iv, wrongKey)).toThrow();
    });

    it('throws error when ciphertext is tampered', () => {
      const { encryptedValue, iv } = encrypt(sampleSecret, canonicalMasterKey);
      const tampered = '00' + encryptedValue.slice(2);

      expect(() => decrypt(tampered, iv, canonicalMasterKey)).toThrow();
    });

    it('throws error on empty inputs', () => {
      expect(() => encrypt('', canonicalMasterKey)).toThrow();
      expect(() => decrypt('', 'iv', canonicalMasterKey)).toThrow();
    });
  });

  describe('GitHub Webhook HMAC-SHA256 Verification', () => {
    const webhookSecret = 'my-webhook-secret-key-xyz';
    const payload = JSON.stringify({
      ref: 'refs/heads/main',
      head_commit: {
        id: '9f8e7d6c5b4a',
        message: 'feat: add awesome feature',
      },
      repository: {
        name: 'my-app',
        full_name: 'octocat/my-app',
        clone_url: 'https://github.com/octocat/my-app.git',
      },
    });

    it('verifies valid signature with sha256= prefix', () => {
      const signature = 'sha256=' + createHmacSignature(payload, webhookSecret);
      const isValid = verifyGitHubWebhookSignature(payload, signature, webhookSecret);
      expect(isValid).toBe(true);
    });

    it('verifies valid signature without sha256= prefix', () => {
      const rawHexSignature = createHmacSignature(payload, webhookSecret);
      const isValid = verifyGitHubWebhookSignature(payload, rawHexSignature, webhookSecret);
      expect(isValid).toBe(true);
    });

    it('verifies Buffer payload directly', () => {
      const bufferPayload = Buffer.from(payload, 'utf8');
      const signature = 'sha256=' + createHmacSignature(payload, webhookSecret);
      const isValid = verifyGitHubWebhookSignature(bufferPayload, signature, webhookSecret);
      expect(isValid).toBe(true);
    });

    it('rejects invalid signature', () => {
      const invalidSignature = 'sha256=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
      const isValid = verifyGitHubWebhookSignature(payload, invalidSignature, webhookSecret);
      expect(isValid).toBe(false);
    });

    it('rejects signature with incorrect secret', () => {
      const signature = 'sha256=' + createHmacSignature(payload, webhookSecret);
      const isValid = verifyGitHubWebhookSignature(payload, signature, 'wrong-secret');
      expect(isValid).toBe(false);
    });

    it('returns false on missing or malformed inputs', () => {
      expect(verifyGitHubWebhookSignature('', 'sig', webhookSecret)).toBe(false);
      expect(verifyGitHubWebhookSignature(payload, undefined, webhookSecret)).toBe(false);
      expect(verifyGitHubWebhookSignature(payload, '', webhookSecret)).toBe(false);
    });
  });

  describe('Identifier & Hash Generators', () => {
    it('generates valid RFC4122 UUID v4', () => {
      const uuid = generateUuid();
      expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    });

    it('generates prefixed ID', () => {
      const id = generateId('dpl', 10);
      expect(id.startsWith('dpl_')).toBe(true);
      expect(id.length).toBe(14); // 'dpl_' (4) + 10 chars
    });

    it('generates 7-character commit hash', () => {
      const commit = generateCommitHash();
      expect(commit).toHaveLength(7);
    });

    it('hashes data with sha256', () => {
      const hash = hashData('hello-doplo');
      expect(hash).toHaveLength(64);
    });

    it('generates secure random token', () => {
      const token = generateSecureToken(16);
      expect(token).toHaveLength(32);
    });
  });
});
