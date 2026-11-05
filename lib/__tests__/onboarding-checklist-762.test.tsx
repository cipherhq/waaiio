// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, unknown>;
type Result = { count: number | null; error: { message: string } | null };
const state = vi.hoisted(() => ({
  business: { id: 'own', bot_code: '' },
  capabilities: [] as string[],
  rows: {} as Record<string, Row[]>,
  responses: new Map<string, Promise<Result>>(),
  queries: [] as Array<{ table: string; filters: Array<[string, string, unknown]> }>,
}));
vi.mock('@/components/dashboard/DashboardProvider', () => ({
  useBusiness: () => state.business,
  useCapabilities: () => ({ hasCapability: (cap: string) => state.capabilities.includes(cap) }),
}));
vi.mock('next/link', () => ({
  default: ({ children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => <a {...props}>{children}</a>,
}));
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    from: (table: string) => {
      const filters: Array<[string, string, unknown]> = [];
      const query = {
        select: (columns: string, options: { count: string; head: boolean }) => {
          expect(columns).toBe('id');
          expect(options).toEqual({ count: 'exact', head: true });
          return query;
        },
        eq: (column: string, value: unknown) => { filters.push(['eq', column, value]); return query; },
        gt: (column: string, value: number) => { filters.push(['gt', column, value]); return query; },
        then: (resolve: (value: Result) => unknown, reject?: (reason: unknown) => unknown) => {
          state.queries.push({ table, filters: [...filters] });
          const businessId = filters.find(([op, column]) => op === 'eq' && column === 'business_id')?.[2];
          const response = state.responses.get(table + ':' + businessId);
          const rows = (state.rows[table] || []).filter(row => filters.every(([op, column, value]) =>
            op === 'eq' ? row[column] === value : Number(row[column]) > Number(value)));
          return (response || Promise.resolve({ count: rows.length, error: null })).then(resolve, reject);
        },
      };
      return query;
    },
  }),
}));
import { OnboardingChecklist } from '@/components/dashboard/OnboardingChecklist';

function add(table: string, row: Row = {}) {
  (state.rows[table] ||= []).push({ id: table + '-row', business_id: 'own', ...row });
}
async function settled() {
  await screen.findByRole('heading', { name: 'Getting started with Waaiio' });
}
function done(label: string) {
  return screen.getByText(label, { exact: true }).classList.contains('line-through');
}
function deferred() {
  let resolve!: (result: Result) => void;
  const promise = new Promise<Result>(r => { resolve = r; });
  return { promise, resolve };
}
beforeEach(() => {
  state.business = { id: 'own', bot_code: '' };
  state.capabilities = [];
  state.rows = {};
  state.responses.clear();
  state.queries = [];
  localStorage.clear();
});
afterEach(cleanup);

