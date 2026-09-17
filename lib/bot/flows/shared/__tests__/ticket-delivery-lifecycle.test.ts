import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

vi.mock('@/lib/pdf/ticket-generator', () => ({
  generateTicketsPdf: vi.fn().mockRejectedValue(new Error('optional PDF unavailable')),
}));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { deliverTicketsWhatsApp } from '../send-tickets';
import { driveExternalEffect } from '@/lib/payments/terminal-effects';

function ticketSupabase() {
  return {
    from: vi.fn((table: string) => {
      if (table !== 'businesses') throw new Error(`unexpected table ${table}`);
      const chain = {
        select: vi.fn(() => chain),
        eq: vi.fn(() => chain),
        single: vi.fn(async () => ({ data: { subscription_tier: 'free' }, error: null })),
      };
      return chain;
    }),
  } as unknown as SupabaseClient;
}

describe('ticket WhatsApp lifecycle', () => {
  beforeEach(() => vi.clearAllMocks());

  it('delivers every canonical ticket as a QR image over WhatsApp', async () => {
    const sendImage = vi.fn().mockResolvedValue(undefined);
    const sendText = vi.fn().mockResolvedValue(undefined);
    await deliverTicketsWhatsApp({
      supabase: ticketSupabase(),
      sender: { sendImage, sendText } as never,
      businessId: 'business-1', bookingId: 'booking-1', eventId: 'event-1',
      eventName: 'Launch Night', eventDate: 'Friday, October 2', eventTime: '19:00', venue: 'Main Hall',
      guestName: 'Ada', guestPhone: '+15551234567', referenceCode: 'EV-100', quantity: 2,
      tickets: [
        { ticketCode: 'TK-ONE', ticketNumber: 1, totalTickets: 2 },
        { ticketCode: 'TK-TWO', ticketNumber: 2, totalTickets: 2 },
      ],
    });

    expect(sendImage).toHaveBeenCalledTimes(2);
    expect(sendImage.mock.calls.map(call => call[0].imageUrl)).toEqual([
      'https://www.waaiio.com/api/tickets/image?code=TK-ONE',
      'https://www.waaiio.com/api/tickets/image?code=TK-TWO',
    ]);
    expect(sendImage.mock.calls.every(call => call[0].to === '+15551234567')).toBe(true);
    expect(sendText).not.toHaveBeenCalled();
  });

  it('a terminal lifecycle retry does not emit the QR tickets again', async () => {
    let state: 'pending' | 'sending' | 'completed' = 'pending';
    const lifecycle = {
      rpc: vi.fn(async (name: string) => {
        if (name === 'reserve_terminal_effect') {
          if (state === 'completed') return { data: { reserved: false, reason: 'already_terminal' }, error: null };
          return { data: { reserved: true, effect_token: 'effect-token' }, error: null };
        }
        if (name === 'begin_terminal_external_emission') {
          state = 'sending';
          return { data: { authorized: true }, error: null };
        }
        if (name === 'complete_external_effect') {
          state = 'completed';
          return { data: { completed: true }, error: null };
        }
        throw new Error(`unexpected rpc ${name}`);
      }),
    } as unknown as SupabaseClient;
    const sendImage = vi.fn().mockResolvedValue(undefined);
    const delivery = () => deliverTicketsWhatsApp({
      supabase: ticketSupabase(),
      sender: { sendImage, sendText: vi.fn() } as never,
      businessId: 'business-1', bookingId: 'booking-1', eventId: 'event-1',
      eventName: 'Launch Night', eventDate: 'Friday, October 2', venue: 'Main Hall',
      guestName: 'Ada', guestPhone: '+15551234567', referenceCode: 'EV-100', quantity: 1,
      tickets: [{ ticketCode: 'TK-ONCE', ticketNumber: 1, totalTickets: 1 }],
    }).then(() => true);

    await expect(driveExternalEffect(lifecycle, 'payment-1', 'ticket_delivery_whatsapp', 'claim-1', delivery))
      .resolves.toEqual({ ok: true });
    await expect(driveExternalEffect(lifecycle, 'payment-1', 'ticket_delivery_whatsapp', 'claim-1', delivery))
      .resolves.toEqual({ ok: true });

    expect(sendImage).toHaveBeenCalledOnce();
    expect(state).toBe('completed');
  });
});
