/**
 * Bank account API route handler tests
 *
 * Verifies:
 *  - Non-owner gets 403 on POST, PUT, and DELETE
 *  - Owner write goes through the service client
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ── Mocks ──

const OWNER_ID = 'owner-user-id-001';
const BIZ_ID = 'biz-id-001';

const mockGetUser = vi.fn();
const mockSelect = vi.fn();
const mockEq = vi.fn();
const mockMaybeSingle = vi.fn();

// Browser-side supabase mock (for auth + ownership check)
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn().mockResolvedValue({
    auth: { getUser: () => mockGetUser() },
    from: () => ({
      select: (...args: any[]) => {
        mockSelect(...args);
        return {
          eq: (...eqArgs: any[]) => {
            mockEq(...eqArgs);
            return {
              eq: (...eqArgs2: any[]) => {
                mockEq(...eqArgs2);
                return { maybeSingle: () => mockMaybeSingle() };
              },
              maybeSingle: () => mockMaybeSingle(),
            };
          },
        };
      },
    }),
  }),
}));

const mockServiceInsert = vi.fn();
const mockServiceSelect = vi.fn();
const mockServiceUpdate = vi.fn();
const mockServiceFrom = vi.fn();
const mockServiceMaybeSingle = vi.fn();

vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: vi.fn(() => ({
    from: (table: string) => {
      mockServiceFrom(table);
      return {
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              order: vi.fn().mockResolvedValue({ data: [], error: null }),
              maybeSingle: () => mockServiceMaybeSingle(),
            }),
          }),
          count: 'exact',
          head: true,
        }),
        insert: (data: any) => {
          mockServiceInsert(data);
          return {
            select: vi.fn().mockReturnValue({
              single: vi.fn().mockResolvedValue({
                data: { id: 'new-acct-id', ...data },
                error: null,
              }),
            }),
          };
        },
        update: (data: any) => {
          mockServiceUpdate(data);
          return {
            eq: vi.fn().mockReturnValue({
              select: vi.fn().mockReturnValue({
                single: vi.fn().mockResolvedValue({ data: { id: 'acct-id', ...data }, error: null }),
              }),
              eq: vi.fn().mockReturnValue({
                order: vi.fn().mockResolvedValue({ data: [], error: null }),
              }),
              neq: vi.fn().mockResolvedValue({ data: null, error: null }),
            }),
          };
        },
      };
    },
  })),
}));

vi.mock('@/lib/logger', () => ({
  logger: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  // Default: service client select chain returns no row
  mockServiceMaybeSingle.mockResolvedValue({ data: null, error: null });
});

// Dynamically import the route handler after mocks are set
async function importRoute() {
  return await import('@/app/api/dashboard/bank-account/route');
}

describe('Bank account route: ownership verification', () => {
  it('non-owner gets 403 on POST', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'other-user-id' } } });
    // Ownership check returns null (not owner)
    mockMaybeSingle.mockResolvedValue({ data: null });

    const { POST } = await importRoute();
    const req = new NextRequest('http://localhost/api/dashboard/bank-account', {
      method: 'POST',
      body: JSON.stringify({
        business_id: BIZ_ID,
        bank_name: 'Test Bank',
        account_number: '1234567890',
        account_name: 'Test Account',
      }),
      headers: { 'Content-Type': 'application/json' },
    });

    const res = await POST(req);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/not found|access denied/i);

    // Service client should NOT have been called for insert
    expect(mockServiceInsert).not.toHaveBeenCalled();
  });

  it('owner POST goes through service client', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: OWNER_ID } } });
    // Ownership check returns the business
    mockMaybeSingle.mockResolvedValue({
      data: { id: BIZ_ID, subscription_tier: 'growth', country_code: 'NG' },
    });

    const { POST } = await importRoute();
    const req = new NextRequest('http://localhost/api/dashboard/bank-account', {
      method: 'POST',
      body: JSON.stringify({
        business_id: BIZ_ID,
        bank_name: 'Owner Bank',
        account_number: '1234567890',
        account_name: 'Owner Account',
      }),
      headers: { 'Content-Type': 'application/json' },
    });

    const res = await POST(req);
    expect(res.status).toBe(201);

    // Service client was called for the write
    expect(mockServiceFrom).toHaveBeenCalledWith('business_bank_accounts');
    expect(mockServiceInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        business_id: BIZ_ID,
        bank_name: 'Owner Bank',
        account_number: '1234567890',
        account_name: 'Owner Account',
      }),
    );
  });

  it('non-owner gets 403 on PUT', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'other-user-id' } } });
    // Service client finds the account (it exists)
    mockServiceMaybeSingle.mockResolvedValue({
      data: { id: 'acct-id', business_id: BIZ_ID },
    });
    // Session client ownership check returns null (not owner)
    mockMaybeSingle.mockResolvedValue({ data: null });

    const { PUT } = await importRoute();
    const req = new NextRequest('http://localhost/api/dashboard/bank-account', {
      method: 'PUT',
      body: JSON.stringify({
        id: 'acct-id',
        bank_name: 'Hacked Bank',
      }),
      headers: { 'Content-Type': 'application/json' },
    });

    const res = await PUT(req);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/access denied/i);

    // Service client should NOT have been called for update
    expect(mockServiceUpdate).not.toHaveBeenCalled();
  });

  it('non-owner gets 403 on DELETE', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'other-user-id' } } });
    // Session client ownership check returns null (not owner)
    mockMaybeSingle.mockResolvedValue({ data: null });

    const { DELETE: deleteFn } = await importRoute();
    const req = new NextRequest(
      `http://localhost/api/dashboard/bank-account?id=acct-id&business_id=${BIZ_ID}`,
      { method: 'DELETE' },
    );

    const res = await deleteFn(req);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/not found|access denied/i);

    // Service client should NOT have been called for update (soft-delete)
    expect(mockServiceUpdate).not.toHaveBeenCalled();
  });
});
