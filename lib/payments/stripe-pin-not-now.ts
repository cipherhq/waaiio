/**
 * Postback id prefix for the "Not now" reply button on the Stripe
 * provider-checkout PIN-activation prompt (#1065, Owner Option A).
 *
 * Kept in its own dependency-free module so the bot PIN handler, the bot
 * service stale-tap guard and the activation senders share one exact value.
 * The PIN-step handler maps a tap scoped to the live session's own Stripe
 * payment and business onto the existing typed `cancel`; any other tap is a no-op.
 */
export const STRIPE_PIN_NOT_NOW_PREFIX = 'stripe_pin_not_now:';
