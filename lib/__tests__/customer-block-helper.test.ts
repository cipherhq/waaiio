/**
 * #1166 S6 / F12 / F14: the shared customer block check (lib/customer-block.ts)
 * over an in-memory database. Phone forms typed on the website map to the bot
 * key; emails are trimmed and lower-cased only; the web gate fails open and
 * reports, the email-send check fails closed; logs never carry the phone or
 * email.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMemoryDb } from './helpers/memory-db';

const logged: Array<{ ctx: Record<string, unknown>; level: string; msg: string }> = [];
vi.mock('@/lib/logger', () => {
  const make = (ctx: Record<string, unknown>) => ({
    info: (msg: string) => logged.push({ ctx, level: 'info', msg }),
    warn: (msg: string) => logged.push({ ctx, level: 'warn', msg }),
    error: (msg: string) => logged.push({ ctx, level: 'error', msg }),
    debug: () => {},
    withContext: (more: Record<string, unknown>) => make({ ...ctx, ...more }),
  });
  return { logger: make({}) };
});
const reportFailure = vi.fn();
vi.mock('@/lib/observability/report-failure', () => ({ reportFailure: (...a: unknown[]) => reportFailure(...a) }));

import {
  CUSTOMER_BLOCKED_WEB_TEXT, normalizeBlockEmail, customerPhoneBlockKey, customerBlockStatus,
  webCheckoutBlocked, customerEmailSendBlocked,
} from '../customer-block';
import { canonicalCustomerPhone } from '../customer-suspension';

const BIZ = '11111111-1111-4111-8111-111111111111';
const PHONE = '2348012345678';
const EMAIL = 'ann@example.com';

function db(opts: { phones?: string[]; emails?: string[]; fail?: string[] } = {}) {
  const d = createMemoryDb({
    customer_suspensions: (opts.phones ?? []).map(phone => ({ phone, reason: 'abuse' })),
    customer_email_blocks: (opts.emails ?? []).map(email => ({ email, reason: 'abuse' })),
  });
  for (const t of opts.fail ?? []) d.failReads.add(t);
  return d as any;
}

function noAddressLogged() {
  const text = JSON.stringify(logged) + JSON.stringify(reportFailure.mock.calls);
  expect(text).not.toContain(PHONE);
  expect(text).not.toContain('8012345678');
  expect(text.toLowerCase()).not.toContain(EMAIL);
}

beforeEach(() => { logged.length = 0; reportFailure.mockReset(); });

describe('wording', () => {
  it('is the Owner-approved neutral refusal', () => {
    expect(CUSTOMER_BLOCKED_WEB_TEXT).toBe("This service isn't available. If you think this is a mistake, contact support@waaiio.com");
  });
});

describe('normalizeBlockEmail (Q11 A)', () => {
  it('trims and lower-cases only', () => {
    expect(normalizeBlockEmail('  Ann@Example.COM ')).toBe(EMAIL);
    expect(normalizeBlockEmail('ann.smith+shop@gmail.com')).toBe('ann.smith+shop@gmail.com');
  });
  it('rejects values that cannot be an email', () => {
    for (const v of ['', '   ', 'ann', 'ann@example', 'a b@example.com', 'a@b@example.com', `${'a'.repeat(250)}@x.co`, null, 42, undefined]) {
      expect(normalizeBlockEmail(v)).toBeNull();
    }
  });
});

describe('customerPhoneBlockKey (S6)', () => {
  it('maps international, local, 00 and spaced forms to the bot key', () => {
    for (const raw of ['+2348012345678', '2348012345678', '+234 801 234 5678', '00234 801 234 5678', '(0801) 234-5678', '08012345678', '8012345678']) {
      expect(customerPhoneBlockKey(raw, 'NG')).toBe(PHONE);
    }
  });
  it('falls back to the typed digits when the phone library rejects the number', () => {
    // Numbers libphonenumber rejects (canonicalCustomerPhone returns null).
    expect(canonicalCustomerPhone('+234 100 000 0000', 'NG')).toBeNull();
    expect(customerPhoneBlockKey('+234 100 000 0000', 'NG')).toBe('2341000000000');
    expect(canonicalCustomerPhone('+1 200 123 4567', 'NG')).toBeNull();
    expect(customerPhoneBlockKey('+1 200 123 4567', 'NG')).toBe('12001234567');
  });
  it('returns null when nothing canonical can be made', () => {
    for (const raw of ['', '  ', '12345', '080', null, 7]) expect(customerPhoneBlockKey(raw, 'NG')).toBeNull();
    // A local number with no country cannot be read.
    expect(customerPhoneBlockKey('08012345678', null)).toBeNull();
  });
});

describe('customerBlockStatus', () => {
  it('matches a blocked phone typed in any form, and a blocked email in any case', async () => {
    const d = db({ phones: [PHONE], emails: [EMAIL] });
    expect(await customerBlockStatus(d, { phone: '0801 234 5678', countryCode: 'NG' })).toEqual({ status: 'blocked', matched: 'phone' });
    expect(await customerBlockStatus(d, { email: ' ANN@example.com ' })).toEqual({ status: 'blocked', matched: 'email' });
    expect(await customerBlockStatus(d, { phone: '+2348099999999', email: 'other@example.com' })).toEqual({ status: 'clear' });
    expect(await customerBlockStatus(d, {})).toEqual({ status: 'clear' });
  });
  it('a match wins over a failed read of the other table', async () => {
    expect(await customerBlockStatus(db({ emails: [EMAIL], fail: ['customer_suspensions'] }), { phone: PHONE, email: EMAIL }))
      .toEqual({ status: 'blocked', matched: 'email' });
    expect(await customerBlockStatus(db({ phones: [PHONE], fail: ['customer_email_blocks'] }), { phone: PHONE, email: EMAIL }))
      .toEqual({ status: 'blocked', matched: 'phone' });
  });
  it('is unknown when a read fails and nothing matched', async () => {
    expect(await customerBlockStatus(db({ fail: ['customer_email_blocks'] }), { email: EMAIL })).toEqual({ status: 'unknown' });
    expect(await customerBlockStatus(db({ fail: ['customer_suspensions'] }), { phone: PHONE })).toEqual({ status: 'unknown' });
  });
  it('only reads', async () => {
    const d = db({ phones: [PHONE], emails: [EMAIL] });
    await customerBlockStatus(d, { phone: PHONE, email: EMAIL });
    expect(d.writes).toEqual([]);
  });
});

describe('webCheckoutBlocked (F9, F12, F14)', () => {
  it('refuses a blocked phone or email and logs customer_block.refused without the value', async () => {
    const d = db({ phones: [PHONE], emails: [EMAIL] });
    expect(await webCheckoutBlocked(d, { route: 'bookings/public/create', businessId: BIZ, phone: '08012345678', countryCode: 'NG' })).toBe(true);
    expect(await webCheckoutBlocked(d, { route: 'events/purchase', businessId: BIZ, email: 'Ann@Example.com' })).toBe(true);
    expect(logged.filter(l => l.msg === 'customer_block.refused').map(l => l.ctx)).toEqual([
      { op: 'customer_block.refused', route: 'bookings/public/create', business_id: BIZ, matched: 'phone' },
      { op: 'customer_block.refused', route: 'events/purchase', business_id: BIZ, matched: 'email' },
    ]);
    noAddressLogged();
  });
  it('lets a clear customer through with no log', async () => {
    expect(await webCheckoutBlocked(db({ phones: [PHONE] }), { route: 'r', businessId: BIZ, phone: '+2348099999999', email: 'x@example.com' })).toBe(false);
    expect(logged).toEqual([]);
    expect(reportFailure).not.toHaveBeenCalled();
  });
  it('fails open on a read error and reports it without the value (Q10 A)', async () => {
    expect(await webCheckoutBlocked(db({ fail: ['customer_suspensions', 'customer_email_blocks'] }),
      { route: 'r', businessId: BIZ, phone: PHONE, email: EMAIL })).toBe(false);
    expect(reportFailure).toHaveBeenCalledTimes(1);
    expect(reportFailure.mock.calls[0][1]).toEqual({ area: 'customer_block', op: 'web_checkout_check', businessId: BIZ });
    noAddressLogged();
  });
});

describe('customerEmailSendBlocked (F15, F16, F12)', () => {
  it('skips a blocked email, and the email copy for a blocked phone', async () => {
    const d = db({ phones: [PHONE], emails: [EMAIL] });
    expect(await customerEmailSendBlocked(d, { send: 'booking_reminder', businessId: BIZ, email: 'ANN@example.com' })).toBe(true);
    expect(await customerEmailSendBlocked(d, { send: 'booking_reminder', businessId: BIZ, email: 'other@example.com', phone: '+234 801 234 5678' })).toBe(true);
    expect(await customerEmailSendBlocked(d, { send: 'booking_reminder', businessId: BIZ, email: 'other@example.com', phone: '2348099999999' })).toBe(false);
    expect(logged.filter(l => l.msg === 'customer_block.email_skipped').map(l => l.ctx)).toEqual([
      { op: 'customer_block.email_skipped', send: 'booking_reminder', business_id: BIZ },
      { op: 'customer_block.email_skipped', send: 'booking_reminder', business_id: BIZ },
    ]);
    noAddressLogged();
  });
  it('sends without a read when there is nothing to check', async () => {
    const d = db({ fail: ['customer_suspensions', 'customer_email_blocks'] });
    expect(await customerEmailSendBlocked(d, { send: 's', email: 'not an email', phone: '0801' })).toBe(false);
    expect(reportFailure).not.toHaveBeenCalled();
  });
  it('fails closed on a read error: the email is skipped, logged and reported', async () => {
    expect(await customerEmailSendBlocked(db({ fail: ['customer_email_blocks'] }), { send: 's', businessId: BIZ, email: EMAIL })).toBe(true);
    expect(reportFailure).toHaveBeenCalledTimes(1);
    expect(reportFailure.mock.calls[0][1]).toMatchObject({ area: 'customer_block', op: 'email_send_check', businessId: BIZ });
    expect(logged.some(l => l.msg === 'customer_block.email_skipped')).toBe(true);
    noAddressLogged();
  });
});
