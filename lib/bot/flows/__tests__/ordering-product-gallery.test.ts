/**
 * Issue #879 — WhatsApp ordering flow sends product gallery photos.
 *
 * Owner decision 2026-11-04 (option A): when a customer opens a product, the
 * bot sends the main image plus up to 3 gallery photos, once per product per
 * conversation. Mirrors the services gallery in scheduling.flow.ts.
 *
 * These tests run the real step prompt() functions against a recording
 * Supabase stub, and the real executor sendMessages() against a sender whose
 * gallery image send fails.
 */
import { describe, it, expect, vi } from 'vitest';
import { createMockContext, getStep } from './helpers';
import { orderingFlow } from '../ordering.flow';
import { FlowExecutor } from '../executor';
import type { FlowContext, PromptMessage } from '../types';

const BIZ = 'biz-1';
const MAIN = 'https://cdn.example/p1-main.jpg';
const G1 = 'https://cdn.example/p1-g1.jpg';
const G2 = 'https://cdn.example/p1-g2.jpg';
const G3 = 'https://cdn.example/p1-g3.jpg';

type TableResult = { data: unknown; error?: unknown } | { throws: Error };

/**
 * Recording Supabase stub. Every query on a table resolves to the configured
 * result, whether it ends in single(), maybeSingle() or is awaited directly.
 */
function makeSupabase(tables: Record<string, TableResult | ((eqs: Array<[string, unknown]>) => TableResult)>) {
  const calls: Array<{ table: string; eqs: Array<[string, unknown]> }> = [];
  const from = vi.fn((table: string) => {
    const rec = { table, eqs: [] as Array<[string, unknown]> };
    calls.push(rec);
    const resolveResult = () => {
      const cfg = tables[table];
      const r = typeof cfg === 'function' ? cfg(rec.eqs) : cfg;
      if (!r) return Promise.resolve({ data: null, error: null });
      if ('throws' in r) return Promise.reject(r.throws);
      return Promise.resolve({ data: r.data, error: r.error ?? null });
    };
    const b: Record<string, unknown> = {};
    for (const m of ['select', 'in', 'is', 'order', 'limit', 'neq', 'not', 'gte', 'lte']) b[m] = vi.fn(() => b);
    b.eq = vi.fn((col: string, val: unknown) => { rec.eqs.push([col, val]); return b; });
    b.single = vi.fn(resolveResult);
    b.maybeSingle = vi.fn(resolveResult);
    b.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => resolveResult().then(res, rej);
    return b;
  });
  return { client: { from, rpc: vi.fn() } as unknown, calls };
}

function makeCtx(sessionData: Record<string, unknown>, supabase: unknown): FlowContext {
  const base = createMockContext();
  return createMockContext({
    supabase: supabase as FlowContext['supabase'],
    session: { ...base.session, current_step: '', session_data: sessionData },
    business: { ...base.business!, id: BIZ, flow_type: 'ordering' as never, country_code: 'NG' } as FlowContext['business'],
  });
}

const images = (msgs: PromptMessage[]) =>
  msgs.filter((m): m is Extract<PromptMessage, { type: 'image' }> => m.type === 'image').map(m => m.imageUrl);

const galleryRow = (urls: string[]): TableResult => ({ data: { gallery_urls: urls } });

const singleAxisProduct = (extra: Record<string, unknown> = {}) => ({
  current_product_id: 'p1',
  current_product_name: 'Ankara Dress',
  current_product_price: 15000,
  current_product_has_variants: true,
  current_product_image_url: MAIN,
  ...extra,
});

const oneVariant: TableResult = {
  data: [{ id: 'v1', label: 'Small', price: 15000, stock_quantity: null, image_url: null }],
};

