import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';

const mocks = vi.hoisted(() => ({ response: null as null | { status: number; body: unknown }, paths: [] as string[] }));
// The page no longer reads tables from the browser; any adminDb use would throw here.
vi.mock('@/lib/supabase', () => ({ supabase: {}, adminDb: {} }));
vi.mock('@/lib/adminApi', async () => {
  const actual = await vi.importActual<typeof import('@/lib/adminApi')>('@/lib/adminApi');
  return {
    ...actual,
    adminApiGet: async (path: string) => {
      mocks.paths.push(path);
      return new Response(JSON.stringify(mocks.response!.body), { status: mocks.response!.status });
    },
  };
});
import Giving from '../pages/Giving';

const base = {
  business_category: 'shop', country_code: 'NG', giver_id: null, giver_email: null, notes: null,
  payment_method: null, gateway: null, gateway_ref: null, reference_code: null,
};
// Shaped like staging TestBiz (category 'shop'), which the old page filtered out.
const RECORDS = [
  { ...base, id: 'g1', source: 'giving', business_id: 'shop', business_name: 'TestBiz', currency: 'NGN', giver_name: 'Ada', giver_phone: '1', purpose: 'Tithe', amount: 5000, status: 'success', created_at: '2026-11-04T00:00:00Z' },
  { ...base, id: 'g2', source: 'giving', business_id: 'shop', business_name: 'TestBiz', currency: 'NGN', giver_name: 'Guest', giver_phone: '2', purpose: 'Tithe', amount: 9000, status: 'pending', created_at: '2026-11-03T00:00:00Z' },
  { ...base, id: 'd1', source: 'crowdfunding', business_id: 'shop', business_name: 'TestBiz', currency: 'NGN', giver_name: 'Bola', giver_phone: '3', purpose: 'Roof Fund', amount: 1444, status: 'success', created_at: '2026-11-02T00:00:00Z' },
  { ...base, id: 'u1', source: 'giving', business_id: 'gb', business_name: 'Grace UK', business_category: 'church', country_code: 'GB', currency: 'GBP', giver_name: 'Sam', giver_phone: '4', purpose: 'Offering', amount: 30, status: 'success', created_at: '2026-11-01T00:00:00Z' },
  { ...base, id: 'u2', source: 'giving', business_id: 'gb', business_name: 'Grace UK', business_category: 'church', country_code: 'GB', currency: 'GBP', giver_name: 'Pat', giver_phone: '5', purpose: 'Offering', amount: 20, status: 'refunded', created_at: '2026-10-31T00:00:00Z' },
];

function card(label: string) {
  return screen.getByText(label).parentElement as HTMLElement;
}

beforeEach(() => { mocks.response = { status: 200, body: { records: RECORDS } }; mocks.paths = []; });
afterEach(cleanup);

it('shows giving at a non-faith business and counts only successful money, per currency', async () => {
  render(<Giving />);
  expect(await screen.findByText('Ada')).toBeInTheDocument();
  expect(mocks.paths).toEqual(['/api/admin/giving']);
  expect(screen.queryByText('No giving records found')).not.toBeInTheDocument();

  // 5,000 + 1,444 NGN succeeded (the pending 9,000 is excluded); 30 GBP (the refunded 20 is excluded).
  const total = within(card('Total Given (successful)')).getByText(/₦/);
  expect(total.textContent).toMatch(/₦6,444/);
  expect(total.textContent).toMatch(/£30/);
  expect(total.textContent).not.toMatch(/15,444|£50/);
  expect(within(card('Givers')).getByText('3')).toBeInTheDocument();
  expect(within(card('Organizations')).getByText('2')).toBeInTheDocument();
  expect(within(card('Contributions')).getByText('5')).toBeInTheDocument();

  // Each row in its own currency; donations labelled as crowdfunding with the campaign title.
  const row = screen.getByText('Sam').closest('tr') as HTMLElement;
  expect(within(row).getByText('£30')).toBeInTheDocument();
  const donation = screen.getByText('Bola').closest('tr') as HTMLElement;
  expect(within(donation).getByText('Crowdfunding')).toBeInTheDocument();
  expect(within(donation).getByText('Roof Fund')).toBeInTheDocument();
});

it('filters by type and status', async () => {
  render(<Giving />);
  await screen.findByText('Ada');
  fireEvent.change(screen.getByDisplayValue('All Types'), { target: { value: 'crowdfunding' } });
  expect(screen.getByText('Bola')).toBeInTheDocument();
  expect(screen.queryByText('Ada')).not.toBeInTheDocument();
  fireEvent.change(screen.getByDisplayValue('Crowdfunding'), { target: { value: 'all' } });
  fireEvent.change(screen.getByDisplayValue('All Statuses'), { target: { value: 'pending' } });
  expect(screen.getByText('Guest')).toBeInTheDocument();
  expect(screen.queryByText('Ada')).not.toBeInTheDocument();
});

it('a genuine empty result is an empty list, not an error', async () => {
  mocks.response = { status: 200, body: { records: [] } };
  render(<Giving />);
  expect(await screen.findByText('No giving records found')).toBeInTheDocument();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

it('a failed read shows the error instead of an empty page with zero totals', async () => {
  mocks.response = { status: 500, body: { error: 'Could not load giving records' } };
  render(<Giving />);
  expect(await screen.findByRole('alert')).toHaveTextContent('Unable to load giving records: Could not load giving records');
  expect(screen.queryByText('No giving records found')).not.toBeInTheDocument();
  expect(screen.queryByText('Total Given (successful)')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Export CSV' })).toBeDisabled();
});
