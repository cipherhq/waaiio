/**
 * Stage 1 — Stable addon.id writer bridge tests.
 *
 * Proves that the CartItem addon shape now carries stable `id` from
 * product_addons through both write paths (fixed/quote direct-add
 * and per-unit quantity), and that the ID survives into cart state
 * and quote_requests cart_snapshot.
 */
import { describe, it, expect, vi } from 'vitest';
import { createMockContext, getStep } from './helpers';
import { orderingFlow } from '../ordering.flow';

// ── Helpers ──

const ADDON_FIXED: Record<string, unknown> = {
  id: 'addon-uuid-fixed-001',
  name: 'Gift Wrap',
  price: 500,
  price_type: 'fixed',
  unit_label: null,
  min_quantity: null,
  max_quantity: null,
  is_required: false,
  is_negotiable: false,
};

const ADDON_PER_UNIT: Record<string, unknown> = {
  id: 'addon-uuid-perunit-002',
  name: 'Extra Topping',
  price: 200,
  price_type: 'per_unit',
  unit_label: 'per piece',
  min_quantity: 1,
  max_quantity: 10,
  is_required: false,
  is_negotiable: false,
};

const ADDON_QUOTE: Record<string, unknown> = {
  id: 'addon-uuid-quote-003',
  name: 'Custom Engraving',
  price: 0,
  price_type: 'quote',
  unit_label: null,
  min_quantity: null,
  max_quantity: null,
  is_required: false,
  is_negotiable: true,
};

