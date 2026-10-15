/**
 * Issue #496 — Poll / Promo immediate refresh regression coverage
 *
 * Both dashboard create flows immediately refetch their authenticated list.
 * A positive max-age on those GET responses can return the pre-create list,
 * making a successful create appear missing until a manual browser refresh.
 *
 * These tests execute the real GET route handlers with mocked data clients and
 * prove successful mutable-list responses are explicitly non-cacheable.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  createServiceClient: vi.fn(),
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: mocks.createClient,
}));

vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: mocks.createServiceClient,
}));

vi.mock('@/lib/capabilities/api-guard', () => ({
  requireCapability: vi.fn(),
}));

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn() },
}));

import { GET as getPolls } from '../../app/api/polls/route';
import { GET as getPromoCodes } from '../../app/api/promo-codes/route';

function makePollClient() {
  return {
    auth: {
      getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'user-1' } } }),
    },
    from: vi.fn((table: string): any => {
      if (table === 'businesses') {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              eq: vi.fn(() => ({
                single: vi.fn().mockResolvedValue({ data: { id: 'biz-1' } }),
              })),
            })),
          })),
        };
      }

      if (table === 'polls') {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              order: vi.fn().mockResolvedValue({
                data: [{ id: 'poll-1', question: 'Fresh poll' }],
                error: null,
              }),
            })),
          })),
        };
      }

      throw new Error(`Unexpected table: ${table}`);
    }),
  };
}

function makePromoAuthClient() {
  return {
    auth: {
      getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'user-1' } } }),
    },
    from: vi.fn((table: string): any => {
      if (table !== 'businesses') throw new Error(`Unexpected table: ${table}`);
      return {
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            eq: vi.fn(() => ({
              maybeSingle: vi.fn().mockResolvedValue({ data: { id: 'biz-1' } }),
            })),
          })),
        })),
      };
    }),
  };
}

function makePromoServiceClient() {
  return {
    from: vi.fn((table: string): any => {
      if (table !== 'promo_codes') throw new Error(`Unexpected table: ${table}`);
      return {
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            order: vi.fn().mockResolvedValue({
              data: [{ id: 'promo-1', code: 'FRESH10' }],
              error: null,
            }),
          })),
        })),
      };
    }),
  };
}

function expectNoStore(response: Response) {
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('private, no-store, max-age=0');
}

describe('Issue #496: mutable dashboard list cache policy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('poll GET returns the current list with no-store semantics', async () => {
    mocks.createClient.mockResolvedValue(makePollClient());
    mocks.createServiceClient.mockReturnValue({});

    const response = await getPolls(
      new NextRequest('http://localhost/api/polls?business_id=biz-1'),
    );

    expectNoStore(response);
    await expect(response.json()).resolves.toEqual({
      polls: [{ id: 'poll-1', question: 'Fresh poll' }],
    });
  });

  it('promo-code GET returns the current list with no-store semantics', async () => {
    mocks.createClient.mockResolvedValue(makePromoAuthClient());
    mocks.createServiceClient.mockReturnValue(makePromoServiceClient());

    const response = await getPromoCodes(
      new NextRequest('http://localhost/api/promo-codes?businessId=biz-1'),
    );

    expectNoStore(response);
    await expect(response.json()).resolves.toEqual({
      codes: [{ id: 'promo-1', code: 'FRESH10' }],
    });
  });
});
