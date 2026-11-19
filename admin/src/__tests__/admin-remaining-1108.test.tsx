/**
 * #1108 remaining non-money items: the admin pages render real data and report
 * the server's answer.
 *
 * Renders the real pages against a fake browser client that records every read
 * (table, columns, filters) and every direct write, plus a fake Admin API.
 * Proves, per item: the page asks for columns and enum values that exist (X4),
 * hidden reads go through /api/admin routes and show failures (X3), actions go
 * through /api/admin routes and show refusals instead of success (X2), and the
 * Channel Changes page explains when M496 is not installed.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Read = { table: string; select: string; filters: unknown[][] };
const h = vi.hoisted(() => ({
  fixtures: {} as Record<string, unknown[]>,
  reads: [] as Read[],
  queries: [] as Array<{ table: string; options: Record<string, unknown> }>,
  queryResult: {} as Record<string, { data?: unknown[] | null; count?: number; error?: string }>,
  directWrites: [] as Array<{ table: string; kind: string }>,
  fetch: vi.fn(),
}));

vi.mock('@/lib/supabase', () => {
  const from = (table: string) => {
    const read: Read = { table, select: '', filters: [] };
    const q: any = {};
    q.select = (cols: string) => { read.select = cols; return q; };
    for (const m of ['order', 'eq', 'in', 'limit', 'range', 'not', 'gte', 'lte', 'is', 'neq', 'gt', 'lt', 'or']) {
      q[m] = (...args: unknown[]) => { read.filters.push([m, ...args]); return q; };
    }
    for (const kind of ['update', 'delete', 'insert', 'upsert']) q[kind] = () => { h.directWrites.push({ table, kind }); return q; };
    const rows = () => { h.reads.push(read); return h.fixtures[table] || []; };
    q.maybeSingle = async () => ({ data: rows()[0] ?? null, error: null });
    q.single = q.maybeSingle;
    q.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
      const data = rows();
      return Promise.resolve({ data, error: null, count: data.length }).then(resolve, reject);
    };
    return q;
  };
  const auth = { getSession: async () => ({ data: { session: { access_token: 'synthetic-token', user: { id: 'admin-self', email: 'a@example.test' } } } }) };
  return { adminDb: { from, auth }, supabase: { from, auth } };
});
vi.mock('@/lib/adminQuery', () => ({
  adminQuery: async (table: string, options: Record<string, unknown> = {}) => {
    h.queries.push({ table, options });
    return h.queryResult[table] ?? { data: [], count: 0 };
  },
}));
const session = vi.hoisted(() => ({ userId: 'admin-self', email: 'a@example.test', role: 'admin' }));
vi.mock('@/components/AdminLayout', () => ({ useAdminSession: () => session }));
vi.mock('@/hooks/useStepUp', () => ({
  useStepUp: () => ({ execute: vi.fn(), isPending: false, state: { phase: 'idle', description: '', error: null }, submitCode: vi.fn(), reset: vi.fn() }),
}));
vi.mock('@/components/StepUpDialog', () => ({ StepUpDialog: () => null }));

import BotManagement from '@/pages/BotManagement';
import Support from '@/pages/Support';
import Surveys from '@/pages/Surveys';
import RecurringPayments from '@/pages/RecurringPayments';
import ChannelChanges from '@/pages/ChannelChanges';
import WhatsAppChannels from '@/pages/WhatsAppChannels';
import AIUsage from '@/pages/AIUsage';
import Broadcasts from '@/pages/Broadcasts';
import PendingTransfers from '@/pages/PendingTransfers';
import Bookings from '@/pages/Bookings';
import Orders from '@/pages/Orders';
import ImpersonationAudit from '@/pages/ImpersonationAudit';
import ImpersonationMode from '@/pages/ImpersonationMode';
import Subscriptions from '@/pages/Subscriptions';
import UserManagement from '@/pages/Users';
import Dashboard from '@/pages/Dashboard';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;
let api: Handler;
const calls = (pattern: RegExp) => h.fetch.mock.calls.filter(([url]) => pattern.test(String(url)));
const bodyOf = (call: unknown[]) => JSON.parse(String((call[1] as RequestInit).body));
const readsOf = (table: string) => h.reads.filter(r => r.table === table);

const BIZ = '11111111-1111-4111-8111-111111111111';
const ID = '22222222-2222-4222-8222-222222222222';
const CHANNEL = '33333333-3333-4333-8333-333333333333';
const NOW = new Date().toISOString();

beforeEach(() => {
  h.fixtures = {}; h.reads = []; h.queries = []; h.queryResult = {}; h.directWrites = [];
  api = () => json({ error: 'unexpected call' }, 500);
  h.fetch.mockReset();
  h.fetch.mockImplementation((url: string, init?: RequestInit) => Promise.resolve(api(String(url), init)));
  vi.stubEnv('VITE_API_URL', 'https://api.example.test');
  vi.stubGlobal('fetch', h.fetch);
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  vi.spyOn(window, 'alert').mockImplementation(() => {});
  Element.prototype.scrollIntoView = vi.fn();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('X2: Bot Management actions go through /api/admin/bot-sessions', () => {
  const sessionRow = {
    id: ID, business_id: BIZ, whatsapp_number: '2348011111111', is_active: true,
    session_data: { active_capability: 'giving' }, conversation_log: [], created_at: NOW, updated_at: NOW, last_active_at: NOW,
  };
  async function openSession() {
    h.fixtures.bot_sessions = [sessionRow, { ...sessionRow, id: 'other', session_data: { business_category: 'shop' } }];
    h.fixtures.businesses = [{ id: BIZ, name: 'Grace Church' }];
    render(<BotManagement />);
    fireEvent.click((await screen.findAllByText('2348011111111'))[0].closest('tr')!);
  }

  it('a refused end-session shows the reason, keeps it active and writes nothing directly', async () => {
    api = url => url.endsWith('/api/admin/bot-sessions') ? json({ error: 'Session has already ended.' }, 409) : json({}, 500);
    await openSession();
    fireEvent.click(await screen.findByRole('button', { name: 'End This Session' }));
    await waitFor(() => expect(window.alert).toHaveBeenCalledWith('Session has already ended.'));
    expect(bodyOf(calls(/bot-sessions$/)[0])).toEqual({ action: 'end', session_id: ID });
    expect(screen.getByRole('button', { name: 'End This Session' })).toBeInTheDocument();
    expect(h.directWrites).toEqual([]);
  });

  it('block and end-all report the server count', async () => {
    api = (_url, init) => {
      const body = JSON.parse(String(init?.body));
      return body.action === 'block' ? json({ blocked: true, ended: 1 }) : json({ ended: 2 });
    };
    await openSession();
    fireEvent.click(await screen.findByRole('button', { name: 'Block 2348011111111' }));
    await waitFor(() => expect(window.alert).toHaveBeenCalledWith('2348011111111 has been blocked. 1 active session(s) ended.'));
    expect(bodyOf(calls(/bot-sessions$/)[0])).toEqual({ action: 'block', business_id: BIZ, phone: '2348011111111' });
    fireEvent.click(screen.getByRole('button', { name: /Kill All Sessions for Grace Church/ }));
    await waitFor(() => expect(window.alert).toHaveBeenCalledWith('2 sessions ended'));
    expect(bodyOf(calls(/bot-sessions$/)[1])).toEqual({ action: 'end_all', business_id: BIZ });
    expect(h.directWrites).toEqual([]);
  });

  it('offers the flow values the sessions really have and no broken send box', async () => {
    await openSession();
    expect(screen.queryByPlaceholderText('Type a message...')).not.toBeInTheDocument();
    expect(screen.getByText(/Sending a message as the bot isn't available/)).toBeInTheDocument();
    const flowSelect = screen.getAllByRole('combobox').find(s => within(s).queryByText('All Flow Types'))!;
    expect(within(flowSelect).getAllByRole('option').map(o => (o as HTMLOptionElement).value)).toEqual(['all', 'giving', 'shop']);
  });
});

describe('Support: assignees come from Auth roles via /api/admin/team/assignees', () => {
  it('lists the API assignees and never reads profiles.role', async () => {
    h.fixtures.support_tickets = [{ id: ID, business_id: BIZ, subject: 'Help', status: 'open', priority: 'normal', created_at: NOW, updated_at: NOW }];
    api = url => url.endsWith('/api/admin/team/assignees') ? json({ assignees: [{ id: 'adm-1', name: 'Ada Admin' }] }) : json({}, 500);
    render(<Support />);
    fireEvent.click((await screen.findAllByText('Help')).find(e => e.closest('tr'))!);
    expect(await screen.findByRole('option', { name: 'Ada Admin' })).toBeInTheDocument();
    expect(h.reads.some(r => r.filters.some(f => f[0] === 'in' && f[1] === 'role'))).toBe(false);
  });

  it('shows when the team cannot be loaded', async () => {
    h.fixtures.support_tickets = [{ id: ID, business_id: BIZ, subject: 'Help', status: 'open', priority: 'normal', created_at: NOW, updated_at: NOW }];
    api = () => json({ error: 'Unauthorized' }, 403);
    render(<Support />);
    fireEvent.click((await screen.findAllByText('Help')).find(e => e.closest('tr'))!);
    expect(await screen.findByRole('alert')).toHaveTextContent('Unauthorized');
  });
});

describe('X3: hidden reads go through /api/admin and show failures', () => {
  it('Surveys: lists API rows, loads responses by survey ID, and never reads the tables directly', async () => {
    const survey = { id: ID, business_id: BIZ, business_name: 'Grace Church', title: 'Service feedback', description: null, questions: [{ id: 'q1', type: 'text', text: 'How?' }], status: 'active', total_responses: 1, created_at: NOW, updated_at: NOW };
    api = url => url.endsWith('/api/admin/surveys')
      ? json({ surveys: [survey] })
      : url.endsWith(`/api/admin/surveys?survey_id=${ID}`)
        ? json({ responses: [{ id: 'r1', survey_id: ID, customer_phone: '234', customer_name: 'Ola', answers: { q1: 'Great' }, completed: true, started_at: NOW, completed_at: NOW }] })
        : json({}, 500);
    render(<Surveys />);
    fireEvent.click((await screen.findAllByText('Service feedback')).find(e => e.closest('tr'))!);
    expect(await screen.findByText(/Great/)).toBeInTheDocument();
    expect(readsOf('surveys')).toEqual([]);
    expect(readsOf('survey_responses')).toEqual([]);
  });

  it('Surveys: a failed read is an error, not "No surveys found"', async () => {
    api = () => json({ error: 'Could not load surveys' }, 500);
    render(<Surveys />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load surveys');
    expect(screen.queryByText('No surveys found')).not.toBeInTheDocument();
  });

  it('Recurring: a failed read is an error, not an empty list', async () => {
    api = () => json({ error: 'Unauthorized' }, 403);
    render(<RecurringPayments />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Unauthorized');
    expect(screen.queryByText('No recurring payments found')).not.toBeInTheDocument();
    expect(readsOf('customer_subscriptions')).toEqual([]);
  });

  it('Subscriptions: the override count is read server-side', async () => {
    h.fixtures.subscriptions = [{ id: ID, business_id: BIZ, plan: 'growth', status: 'active', amount: 5000, currency: 'NGN', billing_interval: 'month', created_at: NOW, businesses: { name: 'Acme Shop', category: 'retail', subscription_tier: 'growth', trial_ends_at: null } }];
    h.queryResult.capability_overrides = { data: null, count: 2 };
    render(<Subscriptions />);
    fireEvent.click((await screen.findAllByText('Acme Shop')).find(e => e.closest('tr'))!);
    await waitFor(() => expect(h.queries.some(q => q.table === 'capability_overrides')).toBe(true));
    expect(h.queries.find(q => q.table === 'capability_overrides')!.options).toMatchObject({
      count: 'exact', filters: [{ column: 'business_id', op: 'eq', value: BIZ }],
    });
    expect(readsOf('capability_overrides')).toEqual([]);
  });

  it('Subscriptions: Extend Trial and Cancel are off with an honest note and write nothing (Owner 2026-11-18)', async () => {
    h.fixtures.subscriptions = [{ id: ID, business_id: BIZ, plan: 'growth', status: 'active', amount: 5000, currency: 'NGN', billing_interval: 'month', created_at: NOW, businesses: { name: 'Acme Shop', category: 'retail', subscription_tier: 'growth', trial_ends_at: null } }];
    render(<Subscriptions />);
    fireEvent.click((await screen.findAllByText('Acme Shop')).find(e => e.closest('tr'))!);
    expect(await screen.findByText(/Extend Trial and Cancel Subscription are not available yet/)).toBeInTheDocument();
    const extend = screen.getByRole('button', { name: 'Extend' });
    const cancel = screen.getByRole('button', { name: 'Cancel Subscription...' });
    expect(extend).toBeDisabled();
    expect(cancel).toBeDisabled();
    fireEvent.click(extend);
    fireEvent.click(cancel);
    expect(screen.queryByRole('button', { name: 'Confirm Cancel' })).not.toBeInTheDocument();
    expect(h.directWrites).toEqual([]);
    expect(calls(/\/api\/admin\/audit/)).toEqual([]);
  });
});

describe('Channel Changes when M496 is not installed', () => {
  it('explains the feature is not set up instead of a load error, and hides Create', async () => {
    api = () => json({ code: 'CHANNEL_CHANGES_NOT_INSTALLED', error: 'Channel change requests are not set up on this environment yet.' }, 503);
    render(<ChannelChanges />);
    expect(await screen.findByRole('status')).toHaveTextContent('not set up on this environment yet');
    expect(screen.queryByText(/Unable to load requests/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Create Request/ })).not.toBeInTheDocument();
  });

  it('still shows a retryable error for a real failure', async () => {
    api = () => json({ error: 'Unable to process channel change' }, 500);
    render(<ChannelChanges />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Unable to load requests');
    expect(screen.getByRole('button', { name: 'Retry loading requests' })).toBeInTheDocument();
  });
});

describe('X4: real columns and enum values', () => {
  it('WhatsApp Channels: the configs tab shows bot settings columns, not missing ones', async () => {
    h.fixtures.whatsapp_channels = [];
    h.fixtures.whatsapp_config = [{ id: ID, business_id: BIZ, bot_alias: 'gracebot', auto_confirm: true, created_at: NOW, updated_at: NOW }];
    h.fixtures.businesses = [{ id: BIZ, name: 'Grace Church' }];
    render(<WhatsAppChannels />);
    fireEvent.click(await screen.findByRole('button', { name: /Business Configs/ }));
    const row = (await screen.findByText('gracebot')).closest('tr')!;
    expect(row).toHaveTextContent('Grace Church');
    expect(row).toHaveTextContent('On');
    expect(screen.queryByRole('columnheader', { name: /Webhook URL/ })).not.toBeInTheDocument();
    expect(screen.getByText('Auto-confirm on')).toBeInTheDocument();
  });

  it('AI Usage: totals include translations, voice notes and AI setup', async () => {
    h.fixtures.ai_usage = [{ id: ID, business_id: BIZ, month_key: '2026-11', intent_calls: 101, translate_calls: 0, detect_lang_calls: 0, translation_count: 316, voice_transcription_count: 4, ai_fallback_count: 0, ace_setup_count: 2 }];
    h.fixtures.businesses = [{ id: BIZ, name: 'Grace Church' }];
    render(<AIUsage />);
    const row = (await screen.findByText('Grace Church')).closest('tr')!;
    expect(within(row).getAllByRole('cell').map(c => c.textContent)).toEqual(['Grace Church', '101', '316', '0', '4', '2', '423', '$0.423']);
    // The Total API Calls card shows the same figure as the row.
    expect(screen.getAllByText('423')).toHaveLength(2);
  });

  it('Orders and Bookings: status filters offer the real enum values', async () => {
    api = url => url.endsWith('/api/admin/orders') ? json({ data: [] }) : json({}, 500);
    render(<Orders />);
    const orderSelect = (await screen.findAllByRole('combobox')).find(s => within(s).queryByText('All Statuses'))!;
    expect(within(orderSelect).getAllByRole('option').map(o => (o as HTMLOptionElement).value)).toEqual(
      ['all', 'draft', 'pending', 'paid_pending_approval', 'confirmed', 'processing', 'shipped', 'ready', 'delivered', 'cancelled']);
    cleanup();
    render(<Bookings />);
    const bookingSelect = (await screen.findAllByRole('combobox')).find(s => within(s).queryByText('All Statuses'))!;
    expect(within(bookingSelect).getAllByRole('option').map(o => (o as HTMLOptionElement).value)).toEqual(
      ['all', 'pending', 'confirmed', 'in_progress', 'completed', 'no_show', 'cancelled']);
  });

  it('Pending Transfers has a Cancelled tab that shows cancelled transfers', async () => {
    h.fixtures.pending_transfers = [{ id: ID, business_id: BIZ, reference_code: 'BT-CAN', status: 'cancelled', expected_amount: 100, currency: 'NGN', created_at: NOW }];
    h.fixtures.businesses = [{ id: BIZ, name: 'Grace Church' }];
    render(<PendingTransfers />);
    fireEvent.click(await screen.findByRole('button', { name: 'Cancelled' }));
    expect(await screen.findByText('BT-CAN')).toBeInTheDocument();
  });

  it('Impersonation Audit can filter View Dashboard links', async () => {
    h.fixtures.impersonation_logs = [];
    render(<ImpersonationAudit />);
    expect(await screen.findByRole('option', { name: 'View Dashboard Link' })).toHaveValue('login_as_token_generated');
  });

  it('Users: booking and payment counts filter on user_id', async () => {
    h.fixtures.profiles = [{ id: ID, first_name: 'Ola', last_name: 'B', email: 'o@example.test', role: 'restaurant_owner', created_at: NOW }];
    api = url => url.endsWith('/api/admin/users') ? json({ suspendedIds: [], platformRoles: {} }) : json({}, 500);
    render(<UserManagement />);
    fireEvent.click((await screen.findAllByText('Ola B')).find(e => e.closest('tr'))!);
    await waitFor(() => expect(readsOf('payments').length).toBeGreaterThan(0));
    for (const table of ['bookings', 'payments']) {
      const filters = readsOf(table).flatMap(r => r.filters);
      expect(filters).toContainEqual(['eq', 'user_id', ID]);
      expect(filters.some(f => f[1] === 'customer_id')).toBe(false);
    }
  });

  it('Dashboard: the churned card counts suspended only (no "cancelled" enum value)', async () => {
    // Dashboard imports adminQuery dynamically; vitest may resolve one of those imports to the
    // real helper, so record queries both from the mock and from the /api/admin/query proxy body.
    api = (url, init) => {
      if (url.endsWith('/api/admin/query')) {
        const body = JSON.parse(String(init?.body));
        h.queries.push({ table: body.table, options: body });
        return json({ data: [], count: 0 });
      }
      return json({}, 500);
    };
    render(<MemoryRouter><Dashboard /></MemoryRouter>);
    const businessStatusFilters = () => h.queries.filter(q => q.table === 'businesses')
      .flatMap(q => (q.options.filters as Array<{ column: string; value: unknown }> | undefined) || [])
      .filter(f => f.column === 'status');
    await waitFor(() => expect(businessStatusFilters().some(f => f.value === 'suspended')).toBe(true));
    expect(businessStatusFilters().some(f => JSON.stringify(f.value).includes('cancelled'))).toBe(false);
  });

  it('Subscriptions: the trial count uses the feature-trial clock on the free tier (M525)', async () => {
    const future = new Date(Date.now() + 5 * 86_400_000).toISOString();
    const past = new Date(Date.now() - 5 * 86_400_000).toISOString();
    h.fixtures.subscriptions = [
      { id: 'a', business_id: 'b1', plan: 'free', status: 'active', amount: 0, currency: 'NGN', billing_interval: 'month', created_at: NOW, businesses: { name: 'In Trial Co', category: 'retail', subscription_tier: 'free', feature_trial_ends_at: future } },
      { id: 'b', business_id: 'b2', plan: 'business', status: 'active', amount: 120000, currency: 'NGN', billing_interval: 'year', created_at: NOW, businesses: { name: 'Paid Co', category: 'retail', subscription_tier: 'business', feature_trial_ends_at: past } },
      // Upgraded businesses are not on trial even if the clock has not run out.
      { id: 'c', business_id: 'b3', plan: 'growth', status: 'active', amount: 5000, currency: 'NGN', billing_interval: 'month', created_at: NOW, businesses: { name: 'Upgraded Co', category: 'retail', subscription_tier: 'growth', feature_trial_ends_at: future } },
      // The messaging-credit clock (trial_ends_at) is not the trial.
      { id: 'd', business_id: 'b4', plan: 'free', status: 'active', amount: 0, currency: 'NGN', billing_interval: 'month', created_at: NOW, businesses: { name: 'Credit Only Co', category: 'retail', subscription_tier: 'free', trial_ends_at: future, feature_trial_ends_at: null } },
    ];
    render(<Subscriptions />);
    expect((await screen.findAllByText('On Trial'))[0].nextElementSibling).toHaveTextContent('1');
    // billing_interval 'year' (M215) is shown per year.
    expect((await screen.findAllByText('Paid Co')).find(e => e.closest('tr'))!.closest('tr')).toHaveTextContent('/yr');
  });
});

describe('Impersonation: reads real columns and saves through the profile route', () => {
  async function openBusiness() {
    h.fixtures.businesses = [{ id: BIZ, name: 'Grace Church', category: 'church', country_code: 'NG', status: 'active', created_at: NOW, phone: '+2348000000000', email: null, assigned_channel_id: CHANNEL }];
    h.fixtures.whatsapp_channels = [{ id: CHANNEL, phone_number: '+2349000000000', display_name: 'Waaiio NG', channel_type: 'shared', connection_status: 'active' }];
    h.fixtures.bookings = [{ id: ID, service_id: 'svc', guest_name: 'Ada Guest', status: 'confirmed', total_amount: 5000, created_at: NOW }];
    h.fixtures.services = [{ id: 'svc', name: 'Counselling' }];
    render(<ImpersonationMode />);
    fireEvent.focus(await screen.findByPlaceholderText('Search businesses by name...'));
    fireEvent.change(screen.getByPlaceholderText('Search businesses by name...'), { target: { value: 'Grace' } });
    fireEvent.click(await screen.findByText('Grace Church', { selector: 'button *, button' }));
    await screen.findByText('+2349000000000');
  }

  it('shows the assigned channel and booking guest/service, from columns that exist', async () => {
    await openBusiness();
    expect(readsOf('whatsapp_config')).toEqual([]);
    expect(readsOf('whatsapp_channels')[0].select).toBe('id, phone_number, display_name, channel_type, connection_status');
    expect(readsOf('bookings')[0].select).toBe('id, service_id, guest_name, status, total_amount, created_at');
    const row = (await screen.findByText('Ada Guest')).closest('tr')!;
    expect(row).toHaveTextContent('Counselling');
  });

  it('a refused edit says why and does not write businesses directly', async () => {
    api = url => url.endsWith(`/api/admin/businesses/${BIZ}/profile`) ? json({ error: 'Invalid profile value' }, 400) : json({}, 500);
    await openBusiness();
    fireEvent.click(screen.getByTitle('Edit Phone'));
    fireEvent.change(screen.getByDisplayValue('+2348000000000'), { target: { value: 'not a phone' } });
    fireEvent.click(screen.getByTitle('Save'));
    await waitFor(() => expect(window.alert).toHaveBeenCalledWith('Invalid profile value'));
    expect(bodyOf(calls(/\/profile$/)[0])).toEqual({ field: 'phone', value: 'not a phone' });
    expect(h.directWrites.filter(w => w.table === 'businesses')).toEqual([]);
  });

  it('a saved edit shows the value the server saved', async () => {
    api = () => json({ business: { id: BIZ, phone: '+2348111111111' }, auditRecorded: true });
    await openBusiness();
    fireEvent.click(screen.getByTitle('Edit Phone'));
    fireEvent.change(screen.getByDisplayValue('+2348000000000'), { target: { value: '+2348111111111' } });
    fireEvent.click(screen.getByTitle('Save'));
    expect(await screen.findByText('+2348111111111')).toBeInTheDocument();
    expect(h.directWrites.filter(w => w.table === 'businesses')).toEqual([]);
  });
});

describe('Broadcasts history sorts by column', () => {
  it('sorts by recipients when the header is clicked', async () => {
    h.fixtures.admin_broadcasts = [
      { id: 'b1', channel: 'email', audience: 'all_users', subject: 'Small', recipient_count: 3, status: 'sent', created_at: NOW, sent_at: NOW },
      { id: 'b2', channel: 'email', audience: 'all_users', subject: 'Large', recipient_count: 40, status: 'sent', created_at: NOW, sent_at: NOW },
      { id: 'b3', channel: 'whatsapp', audience: 'all_users', subject: 'Middle', recipient_count: 12, status: 'sent', created_at: NOW, sent_at: NOW },
    ];
    render(<Broadcasts />);
    await screen.findByText('Middle');
    const subjects = () => screen.getAllByRole('row').slice(1).map(r => within(r).getAllByRole('cell')[2].textContent);
    fireEvent.click(screen.getByRole('button', { name: /Recipients/ }));
    expect(subjects()).toEqual(['Small', 'Middle', 'Large']);
    fireEvent.click(screen.getByRole('button', { name: /Recipients/ }));
    expect(subjects()).toEqual(['Large', 'Middle', 'Small']);
  });
});
