import crypto from 'crypto';
import { FastifyReply } from 'fastify';
import { createSession } from './session';
import { config } from '@doplo/config';

const PASSWORD_KEY_LENGTH = 64;

export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

export function isValidEmail(value: string): boolean {
  return value.length <= 255 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

export function usernameFromIdentity(email: string, displayName?: string): string {
  const source = (displayName || email.split('@')[0] || 'user').trim();
  const normalized = source.replace(/[^a-zA-Z0-9_.-]/g, '_').replace(/_+/g, '_');
  return (normalized || 'user').slice(0, 128);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const derived = await new Promise<Buffer>((resolve, reject) => {
    crypto.scrypt(password, salt, PASSWORD_KEY_LENGTH, (error, key) => {
      if (error) reject(error);
      else resolve(key as Buffer);
    });
  });
  return `scrypt$${salt.toString('base64url')}$${derived.toString('base64url')}`;
}

export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  const [algorithm, saltValue, hashValue] = storedHash.split('$');
  if (algorithm !== 'scrypt' || !saltValue || !hashValue) return false;

  try {
    const salt = Buffer.from(saltValue, 'base64url');
    const expected = Buffer.from(hashValue, 'base64url');
    if (expected.length !== PASSWORD_KEY_LENGTH) return false;
    const actual = await new Promise<Buffer>((resolve, reject) => {
      crypto.scrypt(password, salt, PASSWORD_KEY_LENGTH, (error, key) => {
        if (error) reject(error);
        else resolve(key as Buffer);
      });
    });
    return crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

export async function issueSessionCookie(
  reply: FastifyReply,
  user: { id: string; username: string },
): Promise<string> {
  const sessionId = await createSession(user.id, user.username);
  reply.setCookie('mini_session', sessionId, {
    path: '/',
    httpOnly: true,
    secure: config.isProduction,
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60,
    signed: true,
  });
  return sessionId;
}
