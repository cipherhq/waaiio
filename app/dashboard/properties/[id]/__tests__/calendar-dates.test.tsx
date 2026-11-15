// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ stays: [] as Record<string, unknown>[], blocks: [] as Record<string, unknown>[], mutation: vi.fn() }));
vi.mock('next/navigation', () => ({ useParams: () => ({ id: 'property-a' }), useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/components/dashboard/DashboardProvider', () => ({ useBusiness: () => ({ id: 'business-a', country_code: 'NG', category: 'hotel' }) }));
vi.mock('@/components/dashboard/PageHelp', () => ({ PageHelp: () => null }));
vi.mock('@/lib/supabase/client', () => ({ createClient: () => ({ from: (table: string) => {
  const result = { data: table === 'properties' ? { id: 'property-a', name: 'Demo', property_type: 'apartment', price: 100, max_guests: 2, photos: [], is_active: true } : table === 'reservations' ? m.stays : m.blocks };
  const q: Record<string, unknown> = { single: async () => result, then: (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve), insert: m.mutation, update: m.mutation, delete: m.mutation };
  for (const method of ['select', 'eq', 'order']) q[method] = () => q;
  return q;
} }) }));
import PropertyDetailPage from '../page';
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); m.stays = []; m.blocks = []; m.mutation.mockReset(); });
afterEach(() => { cleanup(); vi.useRealTimers(); });
async function calendar(month: string) {
  vi.setSystemTime(new Date(`${month}-15T12:00:00Z`));
  render(<PropertyDetailPage />);
  fireEvent.click(await screen.findByRole('button', { name: 'Calendar' }));
}
function day(n: number) {
  const span = screen.getAllByText(String(n), { selector: 'span' }).find(el => el.className.includes('inline-flex h-6'));
  expect(span).toBeTruthy(); return within(span!.parentElement!);
}
it('keeps November reservation nights and inclusive single/range blocks on their literal dates across DST', async () => {
  m.stays = [{ id: 'stay', check_in: '2026-10-31', check_out: '2026-11-03', guest_name: 'Guest A', status: 'confirmed', total_amount: 100 }];
  m.blocks = [{ id: 'block', date_from: '2026-11-02', date_to: '2026-11-04', reason: 'Maintenance' }, { id: 'single', date_from: '2026-11-15', date_to: '2026-11-15', reason: 'Single day' }];
  await calendar('2026-11');
  expect(day(1).getByText('Guest A')).toBeTruthy();
  expect(day(2).getByText('Guest A')).toBeTruthy(); // booking retains precedence
  expect(day(3).getByText('Maintenance')).toBeTruthy(); // checkout excluded
  expect(day(4).getByText('Maintenance')).toBeTruthy(); // block end included
  expect(day(5).queryByText('Maintenance')).toBeNull();
  expect(day(15).getByText('Single day')).toBeTruthy();
  expect(day(14).queryByText('Single day')).toBeNull();
  expect(m.mutation).not.toHaveBeenCalled();
});
it.each([
  ['2027-01', '2026-12-31', '2027-01-02', 1, 2],
  ['2028-02', '2028-02-28', '2028-03-01', 28, 29],
  ['2026-03', '2026-03-07', '2026-03-09', 7, 8],
])('preserves year/leap/spring-DST boundaries in %s', async (month, start, end, first, last) => {
  m.stays = [{ id: 'stay', check_in: start, check_out: end, guest_name: 'Boundary guest', status: 'confirmed', total_amount: 100 }];
  await calendar(month);
  expect(day(first).getByText('Boundary guest')).toBeTruthy();
  if (month === '2027-01') expect(day(last).queryByText('Boundary guest')).toBeNull();
  else expect(day(last).getByText('Boundary guest')).toBeTruthy();
  expect(m.mutation).not.toHaveBeenCalled();
});
