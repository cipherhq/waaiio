// @vitest-environment jsdom
/**
 * Tables & Sections — rendered UI (Owner decisions 2026-11-04).
 *   3. Signup: "Reserve tables & sections" is selectable for every business type (free tier).
 *   4. Dashboard checklist: "Add your tables & sections" shows while table_reservation is on
 *      and the business has no active seating resource; it disappears once one exists.
 */
import React, { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

type Row = Record<string, unknown>;
const state = vi.hoisted(() => ({
  business: { id: 'own', bot_code: '' },
  capabilities: [] as string[],
  rows: {} as Record<string, Row[]>,
  errors: new Set<string>(),
  queries: [] as Array<{ table: string; filters: Array<[string, unknown]> }>,
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
      const filters: Array<[string, unknown]> = [];
      const query = {
        select: () => query,
        eq: (column: string, value: unknown) => { filters.push([column, value]); return query; },
        gt: (column: string, value: unknown) => { filters.push([column, value]); return query; },
        then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
          state.queries.push({ table, filters: [...filters] });
          if (state.errors.has(table)) return Promise.resolve({ count: 5, error: { message: 'fixture' } }).then(resolve, reject);
          const rows = (state.rows[table] || []).filter(row => filters.every(([c, v]) => typeof v === 'number' ? Number(row[c]) > v : row[c] === v));
          return Promise.resolve({ count: rows.length, error: null }).then(resolve, reject);
        },
      };
      return query;
    },
  }),
}));

import { OnboardingChecklist } from '@/components/dashboard/OnboardingChecklist';
import { StepFeatures } from '@/app/get-started/steps/StepFeatures';
import { getPricingTiers, BUSINESS_CATEGORIES, type SubscriptionTier } from '@/lib/constants';
import type { CapabilityId } from '@/lib/capabilities/types';

const NUDGE = 'Add your tables & sections';
function add(table: string, row: Row = {}) {
  (state.rows[table] ||= []).push({ id: table + '-row', business_id: 'own', ...row });
}
async function settled() {
  await screen.findByRole('heading', { name: 'Getting started with Waaiio' });
}

beforeEach(() => {
  state.business = { id: 'own', bot_code: '', category: 'lounge' };
  state.capabilities = [];
  state.rows = {};
  state.errors.clear();
  state.queries = [];
  localStorage.clear();
  // The claim-credit step (Owner decision 2026-11-07) is covered in
  // claim-credit-ui.test.tsx; here it is already done.
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ phone_verified: true, credited: false }), { status: 200 })));
});
afterEach(cleanup);

