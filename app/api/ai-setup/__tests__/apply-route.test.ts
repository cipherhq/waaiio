/**
 * Ace setup apply — executable handler tests for POST /api/ai-setup/apply.
 *
 * Invokes the real route handler and the real payload builders. Supabase is
 * mocked with an in-memory fake that records every insert so we can assert
 * exactly what would be written.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const SUPABASE_URL = 'https://proj.supabase.co';

const h = vi.hoisted(() => ({
  user: { id: 'user-1' } as { id: string } | null,
  ownedBusinessId: 'biz-1',
  existing: {} as Record<string, string[]>,
  insertError: {} as Record<string, string | undefined>,
  inserts: {} as Record<string, Array<Record<string, unknown>>>,
  serviceFromCalls: 0,
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: h.user } }) },
    from: () => {
      const filters: Record<string, unknown> = {};
      const chain: Record<string, unknown> = {};
      chain.select = () => chain;
      chain.eq = (col: string, val: unknown) => { filters[col] = val; return chain; };
      chain.single = async () => ({
        data: filters.id === h.ownedBusinessId && filters.owner_id === h.user?.id
          ? { id: h.ownedBusinessId, subscription_tier: 'free' } : null,
      });
      return chain;
    },
  }),
}));

vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => ({
    from: (table: string) => {
      h.serviceFromCalls++;
      let op: 'select' | 'insert' | 'update' = 'select';
      let rows: Array<Record<string, unknown>> = [];
      const b: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'in', 'order', 'limit']) b[m] = () => b;
      b.insert = (r: Array<Record<string, unknown>>) => {
        op = 'insert';
        rows = r;
        if (!h.insertError[table]) h.inserts[table] = [...(h.inserts[table] || []), ...r];
        return b;
      };
      b.update = () => { op = 'update'; return b; };
      b.maybeSingle = async () => ({ data: null, error: null });
      b.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
        let result: unknown;
        if (op === 'insert') {
          const err = h.insertError[table];
          result = err ? { data: null, error: { message: err } } : { data: rows.map((r, i) => ({ id: `id-${i}`, name: r.name })), error: null };
        } else if (op === 'update') {
          result = { data: null, error: null };
        } else {
          result = { data: (h.existing[table] || []).map((name) => ({ name })), error: null };
        }
        return Promise.resolve(result).then(resolve, reject);
      };
      return b;
    },
  }),
}));

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { POST } from '../apply/route';
import { buildAiSetupProductRow, isAiSetupProductImageUrl } from '@/lib/services/payload-builders';

const ownImage = `${SUPABASE_URL}/storage/v1/object/public/business-documents/biz-1/products/1730000000000.jpg`;

function post(body: Record<string, unknown>) {
  return POST(new NextRequest('http://localhost/api/ai-setup/apply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ business_id: 'biz-1', ...body }),
  }));
}

const originalUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE_URL;
  h.user = { id: 'user-1' };
  h.existing = {};
  h.insertError = {};
  h.inserts = {};
  h.serviceFromCalls = 0;
});

afterEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = originalUrl;
});

describe('ownership', () => {
  it('401 without a user', async () => {
    h.user = null;
    expect((await post({ products: [{ name: 'A', price: 1 }] })).status).toBe(401);
    expect(h.serviceFromCalls).toBe(0);
  });

  it('404 for a business the user does not own — nothing written', async () => {
    const res = await POST(new NextRequest('http://localhost/api/ai-setup/apply', {
      method: 'POST',
      body: JSON.stringify({ business_id: 'biz-2', products: [{ name: 'A', price: 1 }] }),
    }));
    expect(res.status).toBe(404);
    expect(h.serviceFromCalls).toBe(0);
  });
});

describe('products', () => {
  it('clamps and rounds product rows', async () => {
    const res = await post({
      products: [
        { name: 'N'.repeat(300), price: 12.6, category: 'C'.repeat(150), description: 'D'.repeat(2000) },
        { name: 'Huge', price: 1e12 },
        { name: 'Negative', price: -4 },
      ],
    });
    expect(res.status).toBe(200);
    expect((await res.json()).success).toBe(true);
    const [a, b, c] = h.inserts.products;
    expect((a.name as string).length).toBe(200);
    expect(a.price).toBe(13);
    expect((a.category as string).length).toBe(100);
    expect((a.description as string).length).toBe(1000);
    expect(a.business_id).toBe('biz-1');
    expect(b.price).toBe(99999999);
    expect(c.price).toBe(0);
  });

  it('rejects a product with no price but still creates the others (success:false)', async () => {
    const res = await post({ products: [{ name: 'Zobo', price: null }, { name: 'Kunu' }, { name: 'Chapman', price: 800 }] });
    expect(res.status).toBe(207);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.results.products.created).toBe(1);
    expect(body.results.products.errors).toEqual([
      { name: 'Zobo', error: 'Price is required.' },
      { name: 'Kunu', error: 'Price is required.' },
    ]);
    expect(h.inserts.products.map((r) => r.name)).toEqual(['Chapman']);
  });

  it('skips duplicates of existing products', async () => {
    h.existing.products = ['Jollof Rice'];
    const body = await (await post({ products: [{ name: 'jollof rice', price: 2500 }, { name: 'Fried Rice', price: 2500 }] })).json();
    expect(body.success).toBe(true);
    expect(body.results.products).toEqual({ created: 1, skipped: 1 });
    expect(h.inserts.products.map((r) => r.name)).toEqual(['Fried Rice']);
  });

  it("accepts this business's own uploaded product photo", async () => {
    const body = await (await post({ products: [{ name: 'Sneakers', price: 30, image_url: ownImage }] })).json();
    expect(body.success).toBe(true);
    expect(h.inserts.products[0].image_url).toBe(ownImage);
  });

  it.each([
    ['another business', `${SUPABASE_URL}/storage/v1/object/public/business-documents/biz-2/products/1.jpg`],
    ['an outside host', 'https://evil.example/storage/v1/object/public/business-documents/biz-1/products/1.jpg'],
    ['path traversal', `${SUPABASE_URL}/storage/v1/object/public/business-documents/biz-1/products/../../biz-2/products/1.jpg`],
    ['a different folder', `${SUPABASE_URL}/storage/v1/object/public/business-documents/biz-1/documents/1.jpg`],
    ['a query string', `${ownImage}?x=1`],
  ])('rejects a product photo from %s', async (_label, url) => {
    const res = await post({ products: [{ name: 'Sneakers', price: 30, image_url: url }] });
    expect(res.status).toBe(207);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.results.products.errors[0].error).toMatch(/not a valid upload/);
    expect(h.inserts.products).toBeUndefined();
  });
});

describe('services', () => {
  it('rounds service price and deposit to whole numbers', async () => {
    const body = await (await post({ services: [{ name: 'Braids', price: 2500.5, deposit_amount: 999.4, duration_minutes: 90.7 }] })).json();
    expect(body.success).toBe(true);
    expect(h.inserts.services[0]).toMatchObject({ price: 2501, deposit_amount: 999, duration_minutes: 91 });
  });

  it('rejects a service with no price, and a deposit above price, without a 500', async () => {
    const res = await post({ services: [
      { name: 'No price', price: null },
      { name: 'Bad deposit', price: 100, deposit_amount: 200 },
      { name: 'Haircut', price: 15 },
    ] });
    expect(res.status).toBe(207);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.results.services.errors.map((e: { name: string }) => e.name)).toEqual(['No price', 'Bad deposit']);
    expect(h.inserts.services.map((r) => r.name)).toEqual(['Haircut']);
  });

  it('keeps price 0 (free services) valid', async () => {
    const body = await (await post({ services: [{ name: 'Sunday Worship', price: 0 }] })).json();
    expect(body.success).toBe(true);
    expect(h.inserts.services[0].price).toBe(0);
  });
});

describe('partial failure', () => {
  it('a failed section insert returns success:false with a generic section error', async () => {
    h.insertError.services = 'violates check constraint "services_price_check"';
    const res = await post({
      services: [{ name: 'Haircut', price: 15 }],
      products: [{ name: 'Hair oil', price: 20 }],
    });
    expect(res.status).toBe(207);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.results.services.error).toBe('Could not save these items. Please try again.');
    expect(body.results.products).toEqual({ created: 1, skipped: 0 });
  });

  it('rejects non-list item payloads', async () => {
    expect((await post({ products: 'Jollof' })).status).toBe(400);
  });
});

describe('isAiSetupProductImageUrl / buildAiSetupProductRow', () => {
  it('requires the configured Supabase URL', () => {
    expect(isAiSetupProductImageUrl(ownImage, 'biz-1', undefined)).toBe(false);
    expect(isAiSetupProductImageUrl(ownImage, 'biz-1', `${SUPABASE_URL}/`)).toBe(true);
  });

  it('a product row without image_url stores null', () => {
    const row = buildAiSetupProductRow({ businessId: 'biz-1', name: ' Puff puff ', price: 500, sortOrder: 3, supabaseUrl: SUPABASE_URL });
    expect(row).toEqual({
      business_id: 'biz-1', name: 'Puff puff', price: 500, description: null, category: null,
      image_url: null, is_active: true, sort_order: 3,
    });
  });
});
