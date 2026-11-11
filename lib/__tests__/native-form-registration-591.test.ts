import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createMemoryDb } from './helpers/memory-db';
import { createMockContext, getStep } from '@/lib/bot/flows/__tests__/helpers';
import { ticketingFlow } from '@/lib/bot/flows/ticketing.flow';
const event = (id: string) => ({ id, business_id: 'biz', name: `Event ${id}`, status: 'published', date: '2099-01-01', price: 0, total_tickets: 100, tickets_sold: 0 });
function setup() {
  const db = createMemoryDb({ events: [event('a'), event('b')], native_form_registrations: [{ id: 'registration', business_id: 'biz', session_id: 'session', phone: '12025550123', event_id: 'a' }] });
  const rpc = vi.fn();
  const ctx = createMockContext({ supabase: { from: db.from, rpc } as unknown as SupabaseClient, from: '12025550123',
    business: { id: 'biz', name: 'Church', country_code: 'US', metadata: {} } as any,
    session: { id: 'session', business_id: 'biz', version: 0, current_step: 'select_event', session_data: { _native_registration_id: 'registration', _terms_accepted: true } } as any });
  return { db, ctx, rpc };
}
describe('#591 native ticket event binding', () => {
  it('back-navigation only offers the form event and rejects another event selection', async () => {
    const { ctx } = setup(); const select = getStep(ticketingFlow, 'select_event');
    const messages = await select.prompt(ctx);
    expect(JSON.stringify(messages)).toContain('Event a'); expect(JSON.stringify(messages)).not.toContain('Event b');
    expect((await select.validate('b', ctx)).valid).toBe(false);
    expect((await select.validate('a', ctx)).valid).toBe(true);
  });
  it('rejects a mismatched event before user, booking or payment mutation', async () => {
    const { ctx, db, rpc } = setup(); Object.assign(ctx.session.session_data, { event_id: 'b', total_amount: 0, ticket_quantity: 1 });
    const result = await getStep(ticketingFlow, 'process_tickets').prompt(ctx);
    expect(JSON.stringify(result)).toContain('no longer matches'); expect(rpc).not.toHaveBeenCalled(); expect(db.writes).toHaveLength(0);
  });
  it('rejects another session/phone instead of inheriting its registration', async () => {
    const { ctx } = setup(); ctx.from = '12025550188';
    expect((await getStep(ticketingFlow, 'select_event').validate('a', ctx)).valid).toBe(false);
  });
});