describe('#762 actual onboarding checklist', () => {
  it.each(['2026-10', '2025-01'])('recognizes own positive inbound usage in month %s without chat', async month_key => {
    add('conversation_usage', { month_key, inbound_count: 1, outbound_count: 0 });
    render(<OnboardingChecklist />);
    await settled();
    expect(done('Test your bot')).toBe(true);
    expect(screen.getByText('1 of 4 steps completed')).toBeTruthy();
  });

  it('retains legitimate own inbound-chat fallback', async () => {
    add('chat_messages', { direction: 'inbound' });
    render(<OnboardingChecklist />);
    await settled();
    expect(done('Test your bot')).toBe(true);
  });

  it('does not infer a test from saved bot configuration', async () => {
    state.business.bot_code = 'OWN';
    add('whatsapp_config', { bot_greeting: 'Saved greeting' });
    render(<OnboardingChecklist />);
    await settled();
    expect(done('Connect your WhatsApp number')).toBe(true);
    expect(done('Test your bot')).toBe(false);
  });

  it('does not complete for outbound-only activity', async () => {
    add('conversation_usage', { inbound_count: 0, outbound_count: 12 });
    add('chat_messages', { direction: 'outbound' });
    render(<OnboardingChecklist />);
    await settled();
    expect(done('Test your bot')).toBe(false);
  });

  it('filters evidence from another business in both tables', async () => {
    add('conversation_usage', { business_id: 'other', inbound_count: 7 });
    add('chat_messages', { business_id: 'other', direction: 'inbound' });
    render(<OnboardingChecklist />);
    await settled();
    expect(done('Test your bot')).toBe(false);
    for (const table of ['conversation_usage', 'chat_messages']) {
      expect(state.queries.find(q => q.table === table)?.filters).toContainEqual(['eq', 'business_id', 'own']);
    }
  });

  it('keeps empty evidence incomplete', async () => {
    render(<OnboardingChecklist />);
    await settled();
    expect(done('Test your bot')).toBe(false);
    expect(screen.getByText('0 of 4 steps completed')).toBeTruthy();
  });

  it('does not trust counts accompanying returned query errors', async () => {
    for (const table of ['conversation_usage', 'chat_messages']) {
      state.responses.set(table + ':own', Promise.resolve({ count: 9, error: { message: 'Fixture error' } }));
    }
    render(<OnboardingChecklist />);
    await settled();
    expect(done('Test your bot')).toBe(false);
    expect(localStorage.getItem('waaiio-checklist-dismissed-own')).toBeNull();
  });

  it('handles a rejected usage query without losing valid chat evidence', async () => {
    const pending = deferred();
    state.responses.set('conversation_usage:own', pending.promise.then(() => { throw new Error('Fixture rejection'); }));
    add('chat_messages', { direction: 'inbound' });
    render(<OnboardingChecklist />);
    await act(async () => { pending.resolve({ count: null, error: null }); });
    await settled();
    expect(done('Test your bot')).toBe(true);
  });

  it('handles a rejected chat query while retaining valid usage evidence', async () => {
    const pending = deferred();
    state.responses.set('chat_messages:own', pending.promise.then(() => { throw new Error('Fixture rejection'); }));
    add('conversation_usage', { inbound_count: 1 });
    render(<OnboardingChecklist />);
    await act(async () => { pending.resolve({ count: null, error: null }); });
    await settled();
    expect(done('Test your bot')).toBe(true);
  });

  it('keeps the test incomplete when both evidence queries reject', async () => {
    const pending = deferred();
    const failure = pending.promise.then(() => { throw new Error('Fixture rejection'); });
    state.responses.set('conversation_usage:own', failure);
    state.responses.set('chat_messages:own', failure);
    render(<OnboardingChecklist />);
    await act(async () => { pending.resolve({ count: null, error: null }); });
    await settled();
    expect(done('Test your bot')).toBe(false);
  });

  it('ignores old results and auto-dismissal after a business switch with reversed completion', async () => {
    const pending = deferred();
    state.responses.set('conversation_usage:own', pending.promise);
    state.business.bot_code = 'OWN';
    add('services');
    add('payout_accounts', { is_active: true });
    const view = render(<OnboardingChecklist />);
    await waitFor(() => expect(state.queries.some(q => q.table === 'conversation_usage')).toBe(true));
    state.business = { id: 'other', bot_code: '' };
    view.rerender(<OnboardingChecklist />);
    await settled();
    expect(screen.getByText('0 of 4 steps completed')).toBeTruthy();
    await act(async () => { pending.resolve({ count: 1, error: null }); });
    expect(screen.getByText('0 of 4 steps completed')).toBeTruthy();
    expect(done('Test your bot')).toBe(false);
    expect(localStorage.getItem('waaiio-checklist-dismissed-own')).toBeNull();
    expect(localStorage.getItem('waaiio-checklist-dismissed-other')).toBeNull();
  });

  it('resets completed/loading state before displaying the next business', async () => {
    add('conversation_usage', { inbound_count: 1 });
    const view = render(<OnboardingChecklist />);
    await settled();
    expect(done('Test your bot')).toBe(true);
    const pending = deferred();
    state.responses.set('conversation_usage:other', pending.promise);
    state.business = { id: 'other', bot_code: '' };
    view.rerender(<OnboardingChecklist />);
    expect(screen.queryByText('Test your bot')).toBeNull();
    await act(async () => { pending.resolve({ count: 0, error: null }); });
    await settled();
    expect(done('Test your bot')).toBe(false);
  });

  it('resets dismissal on switch and preserves each business dismissal key', async () => {
    const view = render(<OnboardingChecklist />);
    await settled();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(localStorage.getItem('waaiio-checklist-dismissed-own')).toBe('true');
    state.business = { id: 'other', bot_code: '' };
    view.rerender(<OnboardingChecklist />);
    await settled();
    expect(screen.getByText('0 of 4 steps completed')).toBeTruthy();
    state.business = { id: 'own', bot_code: '' };
    view.rerender(<OnboardingChecklist />);
    expect(screen.queryByText('Test your bot')).toBeNull();
    expect(localStorage.getItem('waaiio-checklist-dismissed-other')).toBeNull();
  });

  it('preserves automatic dismissal when all existing predicates complete', async () => {
    state.business.bot_code = 'OWN';
    add('services');
    add('payout_accounts', { is_active: true, verified_at: null });
    add('conversation_usage', { inbound_count: 1 });
    render(<OnboardingChecklist />);
    await waitFor(() => expect(localStorage.getItem('waaiio-checklist-dismissed-own')).toBe('true'));
    expect(screen.queryByText('Test your bot')).toBeNull();
  });

  it('preserves active-channel and payout predicates without accepting another business', async () => {
    add('whatsapp_channels', { is_active: false });
    add('whatsapp_channels', { business_id: 'other', is_active: true });
    add('payout_accounts', { is_active: false });
    add('payout_accounts', { business_id: 'other', is_active: true });
    const view = render(<OnboardingChecklist />);
    await settled();
    expect(done('Connect your WhatsApp number')).toBe(false);
    expect(done('Get paid & go live')).toBe(false);
    view.unmount();
    add('whatsapp_channels', { is_active: true });
    add('payout_accounts', { is_active: true, verified_at: null });
    render(<OnboardingChecklist />);
    await settled();
    expect(done('Connect your WhatsApp number')).toBe(true);
    expect(done('Get paid & go live')).toBe(true);
  });

  it.each([
    ['appointment', 'appointments', 'Add your appointments'],
    ['ordering', 'products', 'Add your products'],
    ['reservation', 'properties', 'Add your properties'],
    ['ticketing', 'events', 'Create your first event'],
    ['giving', 'services', 'Set up giving categories'],
    ['', 'services', 'Add your services'],
  ])('preserves %s setup predicate', async (capability, table, label) => {
    state.capabilities = capability ? [capability] : [];
    add(table, { service_type: capability === 'giving' ? 'giving' : 'booking' });
    render(<OnboardingChecklist />);
    await settled();
    expect(done(label)).toBe(true);
    expect(done('Test your bot')).toBe(false);
    expect(state.queries.find(q => q.table === table)?.filters).toContainEqual(['eq', 'business_id', 'own']);
    if (capability === 'giving') {
      expect(state.queries.find(q => q.table === table)?.filters).toContainEqual(['eq', 'service_type', 'giving']);
    }
  });
});
