import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const m = vi.hoisted(() => ({
  status: 200, result: {} as Record<string, unknown>, fetch: vi.fn(), execute: vi.fn(),
}));
vi.mock('@/lib/supabase', () => ({
  supabase: { auth: { getSession: async () => ({ data: { session: { access_token: 'qa-bearer' } } }) } },
  adminDb: {},
}));
vi.mock('@/components/AdminLayout', () => ({ useAdminSession: () => ({ role: 'admin' }) }));
vi.mock('@/lib/countries', () => ({ loadCountries: async () => {}, getCountryCurrencyDetailMap: () => ({}) }));
vi.mock('@/hooks/useStepUp', () => ({ useStepUp: () => ({
  execute: m.execute, state: { phase: 'idle', description: '', error: '' }, reset: vi.fn(),
}) }));
import Payouts from '../pages/Payouts';

beforeEach(() => {
  vi.clearAllMocks(); m.status = 200; m.result = { created: 2, held: 0, skipped: 0, failed: 0 };
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  vi.spyOn(window, 'alert').mockImplementation(() => {});
  m.execute.mockImplementation(async ({ onAuthorized }: { onAuthorized: (id: string) => Promise<void> }) => onAuthorized('qa-step-up'));
  m.fetch.mockImplementation(async (url: string) => new Response(JSON.stringify(
    url.endsWith('/api/admin/payouts/generate') ? m.result : { payouts: [], total_pages: 1 },
  ), { status: url.endsWith('/api/admin/payouts/generate') ? m.status : 200 }));
  vi.stubGlobal('fetch', m.fetch);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

async function generate() {
  render(<Payouts />);
  fireEvent.click(await screen.findByRole('button', { name: 'Generate Weekly Payouts' }));
  await waitFor(() => expect(window.alert).toHaveBeenCalled());
  expect(m.execute).toHaveBeenCalledWith(expect.objectContaining({ actionType: 'payout_generate', targetId: null, params: { action: 'generate' } }));
  const post = m.fetch.mock.calls.find(([url]) => url.endsWith('/api/admin/payouts/generate'));
  expect(post?.[1]).toMatchObject({ method: 'POST', headers: { Authorization: 'Bearer qa-bearer', 'Content-Type': 'application/json' } });
  expect(JSON.parse(post?.[1].body)).toEqual({ stepUpId: 'qa-step-up' });
  return vi.mocked(window.alert).mock.calls[0][0] as string;
}

it('shows partial failure counts and returned attention IDs for HTTP207', async () => {
  m.status = 207; m.result = { created: 1, held: 1, failed: 2, skipped: 3,
    error: 'Payout generation completed with failures', needs_attention: ['payout-review-id'],
    period: { start: '2026-10-01', end: '2026-10-07' } };
  const message = await generate();
  for (const text of ['completed with failures', 'Created: 1', 'Held: 1', 'Failed: 2', 'Skipped: 3', 'Needs review (payout IDs): payout-review-id', '2026-10-01 to 2026-10-07']) expect(message).toContain(text);
  expect(message).not.toContain('business(es)');
});
it('preserves ordinary successful generation feedback', async () => {
  const message = await generate();
  expect(message).toContain('Created: 2');
  expect(message).not.toContain('Failed:');
});
it('shows the server explanation when no payouts are eligible', async () => {
  m.result = { created: 0, held: 0, skipped: 1, failed: 0, message: 'No eligible payouts for this period' };
  const message = await generate();
  expect(message).toContain('No eligible payouts for this period');
  expect(message).toContain('Skipped: 1');
});
it('preserves a fatal server error without a created-payout summary', async () => {
  m.status = 500; m.result = { error: 'Failed to generate payouts' };
  expect(await generate()).toBe('Failed to generate payouts');
});
