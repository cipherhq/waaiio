/**
 * Ordering lists stay inside Meta's WhatsApp list limits, and every product
 * stays reachable (Owner decision 2026-11-24: "Keep all 22, fix bug").
 *
 * Staging Sentry JAVASCRIPT-NEXTJS-B/C: a 22-product catalog in 3 categories
 * built a list with 17 rows; Meta rejected it (131009, max 10 rows in total).
 *
 * These tests run the real ordering step prompt/validate/next functions against
 * a Supabase stub, merging validate() data into the session the way the
 * executor does, and walk every list by tapping its rows.
 */
import { describe, it, expect, vi } from 'vitest';
import { createMockContext, getStep } from './helpers';
import { orderingFlow } from '../ordering.flow';
import type { FlowContext, PromptMessage } from '../types';
import { LIST_PAGE_MORE, LIST_PAGE_PREV, pageListRows } from '../shared/list-pages';
import { MetaCloudService } from '@/lib/channels/meta-cloud';
import { logger } from '@/lib/logger';

type Product = { id: string; name: string; price: number; category: string | null; has_variants: boolean; stock_quantity: number | null; track_inventory: boolean; low_stock_threshold: number | null; min_order_qty: number; image_url: null; variant_options: [] };

const product = (i: number, category: string | null): Product => ({
  id: `p${i}`, name: `Product ${i}`, price: 1000 + i, category,
  has_variants: false, stock_quantity: null, track_inventory: false, low_stock_threshold: null,
  min_order_qty: 1, image_url: null, variant_options: [],
});

/** Simi Scents shape: 22 products, 3 categories (9 / 6 / 7). */
const SIMI = [
  ...Array.from({ length: 9 }, (_, i) => product(i + 1, 'Signature Oils')),
  ...Array.from({ length: 6 }, (_, i) => product(i + 10, 'Premium Oils')),
  ...Array.from({ length: 7 }, (_, i) => product(i + 16, 'Diffusers')),
];

/** Stub: products queries honour eq() filters; everything else is empty. */
function makeSupabase(products: Product[]) {
  const from = vi.fn((table: string) => {
    const eqs: Array<[string, unknown]> = [];
    const rows = () => (table === 'products' ? products.filter(p => eqs.every(([c, v]) => c === 'business_id' || c === 'is_active' || (p as Record<string, unknown>)[c] === v)) : []);
    const b: Record<string, unknown> = {};
    for (const m of ['select', 'in', 'is', 'order', 'limit', 'neq', 'not', 'gte', 'lte']) b[m] = vi.fn(() => b);
    b.eq = vi.fn((c: string, v: unknown) => { eqs.push([c, v]); return b; });
    b.single = vi.fn(async () => ({ data: rows()[0] ?? null, error: null }));
    b.maybeSingle = b.single;
    b.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve({ data: rows(), error: null }).then(res, rej);
    return b;
  });
  return { from, rpc: vi.fn(async () => ({ data: null, error: null })) };
}

function makeCtx(products: Product[], metadata: Record<string, unknown> = {}, sessionData: Record<string, unknown> = {}): FlowContext {
  const base = createMockContext();
  return createMockContext({
    supabase: makeSupabase(products) as unknown as FlowContext['supabase'],
    session: { ...base.session, current_step: 'browse_catalog', session_data: { ...sessionData } },
    business: { ...base.business!, id: 'biz-1', name: 'Simi Scents', country_code: 'NG', flow_type: 'ordering' as never, metadata } as FlowContext['business'],
  });
}

type ListMsg = Extract<PromptMessage, { type: 'list' }>;

function listOf(msgs: PromptMessage[]): ListMsg {
  const list = msgs.find((m): m is ListMsg => m.type === 'list');
  if (!list) throw new Error(`expected a list, got ${msgs.map(m => m.type).join(',')}`);
  return list;
}

/** Every row Meta would receive: the sender sends sections when present, else items. */
function sentRows(list: ListMsg) {
  return list.sections ? list.sections.flatMap(s => s.items) : list.items;
}

function expectWithinMetaLimits(list: ListMsg) {
  const rows = sentRows(list);
  expect(rows.length).toBeLessThanOrEqual(10);
  expect((list.sections || []).length).toBeLessThanOrEqual(10);
  expect(new Set(rows.map(r => r.postbackText)).size).toBe(rows.length);
  for (const r of rows) {
    expect(r.title.length).toBeLessThanOrEqual(24);
    expect((r.description || '').length).toBeLessThanOrEqual(72);
  }
  expect(list.buttonLabel.length).toBeLessThanOrEqual(20);
}

/** Tap a row the way the executor would: validate → merge data → next. */
async function tap(ctx: FlowContext, stepId: string, input: string): Promise<string | null> {
  const step = getStep(orderingFlow, stepId);
  const result = await step.validate(input, ctx);
  expect(result.valid).toBe(true);
  Object.assign(ctx.session.session_data, result.data || {});
  const next = await step.next!(ctx);
  ctx.session.current_step = next || '';
  return next;
}

