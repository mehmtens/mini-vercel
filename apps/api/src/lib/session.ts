import crypto from 'crypto';
import { redisConnection } from './queue';
import { prisma } from '@doplo/database';
import { encrypt, decrypt } from '@doplo/crypto';
import { config } from '@doplo/config';

const SESSION_PREFIX = 'session:';
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days

export interface SessionData {
  userId: string;
  username: string;
  createdAt: number;
}

/**
 * Creates a cryptographically secure random session ID and stores in Redis
 */
export async function createSession(userId: string, username: string): Promise<string> {
  const sessionId = crypto.randomUUID();
  const sessionData: SessionData = {
    userId,
    username,
    createdAt: Date.now(),
  };

  try {
    if (redisConnection.status === 'wait') {
      await redisConnection.connect();
    }
    await redisConnection.set(
      `${SESSION_PREFIX}${sessionId}`,
      JSON.stringify(sessionData),
      'EX',
      SESSION_TTL_SECONDS
    );
  } catch (err: any) {
    console.warn('[Session] Redis session write fallback:', err.message);
  }

  return sessionId;
}

/**
 * Retrieves session data from Redis given a sessionId
 */
export async function getSession(sessionId: string): Promise<SessionData | null> {
  if (!sessionId) return null;

  try {
    if (redisConnection.status === 'wait') {
      await redisConnection.connect();
    }
    const raw = await redisConnection.get(`${SESSION_PREFIX}${sessionId}`);
    if (!raw) return null;
    return JSON.parse(raw) as SessionData;
  } catch {
    return null;
  }
}

/**
 * Invalidates and destroys a session in Redis
 */
export async function destroySession(sessionId: string): Promise<void> {
  if (!sessionId) return;

  try {
    if (redisConnection.status === 'wait') {
      await redisConnection.connect();
    }
    await redisConnection.del(`${SESSION_PREFIX}${sessionId}`);
  } catch {}
}

/**
 * Encrypts and saves a user's GitHub access token into the database
 */
export async function storeUserGitHubToken(userId: string, token: string): Promise<void> {
  if (!userId || !token) return;

  const { encryptedValue, iv, tag } = encrypt(token, config.crypto.masterKey);

  await prisma.user.update({
    where: { id: userId },
    data: {
      encryptedAccessToken: encryptedValue,
      accessTokenIv: iv,
      accessTokenTag: tag,
    },
  });
}

/**
 * Retrieves and decrypts the user's GitHub access token from the database
 * Returns null if user has no token or if decryption fails (fail-closed)
 */
export async function getUserGitHubToken(userId: string): Promise<string | null> {
  if (!userId) return null;

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      encryptedAccessToken: true,
      accessTokenIv: true,
      accessTokenTag: true,
    },
  });

  if (!user?.encryptedAccessToken || !user?.accessTokenIv) {
    return null;
  }

  try {
    return decrypt(
      user.encryptedAccessToken,
      user.accessTokenIv,
      config.crypto.masterKey,
      user.accessTokenTag || undefined
    );
  } catch (err: any) {
    console.error('[Crypto] Failed to decrypt user GitHub access token (fail-closed):', err.message);
    return null;
  }
}
