/**
 * WhatsApp self check-in only from the ticket's own number (Owner decision
 * 2026-11-18): "Keep, own number only". Handler-level tests of the real
 * lib/bot/handlers/ticket-checkin.ts with a stubbed Supabase client; the real
 * phone normaliser (libphonenumber via toInviteGuestPhone) runs.
 */
import { describe, it, expect, vi } from 'vitest';
import { handleTicketCheckin } from '@/lib/bot/handlers/ticket-checkin';

function setup(ticketOverrides: Record<string, unknown> = {}, eventOverrides: Record<string, unknown> = {}) {
  const ticket = {
    id: 't1', status: 'valid', scanned_at: null, scanned_by: null, guest_name: 'Ada',
    guest_phone: '+2348031234567',
    ...ticketOverrides,
    event: {
      name: 'Launch Night', date: null, time: null, self_checkin_enabled: true, business_id: 'biz-1',
      businesses: { country_code: 'NG' },
      ...eventOverrides,
    },
  };
  const updates: Array<Record<string, unknown>> = [];
  const supabase = {
    from: () => ({
      select: () => {
        const chain: any = { eq: () => chain, single: async () => ({ data: ticket, error: null }) };
        return chain;
      },
      update: (payload: Record<string, unknown>) => {
        updates.push(payload);
        const upd: any = { eq: () => upd, select: () => upd, maybeSingle: async () => ({ data: { id: 't1' }, error: null }) };
        return upd;
      },
    }),
  };
  const sent: string[] = [];
  const sendText = vi.fn(async (_to: string, text: string) => { sent.push(text); });
  return { supabase: supabase as any, sendText, sent, updates };
}

describe('bot self check-in: own number only', () => {
  it('the ticket’s own number checks in (WhatsApp sends international digits)', async () => {
    const t = setup();
    await handleTicketCheckin(t.supabase, t.sendText, '2348031234567', 'TK-ABC123');
    expect(t.updates).toHaveLength(1);
    expect(t.updates[0]).toMatchObject({ status: 'used', scanned_by: 'self' });
    expect(t.sent[0]).toContain('Checked In');
  });

  it('a local-format guest phone matches the same number using the business country', async () => {
    const t = setup({ guest_phone: '0803 123 4567' });
    await handleTicketCheckin(t.supabase, t.sendText, '2348031234567', 'TK-ABC123');
    expect(t.updates).toHaveLength(1);
  });

  it('another number cannot check the ticket in, and nothing is written', async () => {
    const t = setup();
    await handleTicketCheckin(t.supabase, t.sendText, '2348039999999', 'TK-ABC123');
    expect(t.updates).toHaveLength(0);
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0]).toContain('only works from the WhatsApp number the ticket was bought with');
  });

  it('a number with the same local digits in another country is refused', async () => {
    const t = setup();
    await handleTicketCheckin(t.supabase, t.sendText, '448031234567', 'TK-ABC123');
    expect(t.updates).toHaveLength(0);
  });

  it('another number is refused before any status detail, even for a used ticket', async () => {
    const t = setup({ status: 'used', scanned_at: '2026-12-01T18:00:00Z', scanned_by: 'Gate 1' });
    await handleTicketCheckin(t.supabase, t.sendText, '2348039999999', 'TK-ABC123');
    expect(t.updates).toHaveLength(0);
    expect(t.sent[0]).not.toContain('Gate 1');
    expect(t.sent[0]).not.toContain('already checked in');
  });

  it('a ticket with no guest phone cannot be self-checked-in', async () => {
    const t = setup({ guest_phone: null });
    await handleTicketCheckin(t.supabase, t.sendText, '2348031234567', 'TK-ABC123');
    expect(t.updates).toHaveLength(0);
  });

  it('the Self Check-in toggle still applies: off means no check-in even from the own number', async () => {
    const t = setup({}, { self_checkin_enabled: false });
    await handleTicketCheckin(t.supabase, t.sendText, '2348031234567', 'TK-ABC123');
    expect(t.updates).toHaveLength(0);
    expect(t.sent[0]).toContain('Self check-in is not enabled');
  });

  it('double check-in is still refused for the own number', async () => {
    const t = setup({ status: 'used', scanned_at: '2026-12-01T18:00:00Z', scanned_by: 'self' });
    await handleTicketCheckin(t.supabase, t.sendText, '2348031234567', 'TK-ABC123');
    expect(t.updates).toHaveLength(0);
    expect(t.sent[0]).toContain('already checked in');
  });
});
