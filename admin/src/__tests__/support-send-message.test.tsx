/**
 * Admin Support page: replies are written to support_ticket_messages.message
 * (the real column, migration 012) and the thread renders that column.
 * Before the fix the page wrote and read a non-existent `body` column, so
 * every admin reply failed and every message rendered blank.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const state = vi.hoisted(() => ({
  inserts: [] as Array<{ table: string; payload: Record<string, unknown> }>,
  insertError: null as null | { message: string },
  messages: [] as Array<Record<string, unknown>>,
}));

function chain(table: string) {
  const c: Record<string, any> = {};
  let op = 'select';
  for (const m of ['select', 'eq', 'in', 'order', 'range', 'limit', 'neq', 'or', 'ilike', 'gte', 'lte', 'is', 'not', 'match'])
    c[m] = vi.fn(() => c);
  c.update = vi.fn(() => { op = 'update'; return c; });
  c.insert = vi.fn((payload: Record<string, unknown>) => {
    op = 'insert';
    state.inserts.push({ table, payload });
    return c;
  });
  const result = () => {
    if (op === 'insert') return { data: null, error: state.insertError };
    if (op === 'update') return { data: null, error: null };
    if (table === 'support_tickets')
      return {
        data: [{ id: 't1', subject: 'Payout question', description: 'Help', requester_id: 'u1', type: 'question', category: 'billing', priority: 'normal', status: 'open', created_at: '2026-11-03T10:00:00Z', updated_at: '2026-11-03T10:00:00Z' }],
        error: null,
        count: 1,
      };
    if (table === 'support_ticket_messages') return { data: state.messages, error: null };
    if (table === 'profiles') return { data: [{ id: 'u1', first_name: 'Ada', last_name: 'Merchant' }, { id: 'admin-1', first_name: 'Admin', last_name: 'User' }], error: null };
    return { data: [], error: null, count: 0 };
  };
  c.maybeSingle = vi.fn(async () => result());
  c.single = vi.fn(async () => result());
  c.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => Promise.resolve(result()).then(resolve, reject);
  return c;
}

vi.mock('@/lib/supabase', () => ({
  supabase: { auth: { getSession: async () => ({ data: { session: { user: { id: 'admin-1' } } } }) } },
  adminDb: { from: (table: string) => chain(table) },
}));
vi.mock('@/lib/auditLog', () => ({ logAudit: vi.fn() }));

const { default: Support } = await import('@/pages/Support');

beforeEach(() => {
  state.inserts = [];
  state.insertError = null;
  state.messages = [{ id: 'm1', ticket_id: 't1', sender_id: 'u1', message: 'My payout is late', is_internal: false, created_at: '2026-11-03T10:01:00Z' }];
  vi.spyOn(window, 'alert').mockImplementation(() => {});
  // jsdom has no layout engine; the thread auto-scrolls to the newest message.
  Element.prototype.scrollIntoView = vi.fn();
});

async function openTicket() {
  render(<Support />);
  await userEvent.click(await screen.findByText('Payout question'));
}

describe('Admin Support replies use the message column', () => {
  it('renders the text of existing messages', async () => {
    await openTicket();
    expect(await screen.findByText('My payout is late')).toBeInTheDocument();
  });

  it('sends the reply as { message } with no body key', async () => {
    await openTicket();
    await userEvent.type(await screen.findByPlaceholderText('Type a reply...'), '  We are on it  ');
    await userEvent.click(screen.getByRole('button', { name: /send/i }));
    await waitFor(() => expect(state.inserts.some(i => i.table === 'support_ticket_messages')).toBe(true));
    const sent = state.inserts.find(i => i.table === 'support_ticket_messages')!.payload;
    expect(sent).toEqual({ ticket_id: 't1', sender_id: 'admin-1', message: 'We are on it', is_internal: false });
    expect(sent).not.toHaveProperty('body');
    expect(window.alert).not.toHaveBeenCalled();
  });

  it('keeps the draft and shows the failure when the insert is rejected', async () => {
    state.insertError = { message: 'denied' };
    await openTicket();
    const box = await screen.findByPlaceholderText('Type a reply...');
    await userEvent.type(box, 'Draft reply');
    await userEvent.click(screen.getByRole('button', { name: /send/i }));
    await waitFor(() => expect(window.alert).toHaveBeenCalledWith('Failed to send message'));
    expect(box).toHaveValue('Draft reply');
  });
});
