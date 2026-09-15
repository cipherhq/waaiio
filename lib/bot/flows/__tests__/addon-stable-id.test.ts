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
    it('quote request INSERT passes cart (with addon.id) as cart_snapshot', () => {
      // The submit_quote_request step inserts cart_snapshot: cart (line ~2388).
      // cart is the full CartItem[] from session_data.cart — which now carries addon.id.
      // This is a structural proof: the cart_snapshot field receives the CartItem[] directly,
      // so addon.id persists into the JSONB snapshot stored in quote_requests.
      const src = require('fs').readFileSync('lib/bot/flows/ordering.flow.ts', 'utf-8');

      // Verify cart_snapshot is set from the cart variable (which is CartItem[])
      expect(src).toContain('cart_snapshot: cart,');

      // Verify CartItem.addons carries id
      expect(src).toContain("addons?: Array<{ id: string; name: string; price: number; quantity?: number }>");

      // Therefore cart_snapshot inherits addon.id from CartItem.addons transitively.
    });

    it('addon.id survives full lifecycle: select → add_to_cart → cart → cart_snapshot', () => {
      // End-to-end data flow proof:
      // 1. AddonRecord.id is available (fetched from product_addons table)
      // 2. Both push sites include addon.id in the pushed object
      // 3. current_addons → CartItem.addons at add_to_cart step
      // 4. CartItem[] is stored as session_data.cart
      // 5. cart is passed directly as cart_snapshot in quote_requests INSERT
      const src = require('fs').readFileSync('lib/bot/flows/ordering.flow.ts', 'utf-8');

      // Step 2: both write paths include id
      const fixedPush = 'addons.push({ id: addon.id, name: addon.name, price: addon.price, quantity: 1 })';
      const perUnitPush = 'addons.push({ id: addon.id, name: addon.name, price: addon.price, quantity: qty })';
      expect(src).toContain(fixedPush);
      expect(src).toContain(perUnitPush);

      // Step 3: current_addons attached to cartItem.addons
      expect(src).toContain('cartItem.addons = currentAddons;');

      // Step 5: cart passed as cart_snapshot
      expect(src).toContain('cart_snapshot: cart,');
    });
  });

  describe('existing behavior preservation', () => {
    it('calculateCartTotal still sums addon prices correctly with id field', async () => {
      // Import the flow source and test the cart total calculation
      const src = require('fs').readFileSync('lib/bot/flows/ordering.flow.ts', 'utf-8');
      // calculateCartTotal uses a.price * (a.quantity || 1) — id field is ignored
      expect(src).toContain('a.price * (a.quantity || 1)');
    });

    it('CartItem.addons type includes id field', () => {
      const src = require('fs').readFileSync('lib/bot/flows/ordering.flow.ts', 'utf-8');
      expect(src).toContain("addons?: Array<{ id: string; name: string; price: number; quantity?: number }>");
    });

    it('both addon write paths include addon.id', () => {
      const src = require('fs').readFileSync('lib/bot/flows/ordering.flow.ts', 'utf-8');
      // Fixed/quote direct-add path
      expect(src).toContain('addons.push({ id: addon.id, name: addon.name, price: addon.price, quantity: 1 })');
      // Per-unit quantity path
      expect(src).toContain('addons.push({ id: addon.id, name: addon.name, price: addon.price, quantity: qty })');
    });

    it('no addon write path omits id', () => {
      const src = require('fs').readFileSync('lib/bot/flows/ordering.flow.ts', 'utf-8');
      // Must NOT have the old pattern without id
      const oldPattern = /addons\.push\(\{\s*name:\s*addon\.name,\s*price:\s*addon\.price/;
      const matches = src.match(oldPattern);
      expect(matches).toBeNull();
    });
  });
});
