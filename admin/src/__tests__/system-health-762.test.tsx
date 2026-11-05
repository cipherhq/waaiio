import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const f = vi.hoisted(() => ({
  count: 7 as number | null, channels: 1,
  failure: null as null | { table: string; scope: 'service' | 'stat'; mode: 'returned' | 'thrown' | 'unknown' },
  calls: [] as Array<{ table: string; columns: string; options: unknown; filters: unknown[] }>,
  pending: null as Promise<void> | null,
}));
vi.mock('@/lib/supabase', () => ({
  adminDb: {
    from: (table: string) => {
      const query = { table, columns: '', options: undefined as unknown, filters: [] as unknown[] };
      const result = async () => {
        const scope = f.calls.length < 7 ? 'service' : 'stat';
        f.calls.push(query);
        if (f.pending) await f.pending;
        const failure = f.failure?.table === table && f.failure.scope === scope ? f.failure.mode : null;
        if (failure === 'thrown') throw new Error('Synthetic rejected read');
        const data = table === 'whatsapp_channels' ? Array.from({ length: f.channels }, () => ({ is_active: true })) :
          table === 'platform_settings' ? [{ key: 'synthetic' }] : null;
        return { data: failure === 'unknown' ? null : data, count: failure === 'unknown' ? null : f.count,
          error: failure === 'returned' ? { message: 'Synthetic returned error' } : null };
      };
      const chain = {
        select: (columns: string, options?: unknown) => { query.columns = columns; query.options = options; return chain; },
        eq: (...args: unknown[]) => { query.filters.push(args); return chain; },
        limit: (...args: unknown[]) => { query.filters.push(['limit', ...args]); return chain; },
        then: (resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) => result().then(resolve, reject),
      };
      return chain;
    },
  },
}));
vi.mock('@/lib/formatters', () => ({ fmtDateTime: () => 'checked time' }));
import SystemHealth from '@/pages/SystemHealth';
const services = [
  ['businesses', 'Database'], ['profiles', 'Auth / Profiles'],
  ['payments', 'Payment System'], ['business_payouts', 'Payment System'],
  ['whatsapp_channels', 'WhatsApp Channels'], ['bot_sessions', 'Bot Engine'], ['platform_settings', 'Platform Config'],
];
const tables = ['businesses', 'profiles', 'bookings', 'payments', 'orders', 'bot_sessions', 'services', 'products', 'events', 'customer_subscriptions'];
const service = (name: string) => screen.getByRole('group', { name: 'Check ' + name });
const stat = (table: string) => screen.getByRole('group', { name: 'Table ' + table });
async function complete() { await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled()); }
beforeEach(() => { f.count = 7; f.channels = 1; f.failure = null; f.calls.length = 0; f.pending = null; });
afterEach(cleanup);

describe('actual SystemHealth database readability', () => {
  it('uses head-only nonzero count and matching table statistics, without provider certification', async () => {
    render(<SystemHealth />); await complete();
    expect(service('Database')).toHaveTextContent('7 businesses');
    expect(stat('businesses')).toHaveTextContent('7');
    expect(service('Bot Engine')).toHaveTextContent('7 active sessions');
    expect(screen.getByText('Database Reads OK')).toBeInTheDocument();
    expect(screen.getByText(/do not certify provider availability/)).toBeInTheDocument();
    expect(f.calls).toHaveLength(17);
    expect(f.calls[0]).toMatchObject({ table: 'businesses', columns: 'id', options: { count: 'exact', head: true } });
    expect(f.calls[4].filters).toContainEqual(['is_active', true]);
    expect(f.calls[5].filters).toContainEqual(['is_active', true]);
  });
  it('treats genuine zero counts as known values', async () => {
    f.count = 0; render(<SystemHealth />); await complete();
    expect(service('Database')).toHaveTextContent('0 businesses');
    expect(service('Bot Engine')).toHaveTextContent('0 active sessions');
    for (const table of tables) expect(within(stat(table)).getByText('0')).toBeInTheDocument();
    expect(screen.getByText('Database Reads OK')).toBeInTheDocument();
  });
  it('preserves the zero-active-channel issue instead of calling it a read failure', async () => {
    f.channels = 0; render(<SystemHealth />); await complete();
    expect(service('WhatsApp Channels')).toHaveTextContent('0 active channels');
    expect(service('WhatsApp Channels')).not.toHaveTextContent('database read failed');
    expect(screen.getByText('Issues Detected')).toBeInTheDocument();
  });
  for (const mode of ['returned', 'thrown'] as const) {
    it.each(services)('%s service failure (' + mode + ') is unavailable while other probes continue', async (table, name) => {
      f.failure = { table, scope: 'service', mode };
      render(<SystemHealth />); await complete();
      expect(service(name)).toHaveTextContent('Unavailable');
      expect(service(name)).not.toHaveTextContent('Readable');
      expect(screen.getByText('Issues Detected')).toBeInTheDocument();
      expect(f.calls).toHaveLength(17);
      const unaffected = name === 'Platform Config' ? 'Database' : 'Platform Config';
      expect(service(unaffected)).toHaveTextContent('Readable');
      expect(stat('products')).toHaveTextContent('7');
    });
  }
  it.each(services)('%s missing result/count is unknown', async (table, name) => {
    f.failure = { table, scope: 'service', mode: 'unknown' };
    render(<SystemHealth />); await complete();
    expect(service(name)).toHaveTextContent('Unavailable');
    expect(service(name)).not.toHaveTextContent('0 businesses');
    expect(screen.getByText('Issues Detected')).toBeInTheDocument();
  });
  for (const mode of ['returned', 'thrown', 'unknown'] as const) {
    it.each(tables)('%s table statistic (' + mode + ') is unavailable and affects overall status', async table => {
      f.failure = { table, scope: 'stat', mode };
      render(<SystemHealth />); await complete();
      expect(stat(table)).toHaveTextContent('Unavailable');
      expect(within(stat(table)).queryByText('0')).not.toBeInTheDocument();
      expect(service('Database')).toHaveTextContent('Readable');
      expect(screen.getByText('Issues Detected')).toBeInTheDocument();
      expect(f.calls).toHaveLength(17);
    });
  }
  it.each(['returned', 'thrown'] as const)('refresh recovers from %s errors and clears stale healthy/error detail while checking', async mode => {
    render(<SystemHealth />); await complete();
    let release!: () => void;
    f.pending = new Promise<void>(resolve => { release = resolve; });
    f.calls.length = 0; f.failure = { table: 'businesses', scope: 'service', mode };
    await userEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(screen.queryByText('7 businesses')).not.toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Table businesses' })).not.toBeInTheDocument();
    expect(screen.queryByText(/Last checked/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Checking...' }));
    expect(f.calls).toHaveLength(1);
    await act(async () => { f.pending = null; release(); }); await complete();
    expect(service('Database')).toHaveTextContent('Unavailable');
    f.calls.length = 0; f.failure = null; f.count = 9;
    await userEvent.click(screen.getByRole('button', { name: 'Refresh' })); await complete();
    expect(service('Database')).toHaveTextContent('9 businesses');
    expect(stat('businesses')).toHaveTextContent('9');
    expect(screen.getByText('Database Reads OK')).toBeInTheDocument();
    expect(screen.queryByText(/Unavailable/)).not.toBeInTheDocument();
    expect(f.calls).toHaveLength(17);
  });
});