describe('#879 ordering flow sends product gallery photos', () => {
  it('AC1 select_variant: main image, then up to 3 gallery photos, then the list', async () => {
    const { client } = makeSupabase({ products: galleryRow([G1, G2, G3]), product_variants: oneVariant });
    const ctx = makeCtx(singleAxisProduct(), client);

    const msgs = await getStep(orderingFlow, 'select_variant').prompt(ctx);

    expect(images(msgs)).toEqual([MAIN, G1, G2, G3]);
    expect(msgs[msgs.length - 1].type).toBe('list');
    expect(ctx.session.session_data._gallery_sent_product_ids).toEqual(['p1']);
  });

  it('AC2 select_option_axis: gallery on the first axis only', async () => {
    const variantOptions = [
      { name: 'Size', values: ['S', 'M'] },
      { name: 'Colour', values: ['Red'] },
    ];
    const axisVariants: TableResult = {
      data: [
        { id: 'v1', options: { Size: 'S', Colour: 'Red' }, stock_quantity: null, is_active: true },
        { id: 'v2', options: { Size: 'M', Colour: 'Red' }, stock_quantity: null, is_active: true },
      ],
    };
    const { client } = makeSupabase({ products: galleryRow([G1, G2]), product_variants: axisVariants });
    const step = getStep(orderingFlow, 'select_option_axis');

    const ctx = makeCtx(singleAxisProduct({
      current_product_variant_options: variantOptions,
      current_option_axis_index: 0,
      current_selected_options: {},
    }), client);
    const first = await step.prompt(ctx);
    expect(images(first)).toEqual([MAIN, G1, G2]);
    expect(first[first.length - 1].type).toBe('list');

    // Second axis, fresh session (no guard): still no gallery and no main image.
    const ctx2 = makeCtx(singleAxisProduct({
      current_product_variant_options: variantOptions,
      current_option_axis_index: 1,
      current_selected_options: { Size: 'S' },
    }), client);
    const second = await step.prompt(ctx2);
    expect(images(second)).toEqual([]);
  });

  it('AC3 select_quantity (simple product, quick-add off): main image, gallery, then the question', async () => {
    const { client } = makeSupabase({ products: galleryRow([G1]) });
    const ctx = makeCtx({
      current_product_id: 'p1',
      current_product_name: 'Jollof Tray',
      current_product_price: 5000,
      current_product_has_variants: false,
      current_product_image_url: MAIN,
      current_stock_quantity: null,
    }, client);

    const msgs = await getStep(orderingFlow, 'select_quantity').prompt(ctx);

    expect(images(msgs)).toEqual([MAIN, G1]);
    expect(msgs[msgs.length - 1].type).toBe('text');
  });

  it('AC4 once per product: select_quantity after select_variant, and going back, do not repeat the gallery', async () => {
    const { client, calls } = makeSupabase({ products: galleryRow([G1, G2]), product_variants: oneVariant });
    const data = singleAxisProduct();
    const ctx = makeCtx(data, client);

    const first = await getStep(orderingFlow, 'select_variant').prompt(ctx);
    expect(images(first)).toEqual([MAIN, G1, G2]);

    // Customer picks a variant, then sees the quantity step.
    Object.assign(data, { current_variant_id: 'v1', current_variant_label: 'Small', current_stock_quantity: null });
    const qty = await getStep(orderingFlow, 'select_quantity').prompt(ctx);
    expect(images(qty)).toEqual([MAIN]);

    // Customer taps Back to the variant list.
    const back = await getStep(orderingFlow, 'select_variant').prompt(ctx);
    expect(images(back)).toEqual([MAIN]);

    // Gallery was looked up only once.
    const galleryLookups = calls.filter(c => c.table === 'products');
    expect(galleryLookups).toHaveLength(1);
  });

  it('AC5 a different product in the same conversation still gets its gallery', async () => {
    const P2_MAIN = 'https://cdn.example/p2-main.jpg';
    const P2_G = 'https://cdn.example/p2-g1.jpg';
    const { client } = makeSupabase({
      products: (eqs) => {
        const id = eqs.find(([c]) => c === 'id')?.[1];
        return galleryRow(id === 'p2' ? [P2_G] : [G1]);
      },
      product_variants: oneVariant,
    });
    const data: Record<string, unknown> = singleAxisProduct();
    const ctx = makeCtx(data, client);
    const step = getStep(orderingFlow, 'select_variant');

    expect(images(await step.prompt(ctx))).toEqual([MAIN, G1]);

    // add_to_cart clears current_product_* keys; then the customer opens another product.
    Object.assign(data, { current_product_id: 'p2', current_product_name: 'Aso Oke', current_product_image_url: P2_MAIN });
    expect(images(await step.prompt(ctx))).toEqual([P2_MAIN, P2_G]);
    expect(data._gallery_sent_product_ids).toEqual(['p1', 'p2']);

    // Back to the first product: no repeat.
    Object.assign(data, { current_product_id: 'p1', current_product_name: 'Ankara Dress', current_product_image_url: MAIN });
    expect(images(await step.prompt(ctx))).toEqual([MAIN]);
  });

  it('AC6 skips the main image, the shown variant image and duplicates; never more than 3', async () => {
    const VARIANT_IMG = 'https://cdn.example/p1-small.jpg';
    const G4 = 'https://cdn.example/p1-g4.jpg';
    const { client } = makeSupabase({ products: galleryRow([MAIN, G1, G1, VARIANT_IMG, '', G2, G3, G4]) });
    const ctx = makeCtx(singleAxisProduct({
      current_variant_id: 'v1',
      current_variant_label: 'Small',
      current_variant_image_url: VARIANT_IMG,
      current_stock_quantity: null,
    }), client);

    const msgs = await getStep(orderingFlow, 'select_quantity').prompt(ctx);

    expect(images(msgs)).toEqual([VARIANT_IMG, G1, G2, G3]);
  });

  it('AC7 empty gallery: output is unchanged (main image + list only)', async () => {
    const { client } = makeSupabase({ products: galleryRow([]), product_variants: oneVariant });
    const ctx = makeCtx(singleAxisProduct(), client);

    const msgs = await getStep(orderingFlow, 'select_variant').prompt(ctx);

    expect(msgs.map(m => m.type)).toEqual(['image', 'list']);
    expect(images(msgs)).toEqual([MAIN]);
  });

  it('AC7b gallery is sent even when the product has no main image (as services do)', async () => {
    const { client } = makeSupabase({ products: galleryRow([G1]), product_variants: oneVariant });
    const ctx = makeCtx(singleAxisProduct({ current_product_image_url: null }), client);

    const msgs = await getStep(orderingFlow, 'select_variant').prompt(ctx);

    expect(images(msgs)).toEqual([G1]);
  });

  it('AC8 lookup error or throw: step still works and the product is not marked as sent', async () => {
    for (const failure of [
      { data: null, error: { message: 'column does not exist' } } as TableResult,
      { throws: new Error('network down') } as TableResult,
    ]) {
      const { client } = makeSupabase({ products: failure, product_variants: oneVariant });
      const ctx = makeCtx(singleAxisProduct(), client);

      const msgs = await getStep(orderingFlow, 'select_variant').prompt(ctx);

      expect(msgs.map(m => m.type)).toEqual(['image', 'list']);
      expect(ctx.session.session_data._gallery_sent_product_ids).toBeUndefined();
    }
  });

  it('AC9 gallery lookup is scoped to the current product and business', async () => {
    const { client, calls } = makeSupabase({ products: galleryRow([G1]), product_variants: oneVariant });
    const ctx = makeCtx(singleAxisProduct(), client);

    await getStep(orderingFlow, 'select_variant').prompt(ctx);

    const lookup = calls.find(c => c.table === 'products');
    expect(lookup?.eqs).toEqual(expect.arrayContaining([['id', 'p1'], ['business_id', BIZ]]));
  });
});

