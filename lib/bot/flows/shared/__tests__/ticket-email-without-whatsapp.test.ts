import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

const sendEmail = vi.hoisted(() => vi.fn());
vi.mock('@/lib/email/client', () => ({ sendEmail }));
vi.mock('@/lib/pdf/ticket-generator', () => ({
  generateTicketsPdf: vi.fn().mockRejectedValue(new Error('optional PDF unavailable')),
}));
vi.mock('@/lib/webhooks/dispatcher', () => ({ dispatchWebhook: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { sendTicketsAfterPurchase } from '../send-tickets';


function ticketEmissionRpc() {
  const emissions = new Map<string, { id: string; state: string }>();
  return vi.fn(async (name: string, params: Record<string, any>) => {
    if (name === 'authorize_event_ticket_emission') {
      if (!params.p_booking_id || !['whatsapp', 'email', 'webhook'].includes(params.p_channel) ||
          !/^(document|image:.+|text:.+|ticket|ticket\.purchased|event\.sold_out)$/.test(params.p_emission_key)) {
        throw new Error('Unexpected ticket emission identity');
      }
      const key = [params.p_booking_id, params.p_channel, params.p_emission_key].join(':');
      const existing = emissions.get(key);
      if (existing) return { data: { authorized: false, state: existing.state }, error: null };
      const row = { id: 'emission-' + emissions.size, state: 'attempted' };
      emissions.set(key, row);
      return { data: { authorized: true, emission_id: row.id }, error: null };
    }
    if (name === 'finalize_event_ticket_emission') {
      const row = [...emissions.values()].find(value => value.id === params.p_emission_id);
      if (!row || row.state !== 'attempted' ||
          !['accepted', 'failed', 'ambiguous'].includes(params.p_state) ||
          (params.p_state === 'accepted' && !params.p_provider_message_id)) {
        throw new Error('Unexpected ticket emission finalization');
      }
      row.state = params.p_state;
      return { data: { finalized: true }, error: null };
    }
    throw new Error('Unexpected RPC: ' + name);
  });
}

function ticketDb() {
  const rows: Array<{ ticket_code: string; ticket_number: number }> = [];
  const emissionRpc = ticketEmissionRpc();
  const supabase = {
    rpc: vi.fn(async (name: string, params: Record<string, any>) => {
      if (name === 'converge_event_ticket_booking') {
        if (params.p_booking_id !== 'booking-1' || params.p_event_id !== 'event-1' || params.p_ticket_type_id !== null || params.p_quantity !== 2) throw new Error('Unexpected ticket issuance identity');
        if (!rows.length) rows.push(...Array.from({ length: 2 }, (_, i) => ({ ticket_code: 'TK-CANONICAL-' + (i + 1), ticket_number: i + 1 })));
        return { data: { success: true, outcome: 'issued', tickets: rows.map(row => ({ ticketCode: row.ticket_code, ticketNumber: row.ticket_number, totalTickets: 2 })) }, error: null };
      }
      return emissionRpc(name, params);
    }),
    from: vi.fn((table: string) => {
      if (table === 'event_tickets') {
        const chain = {
          select: vi.fn(() => chain),
          eq: vi.fn(() => chain),
          order: vi.fn(async () => ({ data: rows, error: null })),
          insert: vi.fn(async (inserted: Array<{ ticket_code: string; ticket_number: number }>) => {
            rows.push(...inserted);
            return { error: null };
          }),
        };
        return chain;
      }
      if (table === 'businesses') {
        const chain = {
          select: vi.fn(() => chain), eq: vi.fn(() => chain),
          single: vi.fn(async () => ({ data: { name: 'Event Co', subscription_tier: 'free' }, error: null })),
        };
        return chain;
      }
      if (table === 'events') {
        const chain = {
          select: vi.fn(() => chain), eq: vi.fn(() => chain),
          single: vi.fn(async () => ({ data: { total_tickets: 100, tickets_sold: 1 }, error: null })),
        };
        return chain;
      }
      throw new Error(`unexpected table ${table}`);
    }),
  };
  return { supabase: supabase as unknown as SupabaseClient, rows };
}

describe('ticket email fallback without WhatsApp sender', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sendEmail.mockResolvedValue({ success: true, id: 'email-provider-fixture-1' });
  });

  it('sends supplemental email and creates canonical QR tickets when no sender exists', async () => {
    const db = ticketDb();
    const result = await sendTicketsAfterPurchase({
      supabase: db.supabase,
      businessId: 'business-1', bookingId: 'booking-1', eventId: 'event-1',
      eventName: 'Launch Night', eventDate: 'Friday, October 2', venue: 'Main Hall',
      guestName: 'Ada', guestPhone: '+15551234567', guestEmail: 'ada@example.com',
      referenceCode: 'EV-100', quantity: 2,
    });

    expect(result.success).toBe(true);
    expect(db.rows).toHaveLength(2);
    expect(sendEmail).toHaveBeenCalledOnce();
  });
});