describe('Checklist nudge: Add your tables & sections', () => {
  it('shows with a link to /dashboard/seating when table_reservation is on and no table exists', async () => {
    state.capabilities = ['table_reservation', 'ordering'];
    render(<OnboardingChecklist />);
    await settled();
    const link = screen.getByText(NUDGE).closest('a')!;
    expect(link.getAttribute('href')).toBe('/dashboard/seating');
    expect(screen.getByText('1 of 6 steps completed')).toBeTruthy();
    // Owner's own business, active resources only
    const q = state.queries.find(x => x.table === 'seating_resources')!;
    expect(q.filters).toContainEqual(['business_id', 'own']);
    expect(q.filters).toContainEqual(['is_active', true]);
  });

  it('disappears once an active table exists', async () => {
    state.capabilities = ['table_reservation'];
    add('seating_resources', { is_active: true });
    render(<OnboardingChecklist />);
    await settled();
    expect(screen.queryByText(NUDGE)).toBeNull();
    expect(screen.getByText('1 of 5 steps completed')).toBeTruthy();
  });

  it('still shows when the only table is archived or belongs to another business', async () => {
    state.capabilities = ['table_reservation'];
    add('seating_resources', { is_active: false });
    add('seating_resources', { business_id: 'other', is_active: true });
    render(<OnboardingChecklist />);
    await settled();
    expect(screen.getByText(NUDGE)).toBeTruthy();
  });

  it('does not show for a non-food business that has table_reservation on (and does not query seating)', async () => {
    state.business = { id: 'own', bot_code: '', category: 'church' };
    state.capabilities = ['table_reservation'];
    render(<OnboardingChecklist />);
    await settled();
    expect(screen.queryByText(NUDGE)).toBeNull();
    expect(state.queries.some(q => q.table === 'seating_resources')).toBe(false);
    expect(screen.getByText('1 of 5 steps completed')).toBeTruthy();
  });

  it.each([['food_delivery'], [null], [undefined]])('does not show for category %s, even with table_reservation on', async (category) => {
    state.business = { id: 'own', bot_code: '', category };
    state.capabilities = ['table_reservation'];
    render(<OnboardingChecklist />);
    await settled();
    expect(screen.queryByText(NUDGE)).toBeNull();
    expect(state.queries.some(q => q.table === 'seating_resources')).toBe(false);
  });

  it.each(['restaurant', 'cafe', 'bar', 'lounge', 'bakery', 'catering', 'food_truck'])('shows for food & drink category %s', async (category) => {
    state.business = { id: 'own', bot_code: '', category };
    state.capabilities = ['table_reservation'];
    render(<OnboardingChecklist />);
    await settled();
    expect(screen.getByText(NUDGE)).toBeTruthy();
  });

  it('does not show without table_reservation (and does not query seating)', async () => {
    state.capabilities = ['ordering'];
    render(<OnboardingChecklist />);
    await settled();
    expect(screen.queryByText(NUDGE)).toBeNull();
    expect(state.queries.some(q => q.table === 'seating_resources')).toBe(false);
    expect(screen.getByText('1 of 5 steps completed')).toBeTruthy();
  });

  it('does not trust a count returned with a query error', async () => {
    state.capabilities = ['table_reservation'];
    state.errors.add('seating_resources');
    render(<OnboardingChecklist />);
    await settled();
    expect(screen.getByText(NUDGE)).toBeTruthy();
  });

  it('a hidden nudge does not block auto-dismissal when everything else is done', async () => {
    state.capabilities = ['table_reservation'];
    state.business.bot_code = 'OWN';
    add('services');
    add('seating_resources', { is_active: true });
    add('payout_accounts', { is_active: true });
    add('conversation_usage', { inbound_count: 1 });
    render(<OnboardingChecklist />);
    await vi.waitFor(() => expect(localStorage.getItem('waaiio-checklist-dismissed-own')).toBe('true'));
  });
});

describe('Signup: Reserve tables & sections', () => {
  const pricing = getPricingTiers('NG');
  function Features({ category }: { category: string }) {
    const [selectedCapabilities, setSelectedCapabilities] = useState<CapabilityId[]>(['chat']);
    return (
      <>
        <StepFeatures
          selectedCapabilities={selectedCapabilities}
          setSelectedCapabilities={setSelectedCapabilities}
          selectedPlan={'free' as SubscriptionTier}
          setSelectedPlan={() => {}}
          selectedCountry="NG"
          category={category as never}
          requiredPlan="free"
          localTiers={pricing}
          setStep={() => {}}
        />
        <output data-testid="caps">{selectedCapabilities.join(',')}</output>
      </>
    );
  }

  it('is offered and selectable for every business type, with no paid-plan badge', { timeout: 60_000 }, () => {
    expect(BUSINESS_CATEGORIES.length).toBeGreaterThan(50);
    for (const { key } of BUSINESS_CATEGORIES) {
      render(<Features category={key} />);
      const option = screen.getByText('Reserve tables & sections').closest('button')!;
      expect(option.textContent).not.toMatch(/Pro|Premium/);
      fireEvent.click(option);
      expect(screen.getByTestId('caps').textContent).toBe('chat,table_reservation');
      fireEvent.click(option);
      expect(screen.getByTestId('caps').textContent).toBe('chat');
      cleanup();
    }
  });
});
