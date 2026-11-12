// @vitest-environment jsdom
/**
 * #887 (Owner decision 2026-11-10, option 1B): no account deletion can be
 * scheduled yet, so the dashboard must not read the never-existing
 * profiles.metadata column, and must not show a "scheduled for deletion"
 * banner or a "Cancel Deletion" button.
 *
 * Renders the real app/dashboard/page.tsx against a fake Supabase client that
 * records every table it is asked for. The fake would hand back a scheduled
 * deletion if the page read profiles.metadata, so a page that still read it
 * would both query `profiles` and show the banner.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { cleanup, render, screen } from '@testing-library/react';

vi.setConfig({ testTimeout: 30_000 });

const state = vi.hoisted(() => ({ tables: [] as string[], selects: [] as Array<[string, string]> }));

vi.mock('next/link', () => ({ default: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock('qrcode.react', () => ({ QRCodeCanvas: () => null }));
vi.mock('@/components/dashboard/PayoutBanner', () => ({ PayoutBanner: () => null }));
vi.mock('@/components/dashboard/UpgradeBanner', () => ({ UpgradeBanner: () => null }));
vi.mock('@/components/dashboard/OnboardingChecklist', () => ({ OnboardingChecklist: () => null }));
vi.mock('@/components/dashboard/AISetupCard', () => ({ AISetupCard: () => null }));
vi.mock('@/components/dashboard/DirectWhatsAppLink', () => ({ DirectWhatsAppLink: () => null }));
vi.mock('@/components/dashboard/ResponsiveTable', () => ({ ResponsiveTable: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/dashboard/DashboardProvider', () => ({
  useBusiness: () => ({
    id: 'biz-887', name: 'TestBiz', category: 'salon', country_code: 'NG', timezone: 'Africa/Lagos',
    subscription_tier: 'growth', bot_code: 'TESTBIZ', status: 'active', capabilities: ['appointment'],
  }),
  useCapabilities: () => ({ hasCapability: () => false }),
}));
vi.mock('@/hooks/useCategoryConfig', async () => {
  const { CATEGORY_LABELS: labels } = await vi.importActual<typeof import('@/lib/constants')>('@/lib/constants');
  return { useCategoryConfig: () => ({ labels: labels.other }) };
});
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    auth: { getUser: async () => ({ data: { user: { id: 'owner-887' } } }) },
    rpc: async () => ({ data: 0, error: null }),
    from(table: string) {
      state.tables.push(table);
      const builder: Record<string, unknown> = {};
      builder.select = (columns: string) => { state.selects.push([table, columns]); return builder; };
      for (const op of ['order', 'limit', 'eq', 'is', 'in', 'gte']) builder[op] = () => builder;
      builder.maybeSingle = async () => (table === 'profiles'
        ? { data: { metadata: { deletion_scheduled: true, deletion_date: '2026-12-11T00:00:00.000Z' } }, error: null }
        : { data: null, error: null });
      builder.then = (resolve: (r: unknown) => unknown, reject?: (e: unknown) => unknown) =>
        Promise.resolve({ data: [], count: 0, error: null }).then(resolve, reject);
      return builder;
    },
  }),
}));

import DashboardOverview from '@/app/dashboard/page';

beforeEach(() => {
  state.tables = [];
  state.selects = [];
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ recommendations: [] })));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('#887 dashboard overview: no scheduled-deletion banner', () => {
  it('never reads profiles.metadata and shows no deletion banner or Cancel Deletion button', async () => {
    render(<DashboardOverview />);
    await screen.findAllByText(/^Total /);
    // Let any remaining mount effects settle.
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(state.selects.filter(([, columns]) => /\bmetadata\b/.test(columns))).toEqual([]);
    expect(state.tables).not.toContain('profiles');
    expect(screen.queryByText(/scheduled for deletion/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /Cancel Deletion/i })).toBeNull();
    expect(fetch).not.toHaveBeenCalledWith('/api/account', expect.anything());
  });
});
