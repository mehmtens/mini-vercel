import { describe, expect, it } from 'vitest';
import { hashPassword, normalizeEmail, verifyPassword } from './auth-utils';

describe('password authentication utilities', () => {
  it('normalizes email addresses', () => {
    expect(normalizeEmail('  User@Example.COM ')).toBe('user@example.com');
  });

  it('hashes passwords with a random salt and verifies safely', async () => {
    const first = await hashPassword('a-secure-password');
    const second = await hashPassword('a-secure-password');
    expect(first).not.toContain('a-secure-password');
    expect(first).not.toBe(second);
    await expect(verifyPassword('a-secure-password', first)).resolves.toBe(true);
    await expect(verifyPassword('wrong-password', first)).resolves.toBe(false);
  });

  it('rejects malformed hashes', async () => {
    await expect(verifyPassword('password', 'not-a-valid-hash')).resolves.toBe(false);
  });
});
