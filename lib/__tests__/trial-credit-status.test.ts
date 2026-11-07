/** GET /api/trial-credit/status — read-only state for the claim-credit step (Owner decision 2026-11-07). */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const BIZ = '22222222-2222-4222-8222-222222222222';
const m = vi.hoisted(() => ({
  auth: vi.fn(),
  confirmedAt: null as string | null,
  grant: null as Record<string, unknown> | null,
  otherBusinesses: [] as Array<{ id: string }>,
  otherGrant: null as Record<string, unknown> | null,
  country: 'NG' as string | null,
  queries: [] as Array<{ table: string; filters: Array<[string, unknown]> }>,
}));
vi.mock('@/lib/api-auth', () => ({ authenticateRequest: m.auth }));

function service() {
  return {
    auth: { admin: { getUserById: async () => ({ data: { user: { phone_confirmed_at: m.confirmedAt } }, error: null }) } },
    from: (table: string) => {
      const filters: Array<[string, unknown]> = [];
      const q = {
        select: () => q,
        eq: (col: string, val: unknown) => { filters.push([col, val]); return q; },
        neq: (col: string, val: unknown) => { filters.push(['not ' + col, val]); return q; },
        in: (col: string, val: unknown) => { filters.push(['in ' + col, val]); return q; },
        limit: () => q,
        // The owner's other businesses (a list, awaited directly).
        then: (resolve: (v: unknown) => unknown) => {
          m.queries.push({ table, filters });
          return resolve({ data: m.otherBusinesses, error: null });
        },
        maybeSingle: async () => {
          m.queries.push({ table, filters });
          if (table === 'businesses') return { data: { country_code: m.country }, error: null };
          if (table === 'countries') return { data: { currency_code: 'NGN' }, error: null };
          if (table === 'messaging_allowances') return { data: filters.some(([c]) => c === 'in business_id') ? m.otherGrant : m.grant, error: null };
          if (table === 'platform_settings') return { data: { value: { NGN: 500000, USD: 500 } }, error: null };
          throw new Error('unexpected table ' + table);
        },
      };
      return q;
    },
  };
}

import { GET } from '@/app/api/trial-credit/status/route';
const get = () => GET(new NextRequest(`http://localhost/api/trial-credit/status?business_id=${BIZ}`));

beforeEach(() => {
  m.confirmedAt = null; m.grant = null; m.country = 'NG'; m.queries = [];
  m.otherBusinesses = []; m.otherGrant = null;
  m.auth.mockImplementation(async () => ({ user: { id: 'owner' }, businessId: BIZ, service: service() }));
});

describe('GET /api/trial-credit/status', () => {
  it('refuses a business the caller does not own', async () => {
    m.auth.mockResolvedValueOnce(NextResponse.json({ error: 'Forbidden' }, { status: 403 }));
    expect((await get()).status).toBe(403);
    expect(m.auth).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ requireBusinessOwnership: true }));
  });

  it('new owner: not verified, not credited, with the amount for their currency', async () => {
    expect(await (await get()).json()).toEqual({ phone_verified: false, credited: false, owner_already_has_trial: false, amount_minor: 500000, currency: 'NGN' });
  });

  it('verified and credited are read from the login and this business\'s trial grant', async () => {
    m.confirmedAt = '2026-11-07T10:00:00Z';
    m.grant = { id: 'g1' };
    expect(await (await get()).json()).toMatchObject({ phone_verified: true, credited: true });
    const grantQuery = m.queries.find(q => q.table === 'messaging_allowances')!;
    expect(grantQuery.filters).toEqual([['business_id', BIZ], ['type', 'trial_grant'], ['source_ref', 'trial_v2']]);
  });

  it('no country means no amount (the page then shows no figure)', async () => {
    m.country = null;
    expect(await (await get()).json()).toMatchObject({ amount_minor: null, currency: null });
  });

  it('flags a free credit already used on another business of the same owner', async () => {
    m.confirmedAt = '2026-11-07T10:00:00Z';
    m.otherBusinesses = [{ id: 'biz-other' }];
    m.otherGrant = { id: 'g-other' };
    expect(await (await get()).json()).toMatchObject({ phone_verified: true, credited: false, owner_already_has_trial: true });
    const owned = m.queries.find(q => q.table === 'businesses' && q.filters.some(([c]) => c === 'owner_id'))!;
    expect(owned.filters).toEqual([['owner_id', 'owner'], ['not id', BIZ]]);
    const other = m.queries.find(q => q.table === 'messaging_allowances' && q.filters.some(([c]) => c === 'in business_id'))!;
    expect(other.filters).toContainEqual(['in business_id', ['biz-other']]);
  });

  it('other businesses without the credit do not set the flag', async () => {
    m.otherBusinesses = [{ id: 'biz-other' }];
    expect(await (await get()).json()).toMatchObject({ owner_already_has_trial: false });
  });
});
