import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { hasRecipientPermission } from '@/lib/merchants/recipient-permission';

function fixture({ consent = { status: 'granted', expires_at: null } as Record<string, unknown> | null, count = 0 as number | null, error = null as unknown } = {}) {
  const calls: unknown[][] = [];
  const db = { from: vi.fn((table: string) => {
    const result = table === 'messaging_opt_outs' ? { count, error } : { data: consent, error };
    const chain: Record<string, unknown> = {};
    for (const method of ['select', 'eq', 'in', 'or', 'is', 'order', 'limit']) chain[method] = (...args: unknown[]) => { calls.push([table, method, ...args]); return chain; };
    chain.maybeSingle = async () => result;
    chain.then = (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve);
    return chain;
  }) };
  return { db: db as unknown as SupabaseClient, calls };
}
describe('merchant recipient permission', () => {
  it('allows explicit unexpired purpose/channel consent with no opt-out', async () => {
    const { db, calls } = fixture();
    expect(await hasRecipientPermission(db, 'biz', '+1 (202) 555-0123', 'utility')).toBe(true);
    expect(calls).toContainEqual(['customer_consents', 'eq', 'business_id', 'biz']);
    expect(calls).toContainEqual(['customer_consents', 'eq', 'purpose', 'utility']);
    expect(calls).toContainEqual(['customer_consents', 'in', 'phone', ['12025550123', '+12025550123']]);
    expect(calls).toContainEqual(['messaging_opt_outs', 'or', 'business_id.eq.biz,business_id.is.null']);
    expect(calls).toContainEqual(['customer_consents', 'order', 'created_at', { ascending: false }]);
  });
  it('requires email consent separately from WhatsApp marketing permission', async () => {
    const { db, calls } = fixture();
    expect(await hasRecipientPermission(db, 'biz', '12025550123', 'marketing', 'email')).toBe(true);
    expect(calls).toContainEqual(['customer_consents', 'eq', 'channel', 'email']);
    expect(calls).toContainEqual(['customer_consents', 'eq', 'purpose', 'marketing']);
  });
  it.each([null, { status: 'revoked' }, { status: 'pending' }, { status: 'granted', expires_at: '2000-01-01' }, { status: 'granted', expires_at: 'invalid' }])('denies missing/revoked/expired consent %j', async consent => {
    expect(await hasRecipientPermission(fixture({ consent }).db, 'biz', '12025550123', 'utility')).toBe(false);
  });
  it.each([1, null])('denies opt-out or incomplete opt-out check %s', async count => {
    expect(await hasRecipientPermission(fixture({ count }).db, 'biz', '12025550123', 'utility')).toBe(false);
  });
  it('fails closed on database errors and invalid phone', async () => {
    expect(await hasRecipientPermission(fixture({ error: new Error('offline') }).db, 'biz', '12025550123', 'utility')).toBe(false);
    const { db } = fixture();
    expect(await hasRecipientPermission(db, 'biz', 'bad', 'utility')).toBe(false);
    expect(db.from).not.toHaveBeenCalled();
  });
});
