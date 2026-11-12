import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { FlowContext } from '../../types';
import { createMemoryDb } from '@/lib/__tests__/helpers/memory-db';
import { persistStoreCustomerEmail, resolveStoreCustomerEmail } from '../customer-email';
import { orderingFlow } from '../../ordering.flow';
import { schedulingFlow } from '../../scheduling.flow';
import { reservationFlow } from '../../reservation.flow';

const phone = '+2348012345678';
const profile = { id: 'customer', business_id: 'store', phone, email: 'Known@Example.com', notification_opt_in: true };
const flows = [orderingFlow, schedulingFlow, reservationFlow];
function context(db: unknown, data: Record<string, unknown> = {}): FlowContext {
  return { supabase: db, from: phone, business: { id: 'store' }, copyLang: 'en',
    session: { business_id: 'store', user_id: 'identified', session_data: data } } as FlowContext;
}

describe('business-scoped returning customer email', () => {
  it.each(flows)('reuses same-store email in $id without asking again', async flow => {
    const db = createMemoryDb({ customer_profiles: [{ ...profile, phone: phone.slice(1) }] });
    const ctx = context(db);
    expect(await flow.steps.find(s => s.id === 'collect_email')!.skipIf!(ctx)).toBe(true);
    expect(ctx.session.session_data.email).toBe('known@example.com');
    if (flow === orderingFlow) expect(ctx.session.session_data.customer_email).toBe('known@example.com');
  });
  it.each(flows)('does not import global email at collect_name in $id', async flow => {
    const db = createMemoryDb({ profiles: [{ id: 'identified', phone, first_name: 'Ada', last_name: 'Okafor', email: 'global@example.com' }] });
    const ctx = context(db);
    expect(await flow.steps.find(s => s.id === 'collect_name')!.skipIf!(ctx)).toBe(true);
    expect(ctx.session.session_data.first_name).toBe('Ada');
    expect(ctx.session.session_data.email).toBeUndefined();
    expect(await flow.steps.find(s => s.id === 'collect_email')!.skipIf!(ctx)).toBe(false);
  });
  it('denies another business and another phone across profiles and historical transactions', async () => {
    const db = createMemoryDb({
      customer_profiles: [{ ...profile, business_id: 'other' }, { ...profile, phone: '+2348099999999' }],
      bookings: [{ business_id: 'other', guest_phone: phone, guest_email: 'other@example.com' }],
      reservations: [{ business_id: 'store', guest_phone: '+2348099999999', guest_email: 'other@example.com' }],
    });
    expect(await resolveStoreCustomerEmail(db as any, 'store', phone)).toBeNull();
  });
  it.each(['bookings', 'reservations'])('reuses valid legacy email from same-store %s with phone aliases', async table => {
    const db = createMemoryDb({ customer_profiles: [{ ...profile, email: 'invalid' }],
      [table]: [{ business_id: 'store', guest_phone: phone.slice(1), guest_email: 'Prior@Example.com' }] });
    expect(await resolveStoreCustomerEmail(db as any, 'store', phone)).toBe('prior@example.com');
  });
  it('uses the newest valid same-store historical email across both transaction families', async () => {
    const db = createMemoryDb({
      bookings: [{ business_id: 'store', guest_phone: phone, guest_email: 'older@example.com', created_at: '2026-10-01' }],
      reservations: [{ business_id: 'store', guest_phone: phone, guest_email: 'newer@example.com', created_at: '2026-11-01' }],
    });
    expect(await resolveStoreCustomerEmail(db as any, 'store', phone)).toBe('newer@example.com');
  });
  it.each([null, '', 'invalid', '2348012345678@whatsapp.waaiio.com'])('prompts for missing/invalid/generated email %s', async email => {
    const db = createMemoryDb({ customer_profiles: [{ ...profile, email }],
      bookings: [{ business_id: 'store', guest_phone: phone, guest_email: email }] });
    expect(await resolveStoreCustomerEmail(db as any, 'store', phone)).toBeNull();
  });
  it('prompts when phone aliases have conflicting valid profile emails', async () => {
    const db = createMemoryDb({ customer_profiles: [profile, { ...profile, phone: phone.slice(1), email: 'different@example.com' }],
      bookings: [{ business_id: 'store', guest_phone: phone, guest_email: 'prior@example.com' }] });
    expect(await resolveStoreCustomerEmail(db as any, 'store', phone)).toBeNull();
  });
  it.each([phone, phone.slice(1)])('does not recover retained reservation email after deleting phone %s', async deletedPhone => {
    const tombstone = `deleted_${createHash('sha256').update(deletedPhone).digest('hex').slice(0, 16)}`;
    const db = createMemoryDb({ customer_profiles: [{ ...profile, phone: tombstone, email: null }],
      reservations: [{ business_id: 'store', guest_phone: phone, guest_email: 'removed@example.com' }] });
    expect(await resolveStoreCustomerEmail(db as any, 'store', phone)).toBeNull();
    db.tables.customer_profiles[0].business_id = 'other-store';
    expect(await resolveStoreCustomerEmail(db as any, 'store', phone)).toBe('removed@example.com');
  });
  it('does not reuse a soft-deleted profile or its retained historical email', async () => {
    const db = createMemoryDb({ customer_profiles: [{ ...profile, deleted_at: '2026-11-01' }],
      reservations: [{ business_id: 'store', guest_phone: phone, guest_email: 'removed@example.com' }] });
    expect(await resolveStoreCustomerEmail(db as any, 'store', phone)).toBeNull();
  });
  it('reuses a newly supplied active profile email without recovering deleted history', async () => {
    const tombstone = `deleted_${createHash('sha256').update(phone).digest('hex').slice(0, 16)}`;
    const db = createMemoryDb({ customer_profiles: [{ ...profile, phone: tombstone, email: null }] });
    await persistStoreCustomerEmail(db as any, 'store', phone, 'new@example.com', 'Ada Okafor');
    expect(await resolveStoreCustomerEmail(db as any, 'store', phone)).toBe('new@example.com');
    expect(db.tables.customer_profiles[0]).toMatchObject({ phone: tombstone, email: null });
    expect(db.tables.customer_profiles[1]).toMatchObject({ phone, notification_opt_in: false });
  });
  it.each(['customer_profiles', 'bookings', 'reservations'])('prompts on %s lookup failure', async table => {
    const db = createMemoryDb(); db.failReads.add(table);
    expect(await resolveStoreCustomerEmail(db as any, 'store', phone)).toBeNull();
  });
  it.each(flows)('persists typed email for an identified customer in $id without granting consent', async flow => {
    const db = createMemoryDb();
    const result = await flow.steps.find(s => s.id === 'collect_email')!.validate('New@Example.com', context(db, { first_name: 'Ada', last_name: 'Okafor' }));
    expect(result.valid).toBe(true);
    expect(db.tables.customer_profiles).toEqual([expect.objectContaining({ business_id: 'store', phone,
      email: 'new@example.com', notification_opt_in: false, name: 'Ada Okafor' })]);
    if (flow === orderingFlow) expect(result.data).toMatchObject({ email: 'new@example.com', customer_email: 'new@example.com' });
  });
  it('updates both aliases email-only and preserves opted-in and opted-out preferences', async () => {
    const db = createMemoryDb({ customer_profiles: [profile,
      { ...profile, id: 'alias', phone: phone.slice(1), notification_opt_in: false },
      { ...profile, id: 'foreign', business_id: 'other' }] });
    await persistStoreCustomerEmail(db as any, 'store', phone, 'New@Example.com');
    expect(db.tables.customer_profiles.map(p => [p.email, p.notification_opt_in])).toEqual([
      ['new@example.com', true], ['new@example.com', false], ['Known@Example.com', true],
    ]);
  });
  it('preserves an existing customer name when storing a newly typed email', async () => {
    const db = createMemoryDb({ customer_profiles: [{ ...profile, name: 'Existing Name' }] });
    await persistStoreCustomerEmail(db as any, 'store', phone, 'new@example.com', 'New Name');
    expect(db.tables.customer_profiles[0]).toMatchObject({ name: 'Existing Name', email: 'new@example.com' });
  });
  it('on concurrent insert conflict retries email-only update without replacing consent', async () => {
    const memory = createMemoryDb();
    const db = { from(table: string) {
      const query = memory.from(table);
      query.insert = (row: Record<string, unknown>) => {
        expect(row.notification_opt_in).toBe(false);
        memory.tables.customer_profiles.push({ ...profile, notification_opt_in: true });
        return Promise.resolve({ error: { code: '23505' } });
      };
      return query;
    } } as SupabaseClient;
    await persistStoreCustomerEmail(db, 'store', phone, 'new@example.com');
    expect(memory.tables.customer_profiles).toEqual([{ ...profile, email: 'new@example.com' }]);
  });
  it('does not insert after an email update error or mutate other customer fields', async () => {
    const insert = vi.fn();
    const query: any = { eq: () => query, in: () => query, is: () => query,
      select: async () => ({ data: null, error: { code: 'offline' } }) };
    const update = vi.fn(() => query);
    const db = { from: () => ({ update, insert }) } as unknown as SupabaseClient;
    await persistStoreCustomerEmail(db, 'store', phone, 'new@example.com');
    expect(update).toHaveBeenCalledWith({ email: 'new@example.com' });
    expect(insert).not.toHaveBeenCalled();
  });
  it.each(flows)('keeps the transaction usable when profile persistence throws in $id', async flow => {
    const db = { from: vi.fn(() => { throw new Error('offline'); }) };
    expect(await flow.steps.find(s => s.id === 'collect_email')!.validate('new@example.com', context(db)))
      .toMatchObject({ valid: true, data: { email: 'new@example.com' } });
  });
  it('normalizes ordering aliases using valid session email even if customer_email is invalid', async () => {
    const ctx = context(createMemoryDb(), { customer_email: 'invalid', email: 'Session@Example.com' });
    expect(await orderingFlow.steps.find(s => s.id === 'collect_email')!.skipIf!(ctx)).toBe(true);
    expect(ctx.session.session_data).toMatchObject({ email: 'session@example.com', customer_email: 'session@example.com' });
  });
});
