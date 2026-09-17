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

function ticketDb() {
  const rows: Array<{ ticket_code: string; ticket_number: number }> = [];
  const supabase = {
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
    sendEmail.mockResolvedValue({ success: true });
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
