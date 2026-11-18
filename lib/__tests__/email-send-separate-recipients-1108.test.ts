/**
 * #1108: a broadcast email is sent as one separate email per recipient, so
 * no recipient can see another's address, and the reply counts what the
 * provider accepted.
 *
 * Part 1 runs the real sendEmailToEach with a fake Resend client.
 * Part 2 runs the real /api/email/send handler with the sender mocked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const r = vi.hoisted(() => ({ batch: vi.fn(), single: vi.fn() }));
vi.mock('resend', () => ({
  Resend: class { batch = { send: r.batch }; emails = { send: r.single }; },
}));
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }));

describe('sendEmailToEach (real implementation, fake provider)', () => {
  beforeEach(() => { vi.resetModules(); r.batch.mockReset(); vi.stubEnv('RESEND_API_KEY', 're_test_synthetic'); });
  afterEach(() => vi.unstubAllEnvs());

  it('sends every recipient their own email, 100 per batch, never one email to many', async () => {
    r.batch.mockImplementation(async (emails: unknown[]) => ({ data: { data: emails.map((_, i) => ({ id: `e${i}` })) }, error: null }));
    const { sendEmailToEach } = await import('@/lib/email/client');
    const to = Array.from({ length: 205 }, (_, i) => `user${i}@example.test`);
    expect(await sendEmailToEach({ to, subject: 'S', html: '<p>H</p>' })).toEqual({ accepted: 205, failed: 0 });
    expect(r.batch.mock.calls.map(([emails]) => emails.length)).toEqual([100, 100, 5]);
    const sent = r.batch.mock.calls.flatMap(([emails]) => emails as Array<{ to: string[] }>);
    expect(sent.every(e => e.to.length === 1)).toBe(true);
    expect(sent.map(e => e.to[0])).toEqual(to);
    expect(r.single).not.toHaveBeenCalled();
  });

  it('counts a failed batch as failed and does not retry it', async () => {
    r.batch
      .mockResolvedValueOnce({ data: { data: Array.from({ length: 100 }, (_, i) => ({ id: `e${i}` })) }, error: null })
      .mockResolvedValueOnce({ data: null, error: { statusCode: 500, message: 'down' } });
    const { sendEmailToEach } = await import('@/lib/email/client');
    const to = Array.from({ length: 150 }, (_, i) => `u${i}@example.test`);
    expect(await sendEmailToEach({ to, subject: 'S', html: 'H' })).toEqual({ accepted: 100, failed: 50 });
    expect(r.batch).toHaveBeenCalledTimes(2);
  });

  it('counts emails the provider rejected inside a batch', async () => {
    r.batch.mockResolvedValue({ data: { data: [{ id: 'a' }], errors: [{ index: 1, message: 'invalid' }] }, error: null });
    const { sendEmailToEach } = await import('@/lib/email/client');
    expect(await sendEmailToEach({ to: ['a@example.test', 'b@example.test'], subject: 'S', html: 'H' })).toEqual({ accepted: 1, failed: 1 });
  });
});

describe('POST /api/email/send with a recipient list', () => {
  const m = { toEach: vi.fn(), send: vi.fn(), audits: [] as unknown[] };
  let POST: (req: NextRequest) => Promise<Response>;
  beforeEach(async () => {
    vi.resetModules();
    m.toEach.mockReset(); m.send.mockReset(); m.audits = [];
    vi.doMock('@/lib/email/client', () => ({ sendEmail: m.send, sendEmailToEach: m.toEach }));
    vi.doMock('@/lib/rate-limit', () => ({ rateLimitResponseAsync: async () => null, getRateLimitKey: () => 'k' }));
    vi.doMock('@/lib/admin-auth', () => ({ requirePlatformAdmin: async () => ({ userId: 'admin-1', role: 'admin' }) }));
    vi.doMock('@/lib/admin-audit', () => ({ logAdminAudit: async (e: unknown) => { m.audits.push(e); return {}; } }));
    ({ POST } = await import('@/app/api/email/send/route'));
  });
  const send = (to: unknown) => POST(new NextRequest('https://www.waaiio.com/api/email/send', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://admin.waaiio.com' },
    body: JSON.stringify({ to, subject: 'News', html: '<p>Hi</p>' }),
  }));

  it('sends each unique recipient separately and reports the accepted count', async () => {
    m.toEach.mockResolvedValue({ accepted: 2, failed: 0 });
    const res = await send(['a@example.test', ' A@example.test ', 'b@example.test']);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, accepted: 2, failed: 0, total: 2 });
    expect(m.toEach).toHaveBeenCalledWith({ to: ['a@example.test', 'b@example.test'], subject: 'News', html: '<p>Hi</p>' });
    expect(m.send).not.toHaveBeenCalled();
    // The audit keeps counts, not the whole address list.
    expect(m.audits[0]).toMatchObject({ details: { subject: 'News', recipient_count: 2, accepted: 2, failed: 0, separate_emails: true } });
  });

  it('reports a partial send with success false and the real counts', async () => {
    m.toEach.mockResolvedValue({ accepted: 1, failed: 1 });
    const res = await send(['a@example.test', 'b@example.test']);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: false, accepted: 1, failed: 1, total: 2 });
  });

  it('reports nothing accepted as an error', async () => {
    m.toEach.mockResolvedValue({ accepted: 0, failed: 2 });
    expect((await send(['a@example.test', 'b@example.test'])).status).toBe(500);
  });

  it('rejects a list with an invalid address before sending anything', async () => {
    expect((await send(['a@example.test', 'not-an-email'])).status).toBe(400);
    expect(m.toEach).not.toHaveBeenCalled();
  });

  it('keeps a single recipient on the existing single-email path', async () => {
    m.send.mockResolvedValue({ success: true });
    expect(await (await send('a@example.test')).json()).toEqual({ success: true });
    expect(m.toEach).not.toHaveBeenCalled();
  });
});