describe('#879 executor: a failed gallery photo does not break the step', () => {
  it('AC10 sendMessages keeps sending after one image send fails', async () => {
    const sender = {
      sendText: vi.fn().mockResolvedValue({}),
      sendButtons: vi.fn().mockResolvedValue({}),
      sendList: vi.fn().mockResolvedValue({}),
      sendDocument: vi.fn().mockResolvedValue({}),
      sendImage: vi.fn(async ({ imageUrl }: { imageUrl: string }) => {
        if (imageUrl === G1) throw new Error('Meta: media download failed');
        return {};
      }),
    };
    const executor = new FlowExecutor({} as never, sender as never, {} as never, {} as never);
    const messages: PromptMessage[] = [
      { type: 'image', imageUrl: MAIN, caption: 'Ankara Dress' },
      { type: 'image', imageUrl: G1 },
      { type: 'image', imageUrl: G2 },
      { type: 'list', title: 'Ankara Dress', body: 'Choose an option', buttonLabel: 'Select', items: [{ title: 'Small', description: '', postbackText: 'v1' }] },
    ];

    await (executor as unknown as {
      sendMessages: (to: string, m: PromptMessage[], s: undefined, t: unknown) => Promise<void>;
    }).sendMessages('+2340000000000', messages, undefined, {});

    expect(sender.sendImage.mock.calls.map(c => c[0].imageUrl)).toEqual([MAIN, G1, G2]);
    expect(sender.sendList).toHaveBeenCalledTimes(1);
  });
});
