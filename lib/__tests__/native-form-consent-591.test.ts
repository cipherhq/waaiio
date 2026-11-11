import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createMemoryDb, type MemoryDb } from './helpers/memory-db';
import { hasRecipientPermission } from '@/lib/merchants/recipient-permission';
import { hasEmailMarketingPermission, emailMarketingEligibility } from '@/lib/whatsapp-forms/email-consent';
import { requestNativeWhatsAppConsent } from '@/lib/whatsapp-forms/whatsapp-consent';
import { emailUnsubscribeToken } from '@/lib/whatsapp-forms/email-unsubscribe';
import { NextRequest } from 'next/server';
const m = vi.hoisted(() => ({ db: null as unknown as MemoryDb, request: vi.fn() }));
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: () => m.db }));
vi.mock('@/lib/consent/optin-confirmation', async original => ({ ...await original<object>(), sendOptInConfirmationRequest: m.request }));
import { GET, POST } from '@/app/forms/email-unsubscribe/route';
const biz = '22222222-2222-4222-8222-222222222222', phone = '12025550123';
const client = () => m.db as unknown as SupabaseClient;
const consent = (status: string, offset: number, extra: object = {}) => ({ id: String(offset), business_id: biz, phone,
  channel: 'whatsapp', purpose: 'marketing', status, created_at: new Date(Date.now() + offset).toISOString(), ...extra });
beforeEach(() => { m.db = createMemoryDb(); m.request.mockReset(); vi.stubEnv('FLOW_TOKEN_SECRET', 'x'.repeat(64)); });
afterEach(() => vi.unstubAllEnvs());
describe('#591 independent consent authorities', () => {
  it.each([
    ['granted', null, true], ['revoked', null, false], ['unknown', null, false],
    ['granted', '2000-01-01', false],
  ])('pending does not replace effective %s consent with expiry %s', async (status, expires_at, allowed) => {
    m.db.tables.customer_consents = [consent(String(status), 0, { expires_at }), consent('pending', 1)];
    expect(await hasRecipientPermission(client(), biz, phone, 'marketing')).toBe(allowed);
  });
  it('pending alone is not a grant, and STOP wins over a grant', async () => {
    m.db.tables.customer_consents = [consent('pending', 1)];
    expect(await hasRecipientPermission(client(), biz, phone, 'marketing')).toBe(false);
    m.db.tables.customer_consents.push(consent('granted', 2));
    m.db.tables.messaging_opt_outs = [{ phone, business_id: null, channel: 'whatsapp' }];
    expect(await hasRecipientPermission(client(), biz, phone, 'marketing')).toBe(false);
  });
  it('does not insert or send another request for an existing grant', async () => {
    m.db.tables.customer_consents = [consent('granted', 0)];
    await requestNativeWhatsAppConsent(client(), { whatsappRequested: true, businessId: biz, phone } as any, {} as any);
    expect(m.db.writes).toHaveLength(0); expect(m.request).not.toHaveBeenCalled();
  });
  it('an address-bound grant never authorizes another address or legacy phone-only delivery', async () => {
    m.db.tables.customer_consents = [consent('granted', 0, { channel: 'email', email_address: 'a@example.test' })];
    expect(await hasEmailMarketingPermission(client(), biz, 'a@example.test', phone)).toBe(true);
    expect(await hasEmailMarketingPermission(client(), biz, 'b@example.test', phone)).toBe(false);
    expect(await hasRecipientPermission(client(), biz, phone, 'marketing', 'email')).toBe(false);
  });
  it('unsubscribe GET is read-only; each address is suppressed even on another phone and after a new checkbox', async () => {
    const token = emailUnsubscribeToken(biz, 'b@example.test', phone);
    expect((await GET(new NextRequest(`https://example.test/forms/email-unsubscribe?token=${token}`))).status).toBe(200);
    expect(m.db.writes).toHaveLength(0);
    m.db.tables.messaging_opt_outs = [{ phone, business_id: biz, channel: 'email' }];
    for (const email of ['a@example.test', 'b@example.test']) {
      const body = new URLSearchParams({ token: emailUnsubscribeToken(biz, email, phone) });
      expect((await POST(new NextRequest('https://example.test/forms/email-unsubscribe', { method: 'POST', body }))).status).toBe(200);
    }
    const other = '12025550188';
    m.db.tables.customer_consents = [consent('granted', 0, { phone: other, channel: 'email', email_address: 'b@example.test' })];
    expect(await hasEmailMarketingPermission(client(), biz, 'b@example.test', other)).toBe(false);
    expect(await emailMarketingEligibility(client(), biz, [{ phone: other, email: 'b@example.test' }])).toEqual(new Set());
    expect(m.db.tables.native_form_email_unsubscribes).toHaveLength(2);
  });
  it('rejects forged unsubscribe without writes', async () => {
    const body = new URLSearchParams({ token: 'tampered.token' });
    expect((await POST(new NextRequest('https://example.test/forms/email-unsubscribe', { method: 'POST', body }))).status).toBe(400);
    expect(m.db.writes).toHaveLength(0);
  });
});
