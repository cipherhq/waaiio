/**
 * Product/variant availability tests (#352 Phase 1 R18).
 *
 * Part A: Production helpers (behavioral)
 * Part B: Multi-axis viable-value filtering (production helper)
 * Part C: Smart-intent classification (production helper)
 * Part D: Executable select_option_axis step tests
 * Part E: Smart-intent wiring verification
 * Part F: Structural supplemental
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

import {
  isProductAvailable,
  computeVariantAvailability,
  getViableAxisValues,
  classifySmartIntentMatch,
} from '@/lib/bot/flows/shared/product-availability';

// ═══ Part A: isProductAvailable ═══

describe('isProductAvailable (production)', () => {
  it('simple untracked: always available', () => {
    expect(isProductAvailable({ track_inventory: false, stock_quantity: null, has_variants: false })).toBe(true);
  });

  it('simple tracked stock>0: available', () => {
    expect(isProductAvailable({ track_inventory: true, stock_quantity: 5, has_variants: false })).toBe(true);
  });

  it('simple tracked stock=0: unavailable', () => {
    expect(isProductAvailable({ track_inventory: true, stock_quantity: 0, has_variants: false })).toBe(false);
  });

  it('variable + active unlimited variant: available', () => {
    const avail = computeVariantAvailability([{ product_id: 'p1', stock_quantity: null, is_active: true }]);
    expect(isProductAvailable({ track_inventory: true, stock_quantity: null, has_variants: true }, avail, 'p1')).toBe(true);
  });

  it('variable all OOS: unavailable', () => {
    const avail = computeVariantAvailability([{ product_id: 'p1', stock_quantity: 0, is_active: true }]);
    expect(isProductAvailable({ track_inventory: true, stock_quantity: null, has_variants: true }, avail, 'p1')).toBe(false);
  });

  it('inactive variant does NOT count', () => {
    const avail = computeVariantAvailability([{ product_id: 'p1', stock_quantity: 10, is_active: false }]);
    expect(isProductAvailable({ track_inventory: true, stock_quantity: null, has_variants: true }, avail, 'p1')).toBe(false);
  });
});

// ═══ Part B: getViableAxisValues ═══

describe('getViableAxisValues (production)', () => {
  const variants = [
    { options: { Size: 'S', Color: 'Red' }, stock_quantity: 5, is_active: true },
    { options: { Size: 'S', Color: 'Blue' }, stock_quantity: null, is_active: true },
    { options: { Size: 'M', Color: 'Red' }, stock_quantity: 0, is_active: true },
    { options: { Size: 'M', Color: 'Blue' }, stock_quantity: 0, is_active: true },
    { options: { Size: 'L', Color: 'Red' }, stock_quantity: 3, is_active: true },
  ];

  it('M hidden (all OOS)', () => {
    expect(getViableAxisValues(variants, {}, 'Size')).not.toContain('M');
  });

  it('S and L shown', () => {
    const sizes = getViableAxisValues(variants, {}, 'Size');
    expect(sizes).toContain('S');
    expect(sizes).toContain('L');
  });

  it('Size=S → Red+Blue', () => {
    const colors = getViableAxisValues(variants, { Size: 'S' }, 'Color');
    expect(colors).toContain('Red');
    expect(colors).toContain('Blue');
  });

  it('unlimited NULL selectable', () => {
    expect(getViableAxisValues(variants, { Size: 'S' }, 'Color')).toContain('Blue');
  });

  it('all OOS → empty', () => {
    expect(getViableAxisValues([{ options: { X: 'A' }, stock_quantity: 0, is_active: true }], {}, 'X')).toHaveLength(0);
  });
});

// ═══ Part C: classifySmartIntentMatch ═══

describe('classifySmartIntentMatch (production)', () => {
  it('no match → no_match', () => {
    expect(classifySmartIntentMatch([])).toBe('no_match');
  });
  it('simple unique → auto_add', () => {
    expect(classifySmartIntentMatch([{ id: 'p1', has_variants: false }])).toBe('auto_add');
  });
  it('variable unique → variant_picker', () => {
    expect(classifySmartIntentMatch([{ id: 'p1', has_variants: true }])).toBe('variant_picker');
  });
  it('multiple → narrow_catalog', () => {
    expect(classifySmartIntentMatch([{ id: 'p1', has_variants: false }, { id: 'p2', has_variants: true }])).toBe('narrow_catalog');
  });
});

// ═══ Part D: Executable select_option_axis step tests ═══

// Build a minimal mock FlowContext
function mockFlowContext(sessionData: Record<string, unknown>, variantRows: unknown[] = []) {
  const sentMessages: unknown[] = [];
  return {
    session: { session_data: sessionData } as any,
    business: { id: 'biz-1', country_code: 'NG', metadata: {} } as any,
    from: '+234900',
    sender: {
      sendText: vi.fn(async (msg: unknown) => { sentMessages.push(msg); }),
    },
    supabase: {
      from: (table: string) => ({
        select: () => ({
          eq: () => ({
            eq: () => Promise.resolve({ data: variantRows, error: null }),
          }),
        }),
      }),
    } as any,
    t: async (s: string) => s,
    _sentMessages: sentMessages,
  };
}

describe('select_option_axis step — executable', () => {
  // Import the actual flow definition
  let selectOptionAxis: any;

  it('setup: find select_option_axis step', async () => {
    const { orderingFlow } = await import('@/lib/bot/flows/ordering.flow');
    selectOptionAxis = orderingFlow.steps.find((s: any) => s.id === 'select_option_axis');
    expect(selectOptionAxis).toBeDefined();
  });

  it('prompt: displays only viable values', async () => {
    if (!selectOptionAxis) return;
    const variantRows = [
      { id: 'v1', options: { Size: 'S' }, stock_quantity: 5, is_active: true },
      { id: 'v2', options: { Size: 'M' }, stock_quantity: 0, is_active: true },
      { id: 'v3', options: { Size: 'L' }, stock_quantity: null, is_active: true },
    ];
    const ctx = mockFlowContext({
      current_product_id: 'prod-1',
      current_product_name: 'T-Shirt',
      current_product_variant_options: [{ name: 'Size', values: ['S', 'M', 'L'] }],
      current_option_axis_index: 0,
      current_selected_options: {},
    }, variantRows);

    const messages = await selectOptionAxis.prompt(ctx);
    const listMsg = messages.find((m: any) => m.type === 'list');
    expect(listMsg).toBeDefined();
    const titles = listMsg.items.map((item: any) => item.title);
    expect(titles).toContain('S');
    expect(titles).toContain('L');
    expect(titles).not.toContain('M'); // OOS
  });

  it('prompt: all OOS → Try Another + Cancel buttons', async () => {
    if (!selectOptionAxis) return;
    const variantRows = [
      { id: 'v1', options: { Size: 'S' }, stock_quantity: 0, is_active: true },
    ];
    const ctx = mockFlowContext({
      current_product_id: 'prod-1',
      current_product_name: 'T-Shirt',
      current_product_variant_options: [{ name: 'Size', values: ['S'] }],
      current_option_axis_index: 0,
      current_selected_options: {},
    }, variantRows);

    const messages = await selectOptionAxis.prompt(ctx);
    const btnMsg = messages.find((m: any) => m.type === 'buttons');
    expect(btnMsg).toBeDefined();
    const btnIds = btnMsg.buttons.map((b: any) => b['id']);
    expect(btnIds).toContain('browse_more');
    expect(btnIds).toContain('cancel_order');
  });

  it('validate: stale OOS postback rejected', async () => {
    if (!selectOptionAxis) return;
    const variantRows = [
      { id: 'v1', options: { Size: 'S' }, stock_quantity: 5, is_active: true },
      { id: 'v2', options: { Size: 'M' }, stock_quantity: 0, is_active: true },
    ];
    const ctx = mockFlowContext({
      current_product_id: 'prod-1',
      current_product_variant_options: [{ name: 'Size', values: ['S', 'M'] }],
      current_option_axis_index: 0,
      current_selected_options: {},
    }, variantRows);

    const result = await selectOptionAxis.validate('M', ctx);
    expect(result.valid).toBe(false);
    expect(result.errorMessage).toContain('not available');
  });

  it('validate: unlimited NULL stock selectable', async () => {
    if (!selectOptionAxis) return;
    const variantRows = [
      { id: 'v1', options: { Size: 'L' }, stock_quantity: null, is_active: true },
    ];
    const ctx = mockFlowContext({
      current_product_id: 'prod-1',
      current_product_variant_options: [{ name: 'Size', values: ['L'] }],
      current_option_axis_index: 0,
      current_selected_options: {},
    }, variantRows);

    const result = await selectOptionAxis.validate('L', ctx);
    expect(result.valid).toBe(true);
    expect(result.data.current_selected_options.Size).toBe('L');
  });

  it('validate(browse_more) + next() → browse_catalog', async () => {
    if (!selectOptionAxis) return;
    const ctx = mockFlowContext({
      current_product_id: 'prod-1',
      current_product_name: 'T-Shirt',
      current_selected_options: { Size: 'S' },
      current_option_axis_index: 1,
    });

    const result = await selectOptionAxis.validate('browse_more', ctx);
    expect(result.valid).toBe(true);
    expect(result.data._axis_recovery).toBe('browse_more');

    // Apply validate data to session
    Object.assign(ctx.session.session_data, result.data);
    const nextStep = await selectOptionAxis.next(ctx);
    expect(nextStep).toBe('browse_catalog');
    // Stale state cleared
    expect(ctx.session.session_data.current_selected_options).toBeUndefined();
    expect(ctx.session.session_data.current_option_axis_index).toBeUndefined();
    expect(ctx.session.session_data.current_product_id).toBeUndefined();
  });

  it('validate(cancel_order) + next() → null (terminates flow)', async () => {
    if (!selectOptionAxis) return;
    const ctx = mockFlowContext({
      current_product_id: 'prod-1',
    });

    const result = await selectOptionAxis.validate('cancel_order', ctx);
    expect(result.valid).toBe(true);
    expect(result.data._axis_recovery).toBe('cancel');

    Object.assign(ctx.session.session_data, result.data);
    const nextStep = await selectOptionAxis.next(ctx);
    expect(nextStep).toBeNull();
  });

  it('prior selection narrows next axis', async () => {
    if (!selectOptionAxis) return;
    const variantRows = [
      { id: 'v1', options: { Size: 'S', Color: 'Red' }, stock_quantity: 5, is_active: true },
      { id: 'v2', options: { Size: 'S', Color: 'Blue' }, stock_quantity: 0, is_active: true }, // OOS
      { id: 'v3', options: { Size: 'L', Color: 'Blue' }, stock_quantity: 3, is_active: true },
    ];
    const ctx = mockFlowContext({
      current_product_id: 'prod-1',
      current_product_name: 'T-Shirt',
      current_product_variant_options: [
        { name: 'Size', values: ['S', 'L'] },
        { name: 'Color', values: ['Red', 'Blue'] },
      ],
      current_option_axis_index: 1, // Color axis
      current_selected_options: { Size: 'S' }, // Already chose S
    }, variantRows);

    const messages = await selectOptionAxis.prompt(ctx);
    const listMsg = messages.find((m: any) => m.type === 'list');
    expect(listMsg).toBeDefined();
    const titles = listMsg.items.map((item: any) => item.title);
    // Size=S: only Red is in-stock (Blue is OOS for Size=S)
    expect(titles).toContain('Red');
    expect(titles).not.toContain('Blue');
  });
});

// ═══ Part E: Smart-intent wiring ═══

describe('Smart-intent wiring uses classifySmartIntentMatch', () => {
  const botSource = readFileSync(join(process.cwd(), 'lib/bot/bot.service.ts'), 'utf-8');
  const capSource = readFileSync(join(process.cwd(), 'lib/bot/flows/capability-selection.flow.ts'), 'utf-8');

  it('bot.service imports classifySmartIntentMatch', () => {
    expect(botSource).toContain('classifySmartIntentMatch');
    expect(botSource).toContain("case 'auto_add'");
    expect(botSource).toContain("case 'variant_picker'");
    expect(botSource).toContain("case 'narrow_catalog'");
  });

  it('bot.service clears stale flags for variant_picker', () => {
    const vpSection = botSource.slice(botSource.indexOf("case 'variant_picker'"), botSource.indexOf("case 'narrow_catalog'"));
    expect(vpSection).toContain('delete session.session_data._auto_added_to_cart');
    expect(vpSection).toContain('delete session.session_data._skip_browse');
  });

  it('capability-selection imports classifySmartIntentMatch', () => {
    expect(capSource).toContain('classifySmartIntentMatch');
    expect(capSource).toContain("case 'auto_add'");
    expect(capSource).toContain("case 'variant_picker'");
  });

  it('capability-selection clears stale flags for variant_picker', () => {
    const vpSection = capSource.slice(capSource.indexOf("case 'variant_picker'"), capSource.indexOf("case 'narrow_catalog'"));
    expect(vpSection).toContain('delete ctx.session.session_data._auto_added_to_cart');
    expect(vpSection).toContain('delete ctx.session.session_data._skip_browse');
  });
});

// ═══ Part F: Structural supplemental ═══

describe('Structural supplemental', () => {
  const orderingSource = readFileSync(join(process.cwd(), 'lib/bot/flows/ordering.flow.ts'), 'utf-8');

  it('imports shared helpers', () => {
    expect(orderingSource).toContain("from './shared/product-availability'");
  });

  it('uses computeVariantAvailability', () => {
    expect(orderingSource).toContain('computeVariantAvailability(');
  });

  it('variant validator binds product_id + is_active', () => {
    expect(orderingSource).toContain(".eq('product_id', d.current_product_id as string)");
  });

  it('cancel uses ctx.t() for message', () => {
    expect(orderingSource).toContain("await ctx.t('Order cancelled.");
  });
});
