import { AsyncLocalStorage } from 'node:async_hooks';
import type { FlowContext } from '@/lib/bot/flows/types';

// Forward-only ordering edges. Back/edit/browse/self transitions never qualify.
const EDGES: Readonly<Record<string, readonly string[]>> = {
  continue_or_checkout: ['apply_promo'],
  apply_promo: ['enter_promo_code', 'select_delivery_zone', 'collect_pickup_address'],
  enter_promo_code: ['select_delivery_zone', 'collect_pickup_address'],
  select_delivery_zone: ['delivery_details', 'collect_address', 'collect_name'],
  delivery_details: ['collect_address', 'collect_name'],
  collect_pickup_address: ['collect_dropoff_address'],
  collect_dropoff_address: ['collect_package_description'],
  collect_package_description: ['collect_package_photo'],
  collect_package_photo: ['collect_name'],
  collect_address: ['confirm_address'],
  confirm_address: ['collect_name'],
  collect_name: ['ask_referral_code'],
  ask_referral_code: ['enter_referral_code', 'collect_email'],
  enter_referral_code: ['collect_email'],
  collect_email: ['review_order_summary'],
  review_order_summary: ['process_order'],
};

function validCart(ctx: FlowContext): boolean {
  const cart = ctx.session.session_data.cart;
  return Array.isArray(cart) && cart.length > 0 && cart.every(item =>
    item && typeof item.product_id === 'string' && item.product_id.length > 0
    && Number.isSafeInteger(item.quantity) && item.quantity > 0
    && typeof item.price === 'number' && Number.isFinite(item.price) && item.price >= 0);
}

export interface CheckoutProgress {
  readonly businessId: string;
  readonly phone: string;
  readonly sessionId: string;
  readonly db: FlowContext['supabase'];
  readonly ctx: FlowContext;
  readonly visited: ReadonlySet<string>;
}

/** Called only after successful validation and its CAS; no allowance exists yet. */
export function checkoutProgress(ctx: FlowContext, source: string, target: string, resultData?: Record<string, unknown>): CheckoutProgress | undefined {
  if (!ctx.business || ctx.business.id !== ctx.session.business_id || !ctx.session.id
    || ctx.session.session_data.active_capability !== 'ordering' || !validCart(ctx)
    || !EDGES[source]?.includes(target)) return;
  if (source === 'continue_or_checkout' && resultData?._action !== 'checkout') return;
  if (source === 'confirm_address' && resultData?.address_confirmed !== true) return;
  if (source === 'review_order_summary' && resultData?._order_action !== 'confirm') return;
  return Object.freeze({ businessId: ctx.business.id, phone: ctx.from.replace(/\D/g, ''), sessionId: ctx.session.id,
    db: ctx.supabase, ctx, visited: new Set([source, target]) });
}

export function forwardCheckoutProgress(progress: CheckoutProgress | undefined, source: string, target: string): CheckoutProgress | undefined {
  if (!progress || !EDGES[source]?.includes(target) || progress.visited.has(target)) return;
  return Object.freeze({ ...progress, visited: new Set([...progress.visited, target]) });
}

const replies = new AsyncLocalStorage<{ readonly progress: CheckoutProgress; active: boolean }>();

/** Only wraps the response group after destination CAS. Never persisted or reused. */
export async function withCheckoutReply<T>(progress: CheckoutProgress | undefined, send: () => Promise<T>): Promise<T> {
  if (!progress) return send();
  const scope = { progress, active: true };
  return replies.run(scope, async () => {
    try { return await send(); } finally { scope.active = false; }
  });
}

export function hasCheckoutReply(db: unknown, businessId: string, phone: string, sessionId: string | undefined): boolean {
  const scope = replies.getStore();
  if (!scope?.active) return false;
  const p = scope.progress;
  return p.db === db && p.businessId === businessId && p.phone === phone.replace(/\D/g, '') && p.sessionId === sessionId
    && p.ctx.business?.id === businessId && p.ctx.session.business_id === businessId
    && p.ctx.session.id === sessionId && validCart(p.ctx);
}
