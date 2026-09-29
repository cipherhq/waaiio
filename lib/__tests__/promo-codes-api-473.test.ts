/**
 * #473 — Promo codes GRANT migration + API correctness tests
 *
 * Tests:
 * - Migration 413 grants exactly service_role CRUD, nothing more
 * - API route: create, edit, delete, list with mocked Supabase
 * - Auth/ownership gates
 * - Error surfacing (not silent empty)
 * - isActive / is_active PUT mismatch fix
 * - DELETE error handling
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { NextRequest } from 'next/server';

// ══════════════════════════════════════════════════════════════
// 1. Migration 413 assertions
// ══════════════════════════════════════════════════════════════

describe('Migration 413: promo_codes service_role grants', () => {
  const sql = readFileSync(join(process.cwd(), 'supabase/migrations/413_promo_codes_service_role_grants.sql'), 'utf-8');
  const statementsText = sql.split('\n').filter(line => !line.trimStart().startsWith('--')).join('\n');

  it('grants SELECT, INSERT, UPDATE, DELETE on promo_codes to service_role', () => {
    expect(sql).toMatch(/GRANT\s+SELECT,\s*INSERT,\s*UPDATE,\s*DELETE\s+ON\s+TABLE\s+public\.promo_codes\s+TO\s+service_role/i);
  });

  it('does not grant to anon', () => {
    expect(statementsText).not.toMatch(/TO\s+anon/i);
  });

  it('does not grant to authenticated', () => {
    expect(statementsText).not.toMatch(/TO\s+authenticated/i);
  });

  it('does not grant to PUBLIC', () => {
    expect(statementsText).not.toMatch(/TO\s+PUBLIC/i);
  });

  it('does not grant TRUNCATE', () => {
    expect(statementsText).not.toMatch(/\bTRUNCATE\b/i);
  });

  it('does not grant TRIGGER', () => {
    expect(statementsText).not.toMatch(/\bTRIGGER\b/i);
  });

  it('does not grant REFERENCES', () => {
    expect(statementsText).not.toMatch(/\bREFERENCES\b/i);
  });

  it('does not alter RLS policies', () => {
    expect(statementsText).not.toMatch(/\bPOLICY\b/i);
    expect(statementsText).not.toMatch(/\bROW LEVEL SECURITY\b/i);
  });
});

// ══════════════════════════════════════════════════════════════
// 2. API route tests (mocked Supabase)
// ══════════════════════════════════════════════════════════════

const mockGetUser = vi.fn();
const mockFrom = vi.fn();
const mockServiceFrom = vi.fn();

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve({
    auth: { getUser: mockGetUser },
    from: mockFrom,
  }),
}));

vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => ({
    from: mockServiceFrom,
  }),
}));

const USER_ID = 'user-aaa-bbb';
const BIZ_ID = 'biz-111-222';
const PROMO_ID = 'promo-333-444';
const PRODUCT_ID_1 = 'prod-aaa-111';
const PRODUCT_ID_2 = 'prod-bbb-222';

function makeGetRequest(businessId: string) {
  return new NextRequest(new URL(`http://localhost:3000/api/promo-codes?businessId=${businessId}`), {
    method: 'GET',
  });
}

function makePostRequest(body: Record<string, unknown>) {
  return new NextRequest(new URL('http://localhost:3000/api/promo-codes'), {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

function makePutRequest(body: Record<string, unknown>) {
  return new NextRequest(new URL('http://localhost:3000/api/promo-codes'), {
    method: 'PUT',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

function makeDeleteRequest(body: Record<string, unknown>) {
  return new NextRequest(new URL('http://localhost:3000/api/promo-codes'), {
    method: 'DELETE',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

function setupAuthenticatedOwner() {
  mockGetUser.mockResolvedValue({ data: { user: { id: USER_ID } } });
  mockFrom.mockImplementation((table: string) => {
    if (table === 'businesses') {
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: () => Promise.resolve({ data: { id: BIZ_ID }, error: null }),
            }),
          }),
        }),
      };
    }
    return {};
  });
}

function setupUnauthenticated() {
  mockGetUser.mockResolvedValue({ data: { user: null } });
}

function setupWrongOwner() {
  mockGetUser.mockResolvedValue({ data: { user: { id: 'other-user' } } });
  mockFrom.mockImplementation((table: string) => {
    if (table === 'businesses') {
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: () => Promise.resolve({ data: null, error: null }),
            }),
          }),
        }),
      };
    }
    return {};
  });
}

const VALID_POST_PAYLOAD = {
  businessId: BIZ_ID,
  code: 'SUMMER20',
  discountType: 'percentage',
  discountValue: 20,
};

describe('POST /api/promo-codes', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    setupAuthenticatedOwner();
  });

  async function postPromo(body: Record<string, unknown>) {
    const { POST } = await import('@/app/api/promo-codes/route');
    return POST(makePostRequest(body));
  }

  it('creates percentage discount', async () => {
    const insertedData = { id: PROMO_ID, ...VALID_POST_PAYLOAD, discount_type: 'percentage', discount_value: 20 };
    mockServiceFrom.mockReturnValue({
      insert: () => ({ select: () => ({ single: () => Promise.resolve({ data: insertedData, error: null }) }) }),
    });

    const res = await postPromo(VALID_POST_PAYLOAD);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.promoCode).toBeTruthy();
  });

  it('creates fixed discount', async () => {
    const body = { ...VALID_POST_PAYLOAD, code: 'FLAT500', discountType: 'fixed', discountValue: 500 };
    const insertedData = { id: PROMO_ID, ...body };
    mockServiceFrom.mockReturnValue({
      insert: () => ({ select: () => ({ single: () => Promise.resolve({ data: insertedData, error: null }) }) }),
    });

    const res = await postPromo(body);
    expect(res.status).toBe(200);
  });

  it('creates with expiry date', async () => {
    const body = { ...VALID_POST_PAYLOAD, validUntil: '2027-12-31' };
    mockServiceFrom.mockReturnValue({
      insert: () => ({ select: () => ({ single: () => Promise.resolve({ data: { id: PROMO_ID }, error: null }) }) }),
    });

    const res = await postPromo(body);
    expect(res.status).toBe(200);
  });

  it('creates without expiry (null)', async () => {
    const body = { ...VALID_POST_PAYLOAD, validUntil: null };
    mockServiceFrom.mockReturnValue({
      insert: () => ({ select: () => ({ single: () => Promise.resolve({ data: { id: PROMO_ID }, error: null }) }) }),
    });

    const res = await postPromo(body);
    expect(res.status).toBe(200);
  });

  it('creates with max uses', async () => {
    const body = { ...VALID_POST_PAYLOAD, maxUses: 100 };
    mockServiceFrom.mockReturnValue({
      insert: () => ({ select: () => ({ single: () => Promise.resolve({ data: { id: PROMO_ID }, error: null }) }) }),
    });

    const res = await postPromo(body);
    expect(res.status).toBe(200);
  });

  it('creates with unlimited uses (null maxUses)', async () => {
    const body = { ...VALID_POST_PAYLOAD, maxUses: null };
    mockServiceFrom.mockReturnValue({
      insert: () => ({ select: () => ({ single: () => Promise.resolve({ data: { id: PROMO_ID }, error: null }) }) }),
    });

    const res = await postPromo(body);
    expect(res.status).toBe(200);
  });

  it('creates for all products (empty applicable_services)', async () => {
    const body = { ...VALID_POST_PAYLOAD, applicableServices: [] };
    mockServiceFrom.mockReturnValue({
      insert: () => ({ select: () => ({ single: () => Promise.resolve({ data: { id: PROMO_ID }, error: null }) }) }),
    });

    const res = await postPromo(body);
    expect(res.status).toBe(200);
  });

  it('creates for specific products', async () => {
    const body = { ...VALID_POST_PAYLOAD, applicableServices: [PRODUCT_ID_1, PRODUCT_ID_2] };
    mockServiceFrom.mockReturnValue({
      insert: () => ({ select: () => ({ single: () => Promise.resolve({ data: { id: PROMO_ID }, error: null }) }) }),
    });

    const res = await postPromo(body);
    expect(res.status).toBe(200);
  });

  it('returns 409 for duplicate code', async () => {
    mockServiceFrom.mockReturnValue({
      insert: () => ({ select: () => ({ single: () => Promise.resolve({ data: null, error: { code: '23505', message: 'duplicate' } }) }) }),
    });

    const res = await postPromo(VALID_POST_PAYLOAD);
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error).toBe('Code already exists');
  });

  it('returns 400 for percentage > 100', async () => {
    const res = await postPromo({ ...VALID_POST_PAYLOAD, discountValue: 150 });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toMatch(/100/);
  });

  it('returns 400 for non-positive discount value', async () => {
    const res = await postPromo({ ...VALID_POST_PAYLOAD, discountValue: 0 });
    expect(res.status).toBe(400);
  });

  it('returns 400 for negative discount value', async () => {
    const res = await postPromo({ ...VALID_POST_PAYLOAD, discountValue: -5 });
    expect(res.status).toBe(400);
  });

  it('returns 400 for missing required fields', async () => {
    const res = await postPromo({ businessId: BIZ_ID });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toMatch(/required/);
  });

  it('returns 401 for unauthenticated user', async () => {
    setupUnauthenticated();
    const res = await postPromo(VALID_POST_PAYLOAD);
    expect(res.status).toBe(401);
  });

  it('returns 403 for wrong business owner', async () => {
    setupWrongOwner();
    const res = await postPromo(VALID_POST_PAYLOAD);
    expect(res.status).toBe(403);
  });

  it('logs DB error and returns 500 for non-duplicate insert failure', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockServiceFrom.mockReturnValue({
      insert: () => ({ select: () => ({ single: () => Promise.resolve({ data: null, error: { code: '42501', message: 'permission denied' } }) }) }),
    });

    const res = await postPromo(VALID_POST_PAYLOAD);
    expect(res.status).toBe(500);
    expect(consoleSpy).toHaveBeenCalledWith(
      '[promo-codes] POST insert error:',
      expect.objectContaining({ code: '42501' })
    );
    consoleSpy.mockRestore();
  });
});

describe('GET /api/promo-codes', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    setupAuthenticatedOwner();
  });

  async function getCodes(businessId: string) {
    const { GET } = await import('@/app/api/promo-codes/route');
    return GET(makeGetRequest(businessId));
  }

  it('returns promo codes list', async () => {
    const codes = [{ id: PROMO_ID, code: 'TEST', discount_type: 'percentage', discount_value: 10 }];
    mockServiceFrom.mockReturnValue({
      select: () => ({
        eq: () => ({
          order: () => Promise.resolve({ data: codes, error: null }),
        }),
      }),
    });

    const res = await getCodes(BIZ_ID);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.codes).toHaveLength(1);
    expect(json.codes[0].code).toBe('TEST');
  });

  it('returns empty array when no codes exist', async () => {
    mockServiceFrom.mockReturnValue({
      select: () => ({
        eq: () => ({
          order: () => Promise.resolve({ data: [], error: null }),
        }),
      }),
    });

    const res = await getCodes(BIZ_ID);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.codes).toEqual([]);
  });

  it('returns 500 with error field on DB failure (not silent empty)', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockServiceFrom.mockReturnValue({
      select: () => ({
        eq: () => ({
          order: () => Promise.resolve({ data: null, error: { code: '42501', message: 'permission denied' } }),
        }),
      }),
    });

    const res = await getCodes(BIZ_ID);
    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.error).toBe('Failed to fetch promo codes');
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('returns 401 for unauthenticated user', async () => {
    setupUnauthenticated();
    const res = await getCodes(BIZ_ID);
    expect(res.status).toBe(401);
  });

  it('returns 403 for wrong business owner', async () => {
    setupWrongOwner();
    const res = await getCodes(BIZ_ID);
    expect(res.status).toBe(403);
  });

  it('returns 400 when businessId is missing', async () => {
    const { GET } = await import('@/app/api/promo-codes/route');
    const req = new NextRequest(new URL('http://localhost:3000/api/promo-codes'), { method: 'GET' });
    const res = await GET(req);
    expect(res.status).toBe(400);
  });
});

describe('PUT /api/promo-codes', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    setupAuthenticatedOwner();
  });

  async function putPromo(body: Record<string, unknown>) {
    const { PUT } = await import('@/app/api/promo-codes/route');
    return PUT(makePutRequest(body));
  }

  it('updates promo code discount', async () => {
    mockServiceFrom.mockReturnValue({
      update: () => ({
        eq: () => ({
          eq: () => Promise.resolve({ error: null }),
        }),
      }),
    });

    const res = await putPromo({ id: PROMO_ID, businessId: BIZ_ID, discountValue: 30 });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
  });

  it('accepts isActive (camelCase) from toggle', async () => {
    let capturedUpdate: Record<string, unknown> = {};
    mockServiceFrom.mockReturnValue({
      update: (data: Record<string, unknown>) => {
        capturedUpdate = data;
        return {
          eq: () => ({
            eq: () => Promise.resolve({ error: null }),
          }),
        };
      },
    });

    const res = await putPromo({ id: PROMO_ID, businessId: BIZ_ID, isActive: false });
    expect(res.status).toBe(200);
    expect(capturedUpdate.is_active).toBe(false);
  });

  it('accepts is_active (snake_case) from edit form', async () => {
    let capturedUpdate: Record<string, unknown> = {};
    mockServiceFrom.mockReturnValue({
      update: (data: Record<string, unknown>) => {
        capturedUpdate = data;
        return {
          eq: () => ({
            eq: () => Promise.resolve({ error: null }),
          }),
        };
      },
    });

    const res = await putPromo({ id: PROMO_ID, businessId: BIZ_ID, is_active: false });
    expect(res.status).toBe(200);
    expect(capturedUpdate.is_active).toBe(false);
  });

  it('returns 500 and logs on DB update failure', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockServiceFrom.mockReturnValue({
      update: () => ({
        eq: () => ({
          eq: () => Promise.resolve({ error: { code: '42501', message: 'permission denied' } }),
        }),
      }),
    });

    const res = await putPromo({ id: PROMO_ID, businessId: BIZ_ID, discountValue: 10 });
    expect(res.status).toBe(500);
    expect(consoleSpy).toHaveBeenCalledWith(
      '[promo-codes] PUT error:',
      expect.objectContaining({ code: '42501' })
    );
    consoleSpy.mockRestore();
  });

  it('returns 400 for missing id or businessId', async () => {
    const res = await putPromo({ businessId: BIZ_ID });
    expect(res.status).toBe(400);
  });

  it('preserves business scoping on update', async () => {
    let eqCalls: string[] = [];
    mockServiceFrom.mockReturnValue({
      update: () => ({
        eq: (col: string, val: string) => {
          eqCalls.push(`${col}=${val}`);
          return {
            eq: (col2: string, val2: string) => {
              eqCalls.push(`${col2}=${val2}`);
              return Promise.resolve({ error: null });
            },
          };
        },
      }),
    });

    await putPromo({ id: PROMO_ID, businessId: BIZ_ID, discountValue: 15 });
    expect(eqCalls).toContain(`id=${PROMO_ID}`);
    expect(eqCalls).toContain(`business_id=${BIZ_ID}`);
  });
});

describe('DELETE /api/promo-codes', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    setupAuthenticatedOwner();
  });

  async function deletePromo(body: Record<string, unknown>) {
    const { DELETE: deleteFn } = await import('@/app/api/promo-codes/route');
    return deleteFn(makeDeleteRequest(body));
  }

  it('deletes promo code successfully', async () => {
    mockServiceFrom.mockReturnValue({
      delete: () => ({
        eq: () => ({
          eq: () => Promise.resolve({ error: null }),
        }),
      }),
    });

    const res = await deletePromo({ id: PROMO_ID, businessId: BIZ_ID });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
  });

  it('returns 500 on DB delete failure (not unconditional success)', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockServiceFrom.mockReturnValue({
      delete: () => ({
        eq: () => ({
          eq: () => Promise.resolve({ error: { code: '42501', message: 'permission denied' } }),
        }),
      }),
    });

    const res = await deletePromo({ id: PROMO_ID, businessId: BIZ_ID });
    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.error).toBe('Failed to delete promo code');
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('preserves business scoping on delete', async () => {
    let eqCalls: string[] = [];
    mockServiceFrom.mockReturnValue({
      delete: () => ({
        eq: (col: string, val: string) => {
          eqCalls.push(`${col}=${val}`);
          return {
            eq: (col2: string, val2: string) => {
              eqCalls.push(`${col2}=${val2}`);
              return Promise.resolve({ error: null });
            },
          };
        },
      }),
    });

    await deletePromo({ id: PROMO_ID, businessId: BIZ_ID });
    expect(eqCalls).toContain(`id=${PROMO_ID}`);
    expect(eqCalls).toContain(`business_id=${BIZ_ID}`);
  });

  it('returns 401 for unauthenticated user', async () => {
    setupUnauthenticated();
    const res = await deletePromo({ id: PROMO_ID, businessId: BIZ_ID });
    expect(res.status).toBe(401);
  });
});

// ══════════════════════════════════════════════════════════════
// 3. Dashboard GET error surfacing assertion
// ══════════════════════════════════════════════════════════════

describe('Dashboard promo-codes page: GET error surfacing', () => {
  it('dashboard fetchCodes sets error=true when API returns error, not silent empty', async () => {
    // Read the page source and verify the fix is in place:
    // data.error should trigger setError(true), not just setCodes([])
    const src = readFileSync(join(process.cwd(), 'app/dashboard/promo-codes/page.tsx'), 'utf-8');

    // The fixed code should have: if (data.error) { setError(true); setCodes([]); }
    // NOT the old pattern: setCodes(data.error ? [] : ...)
    expect(src).toContain('if (data.error)');
    expect(src).toContain('setError(true)');
    // The old silent-empty pattern should be gone
    expect(src).not.toMatch(/setCodes\(data\.error\s*\?\s*\[\]/);
  });
});