describe('Stable addon.id writer bridge', () => {
  describe('select_addons step — fixed/quote direct-add path', () => {
    const step = getStep(orderingFlow, 'select_addons');

    it('fixed addon: id persists into current_addons', async () => {
      const ctx = createMockContext({
        session: {
          id: 'sess-1', user_id: null, business_id: 'biz-1',
          current_step: 'select_addons', session_data: {
            current_product_id: 'prod-1',
            _selected_addon: ADDON_FIXED,
            _addon_action: 'selected',
          }, version: 1,
        },
      });

      // next() adds the fixed addon directly (no quantity step)
      const nextStep = await step.next!(ctx);
      const addons = ctx.session.session_data.current_addons as Array<Record<string, unknown>>;

      expect(nextStep).toBe('addon_continue');
      expect(addons).toHaveLength(1);
      expect(addons[0].id).toBe('addon-uuid-fixed-001');
      expect(addons[0].name).toBe('Gift Wrap');
      expect(addons[0].price).toBe(500);
      expect(addons[0].quantity).toBe(1);
    });

    it('quote addon: id persists into current_addons', async () => {
      const ctx = createMockContext({
        session: {
          id: 'sess-2', user_id: null, business_id: 'biz-1',
          current_step: 'select_addons', session_data: {
            current_product_id: 'prod-1',
            _selected_addon: ADDON_QUOTE,
            _addon_action: 'selected',
          }, version: 1,
        },
      });

      const nextStep = await step.next!(ctx);
      const addons = ctx.session.session_data.current_addons as Array<Record<string, unknown>>;

      expect(nextStep).toBe('addon_continue');
      expect(addons).toHaveLength(1);
      expect(addons[0].id).toBe('addon-uuid-quote-003');
      expect(addons[0].name).toBe('Custom Engraving');
      expect(addons[0].price).toBe(0);
      expect(addons[0].quantity).toBe(1);
    });
  });

  describe('select_addon_quantity step — per-unit quantity path', () => {
    const step = getStep(orderingFlow, 'select_addon_quantity');

    it('per-unit addon: id persists with selected quantity', async () => {
      const ctx = createMockContext({
        session: {
          id: 'sess-3', user_id: null, business_id: 'biz-1',
          current_step: 'select_addon_quantity', session_data: {
            current_product_id: 'prod-1',
            _selected_addon: ADDON_PER_UNIT,
            current_addons: [],
          }, version: 1,
        },
      });

      const result = await step.validate!('3', ctx);
      const addons = ctx.session.session_data.current_addons as Array<Record<string, unknown>>;

      expect(result.valid).toBe(true);
      expect(addons).toHaveLength(1);
      expect(addons[0].id).toBe('addon-uuid-perunit-002');
      expect(addons[0].name).toBe('Extra Topping');
      expect(addons[0].price).toBe(200);
      expect(addons[0].quantity).toBe(3);
    });
  });

  describe('add_to_cart step — addon.id survives into CartItem', () => {
    const step = getStep(orderingFlow, 'add_to_cart');

    it('cart item carries addon.id from current_addons', async () => {
      const ctx = createMockContext({
        session: {
          id: 'sess-4', user_id: null, business_id: 'biz-1',
          current_step: 'add_to_cart', session_data: {
            current_product_id: 'prod-1',
            current_product_name: 'Widget',
            current_quantity: 2,
            current_product_price: 1000,
            cart: [],
            current_addons: [
              { id: 'addon-uuid-fixed-001', name: 'Gift Wrap', price: 500, quantity: 1 },
              { id: 'addon-uuid-perunit-002', name: 'Extra Topping', price: 200, quantity: 3 },
            ],
          }, version: 1,
        },
      });

      // add_to_cart prompt creates the cart item
      await step.prompt!(ctx);
      const cart = ctx.session.session_data.cart as Array<Record<string, unknown>>;

      expect(cart).toHaveLength(1);
      const item = cart[0];
      expect(item.product_id).toBe('prod-1');
      expect(item.name).toBe('Widget');

      const itemAddons = item.addons as Array<Record<string, unknown>>;
      expect(itemAddons).toHaveLength(2);
      expect(itemAddons[0].id).toBe('addon-uuid-fixed-001');
      expect(itemAddons[0].name).toBe('Gift Wrap');
      expect(itemAddons[0].price).toBe(500);
      expect(itemAddons[1].id).toBe('addon-uuid-perunit-002');
      expect(itemAddons[1].name).toBe('Extra Topping');
      expect(itemAddons[1].price).toBe(200);
      expect(itemAddons[1].quantity).toBe(3);
    });
  });

  describe('submit_quote_request step — addon.id flows into cart_snapshot', () => {
    it('executes real submit_quote_request and captures cart_snapshot with addon.id', async () => {
      const step = getStep(orderingFlow, 'submit_quote_request');

      const cart = [
        {
          product_id: 'prod-1',
          name: 'Widget',
          quantity: 2,
          price: 1000,
          addons: [
            { id: 'addon-uuid-fixed-001', name: 'Gift Wrap', price: 500, quantity: 1 },
            { id: 'addon-uuid-perunit-002', name: 'Extra Topping', price: 200, quantity: 3 },
          ],
        },
        {
          product_id: 'prod-2',
          name: 'Gadget',
          quantity: 1,
          price: 3000,
        },
      ];

      // Capture the payload passed to quote_requests INSERT
      let capturedPayload: Record<string, unknown> | null = null;

      // Build a mock supabase that:
      // 1. Passes the capability guard (businesses SELECT returns active business)
      // 2. Captures the quote_requests INSERT payload
      // 3. Handles bot_sessions UPDATE and other incidental reads
      const mockSupabase = {
        from: vi.fn((table: string) => {
          if (table === 'businesses') {
            // Capability guard reads business state
            return {
              select: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  single: vi.fn().mockResolvedValue({
                    data: { id: 'biz-1', status: 'active', subscription_tier: 'growth', trial_ends_at: null, category: 'retail' },
                    error: null,
                  }),
                }),
              }),
            };
          }
          if (table === 'business_capabilities') {
            // getConfiguredCapabilities reads from business_capabilities
            const eqFn = vi.fn().mockReturnValue({
              order: vi.fn().mockReturnValue({
                order: vi.fn().mockResolvedValue({
                  data: [{ capability: 'ordering', is_enabled: true, sort_order: 0 }],
                  error: null,
                }),
              }),
            });
            return { select: vi.fn().mockReturnValue({ eq: eqFn }) };
          }
          if (table === 'capability_overrides') {
            return {
              select: vi.fn().mockReturnValue({
                eq: vi.fn().mockResolvedValue({ data: [], error: null }),
              }),
            };
          }
          if (table === 'subscription_transactions') {
            // resolveTrialCredit reads subscription_transactions
            return {
              select: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  eq: vi.fn().mockReturnValue({
                    maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
                  }),
                }),
              }),
            };
          }
          if (table === 'quote_requests') {
            return {
              insert: vi.fn((payload: Record<string, unknown>) => {
                capturedPayload = payload;
                return {
                  select: vi.fn().mockReturnValue({
                    single: vi.fn().mockResolvedValue({
                      data: { id: 'quote-id-captured' },
                      error: null,
                    }),
                  }),
                };
              }),
            };
          }
          // Default: chainable no-op for bot_sessions, profiles, etc.
          const chain: Record<string, any> = {};
          for (const m of ['select', 'insert', 'update', 'delete', 'eq', 'neq', 'or', 'in', 'is', 'not', 'gte', 'lte', 'order', 'limit']) {
            chain[m] = vi.fn().mockReturnValue(chain);
          }
          chain.single = vi.fn().mockResolvedValue({ data: null, error: null });
          chain.maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
          return chain;
        }),
        rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
      };

      const ctx = createMockContext({
        supabase: mockSupabase as any,
        session: {
          id: 'sess-quote', user_id: 'user-1', business_id: 'biz-1',
          current_step: 'submit_quote_request', session_data: {
            cart,
            active_capability: 'ordering',
            capabilities: ['ordering'],
            first_name: 'John',
            last_name: 'Doe',
          }, version: 1,
        },
        business: {
          id: 'biz-1', name: 'Test Shop', slug: 'test-shop',
          category: 'retail' as any, flow_type: 'ordering' as any,
          subscription_tier: 'growth', trial_ends_at: null,
          metadata: {},
        },
      });

      await step.prompt!(ctx);

      // ── Primary assertion: executable proof that cart_snapshot carries addon.id ──
      expect(capturedPayload).not.toBeNull();

      const snapshot = capturedPayload!.cart_snapshot as Array<Record<string, unknown>>;
      expect(snapshot).toHaveLength(2);

      // Item 1: Widget with two addons carrying stable IDs
      const item1 = snapshot[0];
      expect(item1.product_id).toBe('prod-1');
      expect(item1.name).toBe('Widget');
      expect(item1.quantity).toBe(2);
      expect(item1.price).toBe(1000);

      const item1Addons = item1.addons as Array<Record<string, unknown>>;
      expect(item1Addons).toHaveLength(2);

      expect(item1Addons[0].id).toBe('addon-uuid-fixed-001');
      expect(item1Addons[0].name).toBe('Gift Wrap');
      expect(item1Addons[0].price).toBe(500);
      expect(item1Addons[0].quantity).toBe(1);

      expect(item1Addons[1].id).toBe('addon-uuid-perunit-002');
      expect(item1Addons[1].name).toBe('Extra Topping');
      expect(item1Addons[1].price).toBe(200);
      expect(item1Addons[1].quantity).toBe(3);

      // Item 2: Gadget with no addons
      const item2 = snapshot[1];
      expect(item2.product_id).toBe('prod-2');
      expect(item2.name).toBe('Gadget');
      expect(item2.quantity).toBe(1);
      expect(item2.price).toBe(3000);
      expect(item2.addons).toBeUndefined();

      // Verify other quote fields are present
      expect(capturedPayload!.business_id).toBe('biz-1');
      expect(capturedPayload!.status).toBe('pending');
      expect(capturedPayload!.channel).toBe('whatsapp');
    });

    // Secondary structural guard — source-level regression check
    it('[structural guard] cart_snapshot is assigned from cart variable', () => {
      const src = require('fs').readFileSync('lib/bot/flows/ordering.flow.ts', 'utf-8');
      expect(src).toContain('cart_snapshot: cart,');
    });
  });

  describe('existing behavior preservation', () => {
    it('[structural guard] calculateCartTotal still sums addon prices correctly with id field', () => {
      const src = require('fs').readFileSync('lib/bot/flows/ordering.flow.ts', 'utf-8');
      expect(src).toContain('a.price * (a.quantity || 1)');
    });

    it('[structural guard] CartItem.addons type includes id field', () => {
      const src = require('fs').readFileSync('lib/bot/flows/ordering.flow.ts', 'utf-8');
      expect(src).toContain("addons?: Array<{ id: string; name: string; price: number; quantity?: number }>");
    });

    it('[structural guard] both addon write paths include addon.id', () => {
      const src = require('fs').readFileSync('lib/bot/flows/ordering.flow.ts', 'utf-8');
      expect(src).toContain('addons.push({ id: addon.id, name: addon.name, price: addon.price, quantity: 1 })');
      expect(src).toContain('addons.push({ id: addon.id, name: addon.name, price: addon.price, quantity: qty })');
    });

    it('[structural guard] no addon write path omits id', () => {
      const src = require('fs').readFileSync('lib/bot/flows/ordering.flow.ts', 'utf-8');
      const oldPattern = /addons\.push\(\{\s*name:\s*addon\.name,\s*price:\s*addon\.price/;
      expect(src.match(oldPattern)).toBeNull();
    });
  });
});