async function show(ctx: FlowContext, stepId: string): Promise<ListMsg> {
  const list = listOf(await getStep(orderingFlow, stepId).prompt(ctx));
  expectWithinMetaLimits(list);
  return list;
}

/**
 * Walk every list reachable from `stepId` through More / Previous / category
 * rows (never adding to cart) and return the product ids seen.
 */
async function reachableProducts(products: Product[], metadata: Record<string, unknown>, stepId: string, sessionData: Record<string, unknown> = {}): Promise<Set<string>> {
  const ids = new Set(products.map(p => p.id));
  const seen = new Set<string>();
  const visited = new Set<string>();
  const queue: Array<{ step: string; session: Record<string, unknown> }> = [{ step: stepId, session: sessionData }];
  while (queue.length) {
    const { step, session } = queue.shift()!;
    const ctx = makeCtx(products, metadata, structuredClone(session));
    const list = await show(ctx, step);
    const after = structuredClone(ctx.session.session_data);
    const key = `${step}|${JSON.stringify(sentRows(list).map(r => r.postbackText))}`;
    if (visited.has(key)) continue;
    visited.add(key);
    expect(visited.size).toBeLessThan(60);
    for (const row of sentRows(list)) {
      if (ids.has(row.postbackText)) { seen.add(row.postbackText); continue; }
      if (row.postbackText === LIST_PAGE_MORE || row.postbackText === LIST_PAGE_PREV || row.postbackText.startsWith('cat:')) {
        const navCtx = makeCtx(products, metadata, structuredClone(after));
        const next = await tap(navCtx, step, row.postbackText);
        queue.push({ step: next!, session: navCtx.session.session_data });
      }
    }
  }
  return seen;
}

describe('ordering lists: Meta limits and every product reachable', () => {
  it('pageListRows keeps every row reachable with at most 10 per page', () => {
    const nav = { prev: 'PREV', more: 'MORE', fixed: ['CHECKOUT'] };
    for (const n of [0, 1, 9, 10, 17, 22, 50]) {
      const rows = Array.from({ length: n }, (_, i) => `r${i}`);
      const seen: string[] = [];
      const first = pageListRows(rows, 0, nav);
      for (let page = 0; page < first.totalPages; page++) {
        const p = pageListRows(rows, page, nav);
        expect(p.rows.length).toBeLessThanOrEqual(10);
        expect(p.rows[0]).toBe('CHECKOUT');
        expect(p.rows.includes('PREV')).toBe(page > 0);
        expect(p.rows.includes('MORE')).toBe(page < first.totalPages - 1);
        seen.push(...p.rows.filter(r => r.startsWith('r')));
      }
      expect(seen).toEqual(rows);
    }
    // A page past the end shows the last page
    expect(pageListRows(['a', 'b'], 5, nav).page).toBe(0);
  });

  it('22 products in 3 categories, all-at-once mode: first list fits and all 22 are reachable', async () => {
    const seen = await reachableProducts(SIMI, {}, 'browse_catalog');
    expect([...seen].sort()).toEqual(SIMI.map(p => p.id).sort());
  });

  it('22 products in 3 categories, browse-by-category: all 22 are reachable', async () => {
    const seen = await reachableProducts(SIMI, { ordering_browse_by_category: true }, 'browse_catalog');
    expect([...seen].sort()).toEqual(SIMI.map(p => p.id).sort());
  });

  it('one category with 22 products: pages with More / Previous reach every product', async () => {
    const one = SIMI.map(p => ({ ...p, category: 'Oils' }));
    for (const meta of [{}, { ordering_browse_by_category: true }]) {
      const seen = await reachableProducts(one, meta, 'browse_catalog');
      expect(seen.size).toBe(22);
    }
  });

  it('a category with 15 products is paged inside the category view (back row kept on every page)', async () => {
    const big = [...Array.from({ length: 15 }, (_, i) => product(i + 1, 'Oils')), product(16, 'Diffusers')];
    const seen = await reachableProducts(big, { ordering_browse_by_category: true }, 'browse_category_items', { _selected_category: 'Oils' });
    expect(seen.size).toBe(15);
    const ctx = makeCtx(big, {}, { _selected_category: 'Oils', _category_page: 1 });
    const page2 = await show(ctx, 'browse_category_items');
    expect(page2.items[0].postbackText).toBe('back_to_categories');
    expect(page2.items[1].postbackText).toBe(LIST_PAGE_PREV);
  });

  it('products with no category are reachable through the "Menu" category', async () => {
    const mixed = [...Array.from({ length: 8 }, (_, i) => product(i + 1, null)), ...Array.from({ length: 8 }, (_, i) => product(i + 9, 'Drinks'))];
    const seen = await reachableProducts(mixed, {}, 'browse_catalog');
    expect(seen.size).toBe(16);
  });

  it('more than 10 categories: category list is paged and every product is reachable', async () => {
    const many = Array.from({ length: 25 }, (_, i) => product(i + 1, `Category ${Math.floor(i / 2) + 1}`)); // 13 categories
    const ctx = makeCtx(many);
    const first = await show(ctx, 'browse_catalog');
    expect(first.items.at(-1)!.postbackText).toBe(LIST_PAGE_MORE);
    const seen = await reachableProducts(many, {}, 'browse_catalog');
    expect(seen.size).toBe(25);
  });

  it('add more after adding to cart: ≤10 rows, checkout reachable, every product reachable', async () => {
    const cart = [{ product_id: 'p1', name: 'Product 1', price: 1001, quantity: 1 }];
    // add_to_cart prompt (all-at-once mode): the list right after an item is added
    const ctx = makeCtx(SIMI, {}, { cart, current_product_id: 'p2', current_product_name: 'Product 2', current_product_price: 1002, current_quantity: 1 });
    const added = await show(ctx, 'add_to_cart');
    expect(added.items[0].postbackText).toBe('checkout');
    // Its rows are answered by continue_or_checkout (nextAfterPrompt)
    const session = structuredClone(ctx.session.session_data);
    for (const start of ['continue_or_checkout']) {
      const seen = await reachableProducts(SIMI, {}, start, session);
      expect(seen.size).toBe(22);
    }
    const checkoutCtx = makeCtx(SIMI, {}, session);
    expect(await tap(checkoutCtx, 'continue_or_checkout', 'checkout')).toBe('apply_promo');

    // Every continue_or_checkout page keeps Checkout
    const one = SIMI.map(p => ({ ...p, category: 'Oils' }));
    for (let page = 0; page < 3; page++) {
      const c = makeCtx(one, {}, { cart, _cart_page: page });
      const list = await show(c, 'continue_or_checkout');
      expect(list.items[0].postbackText).toBe('checkout');
    }
    const seenOne = await reachableProducts(one, {}, 'continue_or_checkout', { cart });
    expect(seenOne.size).toBe(22);
  });

  it('≤10 products: lists are exactly as before (no paging rows)', async () => {
    const small = [...Array.from({ length: 5 }, (_, i) => product(i + 1, 'Oils')), ...Array.from({ length: 4 }, (_, i) => product(i + 6, 'Diffusers'))];
    const browse = await show(makeCtx(small), 'browse_catalog');
    expect(browse.sections).toBeUndefined();
    expect(browse.items.map(r => r.postbackText)).toEqual(small.map(p => p.id));

    const ten = Array.from({ length: 10 }, (_, i) => product(i + 1, 'Oils'));
    const browseTen = await show(makeCtx(ten), 'browse_catalog');
    expect(browseTen.items.map(r => r.postbackText)).toEqual(ten.map(p => p.id));

    const cart = [{ product_id: 'p1', name: 'Product 1', price: 1001, quantity: 1 }];
    const coc = await show(makeCtx(small, {}, { cart }), 'continue_or_checkout');
    expect(coc.items.map(r => r.postbackText)).toEqual(['checkout', ...small.map(p => p.id)]);

    const cats = await show(makeCtx(small, { ordering_browse_by_category: true }), 'browse_catalog');
    expect(cats.items.map(r => r.postbackText)).toEqual(['cat:Oils', 'cat:Diffusers']);
    const inCat = await show(makeCtx(small, {}, { _selected_category: 'Oils' }), 'browse_category_items');
    expect(inCat.items.map(r => r.postbackText)).toEqual(['back_to_categories', 'p1', 'p2', 'p3', 'p4', 'p5']);
  });
});

