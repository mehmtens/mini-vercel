import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ set: vi.fn(), del: vi.fn(), getdel: vi.fn(), updateMany: vi.fn() }));
vi.mock('./queue', () => ({ redisConnection: mocks }));
vi.mock('@doplo/database', () => ({ prisma: { user: { updateMany: mocks.updateMany } } }));
import { sendVerification, consumeVerification } from './email-verification';

describe('email verification', () => {
  beforeEach(() => { vi.resetAllMocks(); vi.stubEnv('BREVO_API_KEY', 'test-only'); vi.stubEnv('MAIL_FROM_EMAIL', 'noreply@doplo.test'); });
  it('stores only a token digest, with expiry, and sends the token through Brevo', async () => {
    mocks.set.mockResolvedValue('OK');
    const fetchMock = vi.fn().mockResolvedValue({ ok: true }); vi.stubGlobal('fetch', fetchMock);
    await sendVerification({ id: 'test-id', email: 'user@example.test' });
    const key = mocks.set.mock.calls[1][0];
    expect(key).toMatch(/^verify-email:[a-f0-9]{64}$/);
    expect(mocks.set.mock.calls[1][3]).toBe(1800);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.textContent).toContain('/login#verify=');
    expect(body.textContent).not.toContain(key.slice('verify-email:'.length));
  });
  it('fails closed on delivery errors and removes the unused token', async () => {
    mocks.set.mockResolvedValue('OK'); vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));
    await expect(sendVerification({ id: 'test-id', email: 'user@example.test' })).rejects.toThrow('could not be sent');
    expect(mocks.del).toHaveBeenCalledOnce();
  });
  it('rejects malformed, expired and replayed tokens', async () => {
    expect(await consumeVerification('bad')).toBe(false);
    mocks.getdel.mockResolvedValueOnce(JSON.stringify({ id: 'test-id', email: 'user@example.test' })).mockResolvedValue(null);
    mocks.updateMany.mockResolvedValue({ count: 1 });
    expect(await consumeVerification('a'.repeat(64))).toBe(true);
    expect(await consumeVerification('a'.repeat(64))).toBe(false);
    expect(mocks.updateMany).toHaveBeenCalledOnce();
  });
});
