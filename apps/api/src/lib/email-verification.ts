import crypto from 'crypto';
import { config } from '@doplo/config';
import { prisma } from '@doplo/database';
import { redisConnection } from './queue';

export function mailConfigured() {
  return Boolean(process.env.BREVO_API_KEY && process.env.MAIL_FROM_EMAIL);
}

export async function sendVerification(user: { id: string; email: string }) {
  if (!mailConfigured()) throw Object.assign(new Error('Email delivery is temporarily unavailable.'), { statusCode: 503 });
  const cooldown = `verify-cooldown:${user.id}`;
  if (!await redisConnection.set(cooldown, '1', 'EX', 60, 'NX')) return;
  const token = crypto.randomBytes(32).toString('hex');
  const key = `verify-email:${crypto.createHash('sha256').update(token).digest('hex')}`;
  await redisConnection.set(key, JSON.stringify(user), 'EX', 1800);
  const link = `${config.app.url}/login#verify=${token}`;
  try {
    const response = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': process.env.BREVO_API_KEY!, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sender: { name: 'Doplo', email: process.env.MAIL_FROM_EMAIL },
        to: [{ email: user.email }],
        subject: 'Verify your Doplo email address',
        textContent: `Verify your email to finish creating your Doplo account. This link expires in 30 minutes:\n${link}\nIf you did not request this, ignore this email.`,
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error('Delivery rejected');
  } catch {
    await redisConnection.del(key, cooldown);
    throw Object.assign(new Error('Email could not be sent. Please try again shortly.'), { statusCode: 503 });
  }
}

export async function consumeVerification(token: unknown): Promise<boolean> {
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) return false;
  const key = `verify-email:${crypto.createHash('sha256').update(token).digest('hex')}`;
  const value = await redisConnection.getdel(key);
  if (!value) return false;
  const identity = JSON.parse(value) as { id: string; email: string };
  const result = await prisma.user.updateMany({ where: { id: identity.id, email: identity.email, emailVerified: false }, data: { emailVerified: true } });
  return result.count === 1;
}