describe('meta-cloud sendList backstop', () => {
  it('never sends more than 10 rows or duplicate ids, and logs loudly when it has to cut', async () => {
    const svc = new MetaCloudService({ accessToken: 't', phoneNumberId: 'ph', wabaId: 'w' } as never);
    const callApi = vi.fn(async () => ({ messages: [{ id: 'm1' }] }));
    (svc as unknown as { callApi: typeof callApi }).callApi = callApi;
    const err = vi.spyOn(logger, 'error').mockImplementation(() => undefined as never);

    await svc.sendList({
      to: '234', bodyText: 'b', buttonText: 'Browse',
      sections: [
        { title: 'A', rows: Array.from({ length: 9 }, (_, i) => ({ id: `a${i}`, title: `A${i}` })) },
        { title: 'B', rows: [{ id: 'a0', title: 'dup' }, ...Array.from({ length: 7 }, (_, i) => ({ id: `b${i}`, title: `B${i}` }))] },
      ],
    });
    const sections = (callApi.mock.calls[0] as unknown as [string, { interactive: { action: { sections: Array<{ rows: Array<{ id: string }> }> } } }])[1].interactive.action.sections;
    const ids = sections.flatMap(s => s.rows.map(r => r.id));
    expect(ids.length).toBe(10);
    expect(new Set(ids).size).toBe(10);
    expect(err).toHaveBeenCalledWith(expect.stringContaining('over WhatsApp list limits'), expect.objectContaining({ totalRows: 17, droppedRows: 7 }));

    err.mockClear();
    callApi.mockClear();
    await svc.sendList({ to: '234', bodyText: 'b', buttonText: 'Browse', sections: [{ title: 'A', rows: [{ id: 'x', title: 'X' }] }] });
    expect(err).not.toHaveBeenCalled();
    err.mockRestore();
  });
});
