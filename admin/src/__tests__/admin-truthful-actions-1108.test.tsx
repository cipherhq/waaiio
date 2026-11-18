/**
 * #1108 X1–X3: admin actions report the server's answer, never a guess.
 *
 * Before: these pages wrote with the browser client, which has no admin
 * UPDATE/DELETE rights, so writes matched 0 rows and the page showed success
 * anyway; reads that RLS hid showed as empty lists; audit inserts were
 * silently dropped. Now each action goes to an /api/admin route and the page
 * shows that route's refusal. These tests render the real pages with a fake
 * API and prove: refusals and zero-row results are shown as errors, local
 * state does not change, and no direct table write is attempted.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  fixtures: {} as Record<string, unknown[]>,
  directWrites: [] as Array<{ table: string; kind: string }>,
  fetch: vi.fn(),
  role: 'admin',
}));

vi.mock('@/lib/supabase', () => {
  const from = (table: string) => {
    const q: any = {};
    for (const m of ['select', 'order', 'eq', 'in', 'limit', 'range', 'not', 'gte', 'lte', 'is', 'neq', 'gt', 'lt']) q[m] = () => q;
    for (const kind of ['update', 'delete', 'insert', 'upsert']) q[kind] = () => { h.directWrites.push({ table, kind }); return q; };
    q.maybeSingle = async () => ({ data: (h.fixtures[table] || [])[0] ?? null, error: null });
    q.single = q.maybeSingle;
    q.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve({ data: h.fixtures[table] || [], error: null, count: (h.fixtures[table] || []).length }).then(resolve, reject);
    return q;
  };
  const auth = { getSession: async () => ({ data: { session: { access_token: 'synthetic-token', user: { id: 'admin-self' } } } }) };
  return { adminDb: { from, auth }, supabase: { from, auth } };
});
// A stable session object: pages reload whenever the session identity changes.
const session = vi.hoisted(() => ({ userId: 'admin-self', email: 'a@example.test', role: 'admin' }));
vi.mock('@/components/AdminLayout', () => ({ useAdminSession: () => session }));

import { logAudit, AUDIT_FAILED_EVENT } from '@/lib/auditLog';
import { AuditFailureNotice } from '@/components/AuditFailureNotice';
import Campaigns from '@/pages/Campaigns';
import Tickets from '@/pages/Tickets';
import Alerts from '@/pages/Alerts';
import AIMarketplace from '@/pages/AIMarketplace';
import BotKeywords from '@/pages/BotKeywords';
import UserManagement from '@/pages/Users';
import ChatHistory from '@/pages/ChatHistory';
import Reports from '@/pages/Reports';
import QueueManagement from '@/pages/QueueManagement';
import WhatsAppChannels from '@/pages/WhatsAppChannels';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;
let api: Handler;
const calls = (pattern: RegExp) => h.fetch.mock.calls.filter(([url]) => pattern.test(String(url)));
const bodyOf = (call: unknown[]) => JSON.parse(String((call[1] as RequestInit).body));

const BIZ = '11111111-1111-4111-8111-111111111111';
const ID = '22222222-2222-4222-8222-222222222222';

beforeEach(() => {
  h.fixtures = {}; h.directWrites = []; h.role = 'admin';
  api = () => json({ error: 'unexpected call' }, 500);
  h.fetch.mockReset();
  h.fetch.mockImplementation((url: string, init?: RequestInit) => Promise.resolve(api(String(url), init)));
  vi.stubEnv('VITE_API_URL', 'https://api.example.test');
  vi.stubGlobal('fetch', h.fetch);
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  vi.spyOn(window, 'alert').mockImplementation(() => {});
  Element.prototype.scrollIntoView = vi.fn(); // not implemented by jsdom
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('X1: audit entries go to the server and failures are announced', () => {
  it('posts the entry to /api/admin/audit and reports success only when recorded', async () => {
    api = () => json({ recorded: true });
    const result = await logAudit({ action: 'kill_bot_session', entity_type: 'bot_session', entity_id: ID, details: { phone: 'x' } });
    expect(result).toEqual({ ok: true });
    const [call] = calls(/\/api\/admin\/audit$/);
    expect(call[0]).toBe('https://api.example.test/api/admin/audit');
    expect((call[1] as RequestInit).headers).toMatchObject({ Authorization: 'Bearer synthetic-token' });
    expect(bodyOf(call)).toEqual({ action: 'kill_bot_session', entity_type: 'bot_session', entity_id: ID, details: { phone: 'x' } });
  });

  it.each([
    ['a refusal', () => json({ error: 'Unauthorized' }, 403), 'Unauthorized'],
    ['a server failure', () => json({ error: 'Audit entry was not recorded' }, 500), 'Audit entry was not recorded'],
    ['an unconfirmed reply', () => json({}), 'Audit request failed (200)'],
  ])('returns and announces %s instead of dropping it', async (_name, reply, message) => {
    api = reply;
    render(<AuditFailureNotice />);
    let result: Awaited<ReturnType<typeof logAudit>> | undefined;
    await act(async () => { result = await logAudit({ action: 'edit_campaign', entity_id: ID }); });
    expect(result).toEqual({ ok: false, error: message });
    expect(screen.getByRole('alert')).toHaveTextContent('edit campaign was done, but its audit log entry was not recorded');
  });

  it('announces a network failure', async () => {
    h.fetch.mockRejectedValue(new Error('offline'));
    const heard = vi.fn();
    window.addEventListener(AUDIT_FAILED_EVENT, heard);
    const result = await logAudit({ action: 'cancel_ticket', entity_id: ID });
    window.removeEventListener(AUDIT_FAILED_EVENT, heard);
    expect(result).toEqual({ ok: false, error: 'offline' });
    expect(heard).toHaveBeenCalledOnce();
  });
});

describe('X2: actions show the API refusal, never success', () => {
  it('Campaigns: a refused save keeps the editor open with the reason', async () => {
    h.fixtures.campaigns = [{ id: ID, business_id: BIZ, title: 'Roof fund', goal_amount: 1000, raised_amount: 0, status: 'active', start_date: null, end_date: null, created_at: '2026-11-01T00:00:00Z' }];
    h.fixtures.businesses = [{ id: BIZ, name: 'Grace Church' }];
    api = url => url.endsWith(`/api/admin/campaigns/${ID}`) ? json({ error: 'Campaign was not updated. Refresh and try again.' }, 409) : json({}, 500);
    render(<Campaigns />);
    fireEvent.click((await screen.findAllByText('Roof fund')).find(e => e.closest('tr'))!);
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Not saved: Campaign was not updated. Refresh and try again.');
    expect(screen.getByRole('button', { name: 'Save Changes' })).toBeInTheDocument();
    const [call] = calls(/\/api\/admin\/campaigns\//);
    expect(bodyOf(call)).toEqual({ title: 'Roof fund', goal_amount: 1000, start_date: null, end_date: null, status: 'active' });
    expect(h.directWrites).toEqual([]);
  });

  it('Tickets: a zero-row cancel leaves the ticket valid and says why', async () => {
    h.fixtures.event_tickets = [{ id: ID, business_id: BIZ, event_id: 'ev', ticket_code: 'TK-AAA111', ticket_number: 1, status: 'valid', guest_name: 'Ada', created_at: '2026-11-01T00:00:00Z' }];
    api = url => url.endsWith(`/api/admin/tickets/${ID}/cancel`) ? json({ error: 'Ticket is used, so it was not cancelled.' }, 409) : json({}, 500);
    render(<Tickets />);
    fireEvent.click((await screen.findAllByText('TK-AAA111')).find(e => e.closest('tr'))!);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel Ticket' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Ticket not cancelled: Ticket is used, so it was not cancelled.');
    expect(screen.getByRole('button', { name: 'Cancel Ticket' })).toBeInTheDocument();
    expect(h.directWrites).toEqual([]);
  });

  it('Tickets: a confirmed cancel updates the status shown', async () => {
    h.fixtures.event_tickets = [{ id: ID, business_id: BIZ, event_id: 'ev', ticket_code: 'TK-AAA111', ticket_number: 1, status: 'valid', guest_name: 'Ada', created_at: '2026-11-01T00:00:00Z' }];
    api = () => json({ ticket: { id: ID, status: 'cancelled' }, auditRecorded: true });
    render(<Tickets />);
    fireEvent.click((await screen.findAllByText('TK-AAA111')).find(e => e.closest('tr'))!);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel Ticket' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Cancel Ticket' })).not.toBeInTheDocument());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  describe('Alerts', () => {
    beforeEach(() => {
      h.fixtures.alerts = [{ id: ID, business_id: BIZ, type: 'payment_failed', severity: 'warning', title: 'Card declined', message: 'm', is_read: false, created_at: '2026-11-01T00:00:00Z' }];
    });

    it('a refused mark-read keeps the alert unread and shows the reason', async () => {
      api = () => json({ error: 'Alert not found' }, 404);
      render(<Alerts />);
      fireEvent.click(await screen.findByTitle('Mark read'));
      expect(await screen.findByRole('alert')).toHaveTextContent('Alert not updated: Alert not found');
      expect(screen.getByTitle('Mark read')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Mark All Read \(1\)/ })).toBeInTheDocument();
      expect(bodyOf(calls(/\/api\/admin\/alerts$/)[0])).toEqual({ action: 'mark_read', id: ID });
      expect(h.directWrites).toEqual([]);
    });

    it('a refused dismiss keeps the alert listed', async () => {
      api = () => json({ error: 'Unauthorized' }, 403);
      render(<Alerts />);
      fireEvent.click(await screen.findByTitle('Dismiss'));
      expect(await screen.findByRole('alert')).toHaveTextContent('Alert not updated: Unauthorized');
      expect(screen.getByText('Card declined')).toBeInTheDocument();
    });

    it('mark all read only marks the IDs the API confirmed', async () => {
      h.fixtures.alerts.push({ id: BIZ, business_id: BIZ, type: 't', severity: 'info', title: 'Second', message: 'm', is_read: false, created_at: '2026-11-01T00:00:00Z' });
      api = () => json({ updated: 1, ids: [ID], auditRecorded: true });
      render(<Alerts />);
      fireEvent.click(await screen.findByRole('button', { name: /Mark All Read \(2\)/ }));
      expect(await screen.findByRole('button', { name: /Mark All Read \(1\)/ })).toBeInTheDocument();
    });
  });

  it('AI Marketplace: a refused verify leaves the business unverified', async () => {
    h.fixtures.businesses = [{ id: BIZ, name: 'Mama Put', category: 'restaurant', city: 'Lagos', is_verified: false, discovery_enabled: true, price_band: null, description: 'x', latitude: 1, longitude: 1 }];
    api = url => url.includes('/marketplace') ? json({ error: 'Business was not updated. Refresh and try again.' }, 409) : json({}, 500);
    render(<AIMarketplace />);
    fireEvent.click(await screen.findByRole('button', { name: 'Marketplace Health' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Verify' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Business not updated: Business was not updated. Refresh and try again.');
    expect(screen.getByRole('button', { name: 'Verify' })).toBeInTheDocument();
    expect(bodyOf(calls(/\/marketplace$/)[0])).toEqual({ is_verified: true });
    expect(h.directWrites).toEqual([]);
  });

  it('AI Marketplace: shows the value the API saved', async () => {
    h.fixtures.businesses = [{ id: BIZ, name: 'Mama Put', category: 'restaurant', city: 'Lagos', is_verified: false, discovery_enabled: true, price_band: null, description: 'x', latitude: 1, longitude: 1 }];
    api = () => json({ business: { id: BIZ, is_verified: true, discovery_enabled: true }, auditRecorded: true });
    render(<AIMarketplace />);
    fireEvent.click(await screen.findByRole('button', { name: 'Marketplace Health' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Verify' }));
    expect(await screen.findByRole('button', { name: 'Unverify' })).toBeInTheDocument();
  });

  describe('Bot Keywords', () => {
    const kw = { id: ID, keyword: 'hello', match_type: 'exact', action_type: 'reply', payload: 'Hi', is_active: true, priority: 50, scope: 'system', category: null, description: null, business_id: null, created_at: '2026-11-01T00:00:00Z' };

    it('reads keywords through the admin API', async () => {
      api = url => url.endsWith('/api/admin/bot-keywords') ? json({ keywords: [kw] }) : json({}, 500);
      render(<BotKeywords />);
      expect(await screen.findByText('hello')).toBeInTheDocument();
    });

    it('shows a load failure instead of an empty list', async () => {
      api = () => json({ error: 'Unauthorized' }, 403);
      render(<BotKeywords />);
      expect(await screen.findByRole('alert')).toHaveTextContent('Unable to load bot keywords: Unauthorized');
      expect(screen.queryByText('No keywords found')).not.toBeInTheDocument();
    });

    it('a refused toggle is reported and sends only is_active', async () => {
      api = (url, init) => init?.method === 'PATCH' ? json({ error: 'Keyword was not updated. Refresh and try again.' }, 409) : json({ keywords: [kw] });
      render(<BotKeywords />);
      fireEvent.click(await screen.findByTitle('Deactivate'));
      await waitFor(() => expect(window.alert).toHaveBeenCalledWith('Failed to change keyword: Keyword was not updated. Refresh and try again.'));
      const patch = h.fetch.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === 'PATCH')!;
      expect(bodyOf(patch)).toEqual({ id: ID, is_active: false });
    });
  });

  describe('Users', () => {
    const profile = { id: ID, email: 'owner@example.test', first_name: 'Ola', last_name: 'B', phone: null, role: 'restaurant_owner', created_at: '2026-11-01T00:00:00Z' };

    it('suspends through the API and shows a refusal', async () => {
      h.fixtures.profiles = [profile];
      api = (url, init) => url.endsWith('/api/admin/users') ? json({ suspendedIds: [], platformRoles: {} })
        : init?.method === 'POST' ? json({ error: 'Failed to update user status' }, 500) : json({ error: 'no' }, 500);
      render(<UserManagement />);
      fireEvent.click((await screen.findAllByText('Ola B')).find(e => e.closest('tr'))!);
      fireEvent.click(await screen.findByRole('button', { name: 'Suspend User' }));
      await waitFor(() => expect(window.alert).toHaveBeenCalledWith('Failed to update user status: Failed to update user status'));
      expect(bodyOf(calls(new RegExp(`/api/admin/users/${ID}$`))[0])).toEqual({ action: 'suspend' });
      expect(h.directWrites).toEqual([]);
    });

    it('offers only account roles and sends the previous role for the change', async () => {
      h.fixtures.profiles = [profile];
      api = (url) => url.endsWith('/api/admin/users') ? json({ suspendedIds: [ID], platformRoles: {} }) : json({ role: 'restaurant_staff', auditRecorded: true });
      render(<UserManagement />);
      fireEvent.click((await screen.findAllByText('Ola B')).find(e => e.closest('tr'))!);
      const select = await screen.findByLabelText('Account role');
      expect(within(select).getAllByRole('option').map(o => (o as HTMLOptionElement).value)).toEqual(['restaurant_owner', 'restaurant_staff']);
      expect(screen.getByRole('button', { name: 'Reactivate User' })).toBeInTheDocument();
      fireEvent.change(select, { target: { value: 'restaurant_staff' } });
      fireEvent.click(screen.getByRole('button', { name: 'Update Role' }));
      await waitFor(() => expect(calls(new RegExp(`/api/admin/users/${ID}$`))).toHaveLength(1));
      expect(bodyOf(calls(new RegExp(`/api/admin/users/${ID}$`))[0])).toEqual({ action: 'set_role', role: 'restaurant_staff', previous_role: 'restaurant_owner' });
    });

    it('sends platform team members to Admin Team instead of offering actions', async () => {
      h.fixtures.profiles = [profile];
      api = () => json({ suspendedIds: [], platformRoles: { [ID]: 'support' } });
      render(<UserManagement />);
      fireEvent.click((await screen.findAllByText('Ola B')).find(e => e.closest('tr'))!);
      expect(await screen.findByText(/Manage their access on the Admin Team page/)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Suspend User' })).not.toBeInTheDocument();
    });

    it('shows when account status cannot be loaded and offers no actions', async () => {
      h.fixtures.profiles = [profile];
      api = () => json({ error: 'Unauthorized' }, 403);
      render(<UserManagement />);
      expect(await screen.findByRole('alert')).toHaveTextContent('Account status unavailable: Unauthorized');
      fireEvent.click((await screen.findAllByText('Ola B')).find(e => e.closest('tr'))!);
      expect(screen.getByText('Actions are unavailable until account status loads.')).toBeInTheDocument();
    });
  });

  it('WhatsApp Channels: the config modal no longer offers controls that cannot save', async () => {
    h.fixtures.whatsapp_config = [{ id: ID, business_id: BIZ, created_at: '2026-11-01T00:00:00Z', updated_at: null }];
    h.fixtures.businesses = [{ id: BIZ, name: 'Grace Church' }];
    render(<WhatsAppChannels />);
    fireEvent.click(await screen.findByRole('button', { name: /Configs/ }));
    fireEvent.click((await screen.findAllByText('Grace Church')).find(e => e.closest('tr'))!);
    expect(await screen.findByText(/Status and webhook URL can't be changed here/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Activate|Deactivate/ })).not.toBeInTheDocument();
  });
});

describe('X3: hidden reads come from admin read routes and failures are shown', () => {
  it('Chat History: live chats load from the API, messages use real columns', async () => {
    api = url => url.includes('conversationId=')
      ? json({ messages: [{ id: 'm1', conversation_id: ID, direction: 'outbound', message_text: 'We open at 9', media_type: null, created_at: '2026-11-01T00:00:00Z' }] })
      : url.endsWith('/api/admin/chat-history') ? json({ conversations: [{ id: ID, business_id: BIZ, business_name: 'Grace Church', customer_phone: '234', customer_name: 'Ada', status: 'open', last_message_at: null, created_at: '2026-11-01T00:00:00Z' }] })
      : json({}, 500);
    render(<ChatHistory />);
    fireEvent.click(await screen.findByRole('button', { name: 'Live Chats (1)' }));
    fireEvent.click(screen.getByText('Ada'));
    const message = (await screen.findByText('We open at 9')).parentElement!;
    // direction 'outbound' is the business's reply
    expect(within(message).getByText('Business')).toBeInTheDocument();
  });

  it('Chat History: a refused read is shown, not an empty list', async () => {
    api = () => json({ error: 'Unauthorized' }, 403);
    render(<ChatHistory />);
    fireEvent.click(await screen.findByRole('button', { name: 'Live Chats (unavailable)' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Unable to load live chats: Unauthorized');
    expect(screen.queryByText('No live chat conversations yet')).not.toBeInTheDocument();
  });

  it('Reports: rows come from the API; a failure is shown', async () => {
    api = () => json({ reports: [{ id: ID, business_id: BIZ, business_name: 'Clinic', customer_phone: '234', customer_name: 'Ada', title: 'Lab result', status: 'sent', sent_at: null, created_at: '2026-11-01T00:00:00Z' }] });
    render(<Reports />);
    expect(await screen.findByText('Lab result')).toBeInTheDocument();
    cleanup();
    api = () => json({ error: 'Could not load reports' }, 500);
    render(<Reports />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load reports: Could not load reports');
    expect(screen.queryByText('No reports found.')).not.toBeInTheDocument();
  });

  it('Queue: sends the date and status filter and shows a failure', async () => {
    api = () => json({ error: 'Unauthorized' }, 403);
    render(<QueueManagement />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load queue entries: Unauthorized');
    expect(String(calls(/queue-entries/)[0][0])).toMatch(/\/api\/admin\/queue-entries\?date=\d{4}-\d{2}-\d{2}$/);
    expect(screen.queryByText('No queue entries found.')).not.toBeInTheDocument();
  });
});

describe('Recurring payments: money actions stop pretending (out of scope for a server route)', () => {
  it('shows the actions disabled with an honest note and writes nothing', async () => {
    const { default: RecurringPayments } = await import('@/pages/RecurringPayments');
    h.fixtures.customer_subscriptions = [{ id: ID, business_id: BIZ, customer_name: 'Ada', customer_phone: '234', status: 'active', amount: 5000, currency: 'NGN', interval: 'month', failure_count: 0, created_at: '2026-11-01T00:00:00Z' }];
    h.fixtures.businesses = [{ id: BIZ, name: 'Gym' }];
    render(<RecurringPayments />);
    fireEvent.click((await screen.findAllByText('Ada')).find(e => e.closest('tr'))!);
    expect(await screen.findByText(/These actions are not available yet/)).toBeInTheDocument();
    for (const name of ['Pause', 'Cancel Subscription']) {
      const button = screen.getByRole('button', { name });
      expect(button).toBeDisabled();
      fireEvent.click(button);
    }
    expect(h.directWrites).toEqual([]);
  });
});
