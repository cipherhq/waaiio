/**
 * #1131: sendOrEmail's SMS fallback is charged through sendBusinessSms, only
 * after both WhatsApp and email failed, with the caller's business and key.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ sms: vi.fn(), email: vi.fn() }));
vi.mock('@/lib/sms/send', () => ({ sendBusinessSms: m.sms }));
vi.mock('@/lib/email/client', () => ({ sendEmail: m.email }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
import { sendOrEmail } from '@/lib/channels/send-or-email';

const failingSender = { sendText: vi.fn(async () => ({ success: false })) } as never;
const okSender = { sendText: vi.fn(async () => ({ success: true })) } as never;
const db = {} as never;
const fallback = { businessId: 'biz-1', idempotencyKey: 'booking-reminder:b1:24h' };

beforeEach(() => {
  vi.clearAllMocks();
  m.sms.mockResolvedValue({ status: 'sent', pages: 1, priceMinor: 838, currency: 'NGN' });
  m.email.mockResolvedValue({ success: false });
});

describe('sendOrEmail SMS fallback (#1131)', () => {
  it('charges the SMS to the given business with its key when WhatsApp and email both fail', async () => {
    const r = await sendOrEmail({ supabase: db, sender: failingSender, to: '2348031234567', text: 'Reminder', email: { address: 'a@x.test', subject: 's', html: 'h' }, smsFallback: fallback });
    expect(r.sms).toBe('sent');
    expect(m.sms).toHaveBeenCalledWith(db, { businessId: 'biz-1', phone: '2348031234567', text: 'Reminder', purpose: 'reminder', idempotencyKey: 'booking-reminder:b1:24h' });
  });

  it('passes the notice purpose through', async () => {
    await sendOrEmail({ supabase: db, sender: failingSender, to: '2348031234567', text: 'Payment failed', smsFallback: { ...fallback, purpose: 'notice' } });
    expect(m.sms).toHaveBeenCalledWith(db, expect.objectContaining({ purpose: 'notice' }));
  });

  it('never texts when WhatsApp or email succeeded, or without a fallback', async () => {
    await sendOrEmail({ supabase: db, sender: okSender, to: '2348031234567', text: 'x', smsFallback: fallback });
    m.email.mockResolvedValue({ success: true });
    await sendOrEmail({ supabase: db, sender: failingSender, to: '2348031234567', text: 'x', email: { address: 'a@x.test', subject: 's', html: 'h' }, smsFallback: fallback });
    await sendOrEmail({ supabase: db, sender: failingSender, to: '2348031234567', text: 'x' });
    expect(m.sms).not.toHaveBeenCalled();
  });

  it('maps skips and failures', async () => {
    const run = async () => (await sendOrEmail({ supabase: db, sender: failingSender, to: '2348031234567', text: 'x', smsFallback: fallback })).sms;
    m.sms.mockResolvedValueOnce({ status: 'skipped', reason: 'other_country' });
    expect(await run()).toBe('not_eligible');
    m.sms.mockResolvedValueOnce({ status: 'skipped', reason: 'insufficient_credit' });
    expect(await run()).toBe('skipped');
    m.sms.mockResolvedValueOnce({ status: 'duplicate', previous: 'accepted' });
    expect(await run()).toBe('skipped');
    m.sms.mockResolvedValueOnce({ status: 'failed', reason: 'SMS refused' });
    expect(await run()).toBe('failed');
  });
});
