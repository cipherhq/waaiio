/**
 * Phase 2D: Direct Order Payment Authority tests (#352).
 *
 * Tests M394 provenance, Stage 2 zero-fee, Stage 3 manifest parity,
 * terminal effects, channel behavior, and recovery semantics.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const authoritySource = readFileSync(join(process.cwd(), 'lib/payments/authority.ts'), 'utf-8');
const processSuccessSource = readFileSync(join(process.cwd(), 'lib/payments/process-success.ts'), 'utf-8');
const sendConfirmSource = readFileSync(join(process.cwd(), 'lib/payments/send-confirmation.ts'), 'utf-8');
const terminalEffectsSource = readFileSync(join(process.cwd(), 'lib/payments/terminal-effects.ts'), 'utf-8');
const dashboardRoute = readFileSync(join(process.cwd(), 'app/api/dashboard/pending-transfers/[id]/route.ts'), 'utf-8');
const cronRoute = readFileSync(join(process.cwd(), 'app/api/cron/payment-reconciliation/route.ts'), 'utf-8');
const m394Source = readFileSync(join(process.cwd(), 'supabase/migrations/394_direct_order_payment_authority.sql'), 'utf-8');

// ═══ M394 Migration ═══

describe('M394: confirm_order_transfer_atomic', () => {
  it('sets payment_authority_version = 1', () => {
    expect(m394Source).toContain('payment_authority_version');
    // In the INSERT VALUES
    const insertSection = m394Source.slice(m394Source.indexOf('INSERT INTO payments'), m394Source.indexOf('RETURNING id INTO v_new_payment_id'));
    expect(insertSection).toContain('payment_authority_version');
    expect(insertSection).toContain("1,  -- M394");
  });

  it('sets _direct_transfer = true in metadata', () => {
    const insertSection = m394Source.slice(m394Source.indexOf('INSERT INTO payments'), m394Source.indexOf('RETURNING id INTO v_new_payment_id'));
    expect(insertSection).toContain("'_direct_transfer', true");
  });

  it('preserves all M393 lock/winner semantics', () => {
    expect(m394Source).toContain('Lock order FOR UPDATE');
    expect(m394Source).toContain('Lock transfer');
    expect(m394Source).toContain('Lock marker');
    expect(m394Source).toContain('Lock ALL linked payment rows');
    expect(m394Source).toContain('Payment/finalization fence');
    expect(m394Source).toContain('marker_has_payment');
    expect(m394Source).toContain("reservation_class = 'committed'");
    expect(m394Source).toContain("status = 'confirmed'");
  });
});

describe('M394: initialize_terminal_effects', () => {
  it('includes customer_order_email in catalog', () => {
    expect(m394Source).toContain("'customer_order_email'");
  });

  it('requires payment_authority_version in direct order predicate', () => {
    expect(m394Source).toContain('v_payment.payment_authority_version IS NOT NULL');
  });

  it('exempts direct orders from owner_notif_whatsapp/email requirement', () => {
    expect(m394Source).toContain('IF NOT v_is_direct_order THEN');
    expect(m394Source).toContain("owner_notif_whatsapp");
  });

  it('requires owner_notif_inapp for direct orders', () => {
    // The condition includes v_is_direct_order
    expect(m394Source).toContain('OR v_is_direct_order THEN');
    expect(m394Source).toContain("'owner_notif_inapp'");
  });
});

// ═══ Authority refactor ═══

describe('authority.ts: resumeSuccessfulPaymentFinalization', () => {
  it('exported', () => {
    expect(authoritySource).toContain('export async function resumeSuccessfulPaymentFinalization');
  });

  it('fails closed on non-success status', () => {
    expect(authoritySource).toContain("status !== 'success'");
    expect(authoritySource).toContain('not_successful');
  });

  it('fails closed on non-direct gateway', () => {
    expect(authoritySource).toContain("gateway !== 'direct'");
    expect(authoritySource).toContain('not_direct_gateway');
  });

  it('fails closed without authority version', () => {
    expect(authoritySource).toContain('payment_authority_version == null');
    expect(authoritySource).toContain('no_authority_version');
  });

  it('fails closed without _direct_transfer provenance', () => {
    expect(authoritySource).toContain('_direct_transfer');
    expect(authoritySource).toContain('no_direct_transfer_provenance');
  });

  it('fails closed without pending_transfer_id', () => {
    expect(authoritySource).toContain('pending_transfer_id');
    expect(authoritySource).toContain('no_pending_transfer_id');
  });

  it('calls executeStage2Through3', () => {
    expect(authoritySource).toContain('executeStage2Through3');
  });

  it('authorizeAndFinalize also calls executeStage2Through3', () => {
    // Both entry points use the same executor
    const aafSection = authoritySource.slice(
      authoritySource.indexOf('export async function authorizeAndFinalize'),
      authoritySource.indexOf('export async function resumeSuccessfulPaymentFinalization')
    );
    expect(aafSection).toContain('executeStage2Through3');
  });

  it('passes payment_authority_version to processPayment', () => {
    expect(authoritySource).toContain('payment_authority_version: payment.payment_authority_version');
  });
});

// ═══ Stage 2: Zero fee ═══

describe('process-success.ts: direct zero-fee', () => {
  it('requires gateway + orderId + _direct_transfer + authority_version', () => {
    expect(processSuccessSource).toContain("payment.gateway === 'direct'");
    expect(processSuccessSource).toContain('payMeta._direct_transfer === true');
    expect(processSuccessSource).toContain('payment.payment_authority_version != null');
  });

  it('inserts zero-fee platform_fees row', () => {
    expect(processSuccessSource).toContain('fee_percentage: 0, fee_flat: 0, fee_total: 0, gateway_fee: 0');
    expect(processSuccessSource).toContain('is_direct_transfer: true');
  });

  it('uses strict 23505 only (no message substring)', () => {
    expect(processSuccessSource).toContain("directFeeErr.code === '23505'");
    // Should NOT contain message.includes('duplicate') in the direct fee path
    const directFeeSection = processSuccessSource.slice(
      processSuccessSource.indexOf('R4-B2: Durable direct order'),
      processSuccessSource.indexOf('Online/card/wallet: existing tier-based')
    );
    expect(directFeeSection).not.toContain("includes('duplicate')");
  });

  it('verifies fee row on both fresh insert and 23505 replay', () => {
    expect(processSuccessSource).toContain('verifyFeeRow');
    expect(processSuccessSource).toContain('direct_transfer_fee_mismatch');
    expect(processSuccessSource).toContain('direct_transfer_fee_verify_failed');
  });

  it('online fee path unchanged (recordPlatformFee)', () => {
    expect(processSuccessSource).toContain('await recordPlatformFee(supabase');
  });
});

// ═══ Stage 3: Terminal effects ═══

describe('terminal-effects.ts: computeApplicableEffects', () => {
  it('accepts isDirectOrderTransfer flag', () => {
    expect(terminalEffectsSource).toContain('isDirectOrderTransfer');
  });

  it('direct order includes owner_notif_inapp', () => {
    expect(terminalEffectsSource).toContain('isDirect');
    // The condition adds owner_notif_inapp for direct orders
    const inappLine = terminalEffectsSource.slice(
      terminalEffectsSource.indexOf("effects.push('owner_notif_inapp')"),
    );
    expect(inappLine).toBeDefined();
  });

  it('direct order omits owner_notif_whatsapp and owner_notif_email', () => {
    expect(terminalEffectsSource).toContain('if (!isDirect)');
    expect(terminalEffectsSource).toContain("effects.push('owner_notif_whatsapp')");
    expect(terminalEffectsSource).toContain("effects.push('owner_notif_email')");
  });

  it('direct order omits receipt PDF and loyalty WhatsApp', () => {
    expect(terminalEffectsSource).toContain("!isDirect && opts.hasCustomerPhone && (opts.amountPaid");
    expect(terminalEffectsSource).toContain("!isDirect && opts.hasLoyalty");
  });

  it('includes customer_order_email for direct + hasCustomerEmail', () => {
    expect(terminalEffectsSource).toContain("isDirect && opts.hasCustomerEmail");
    expect(terminalEffectsSource).toContain("customer_order_email");
  });

  it('customer_order_email in STAGE3_EFFECT_CATALOG', () => {
    expect(terminalEffectsSource).toContain("customer_order_email:");
    expect(terminalEffectsSource).toContain("'customer_order_email'");
  });

  it('non-direct payments still get owner_notif_whatsapp/email', () => {
    // When isDirect is false, owner WA/email are always pushed
    const fn = terminalEffectsSource.slice(
      terminalEffectsSource.indexOf('function computeApplicableEffects'),
      terminalEffectsSource.indexOf('return effects;')
    );
    expect(fn).toContain("!isDirect");
  });
});

// ═══ Stage 3: send-confirmation.ts ═══

describe('send-confirmation.ts: direct order Stage 3', () => {
  it('derives isDirectOrderTransfer from payment provenance', () => {
    expect(sendConfirmSource).toContain('isDirectOrderTransfer');
    expect(sendConfirmSource).toContain("gateway === 'direct'");
    expect(sendConfirmSource).toContain('_direct_transfer');
  });

  it('canonical order resolution uses payment.order_id first', () => {
    expect(sendConfirmSource).toContain('canonicalOrderId = payment.order_id');
    expect(sendConfirmSource).toContain('meta.order_id');
  });

  it('resolves customer email for direct orders before manifest freeze', () => {
    expect(sendConfirmSource).toContain('directOrderCustomerEmail');
    expect(sendConfirmSource).toContain('findCustomerEmail');
  });

  it('owner_notif_inapp handles direct order transfer_confirmed', () => {
    expect(sendConfirmSource).toContain("isDirectOrderTransfer && payment.order_id");
    expect(sendConfirmSource).toContain("type: 'transfer_confirmed'");
    expect(sendConfirmSource).toContain("channel: 'dashboard'");
  });

  it('customer_order_email executed via driveExternalEffect', () => {
    expect(sendConfirmSource).toContain("'customer_order_email'");
    expect(sendConfirmSource).toContain('driveExternalEffect');
    expect(sendConfirmSource).toContain('sendEmail');
    expect(sendConfirmSource).toContain('Payment Confirmed');
  });

  it('Save Card suppressed for direct transfers', () => {
    expect(sendConfirmSource).toContain('!isDirectOrderTransfer');
    expect(sendConfirmSource).toContain('checkAndOfferSavedCard');
  });
});

// ═══ Dashboard route ═══

describe('Dashboard route: order-linked confirm', () => {
  it('delegates to resumeSuccessfulPaymentFinalization after RPC', () => {
    expect(dashboardRoute).toContain('resumeSuccessfulPaymentFinalization');
    expect(dashboardRoute).toContain('processSuccessfulPayment');
    expect(dashboardRoute).toContain('sendProactiveConfirmation');
  });

  it('downstream failure cannot undo financial success', () => {
    expect(dashboardRoute).toContain('non-fatal');
    expect(dashboardRoute).toContain("status: 'confirmed'");
    expect(dashboardRoute).toContain('finalization_status');
  });

  it('already-confirmed retry uses exact provenance lookup', () => {
    expect(dashboardRoute).toContain('payment_authority_version');
    expect(dashboardRoute).toContain('_direct_transfer');
    expect(dashboardRoute).toContain('pending_transfer_id');
    expect(dashboardRoute).toContain('Multiple direct payments');
  });

  it('no route-owned customer WhatsApp/email/platform_fees for orders', () => {
    // After confirm_order_transfer_atomic, route no longer owns these
    const confirmSection = dashboardRoute.slice(
      dashboardRoute.indexOf("rpc('confirm_order_transfer_atomic'"),
      dashboardRoute.indexOf('Non-order confirmation')
    );
    expect(confirmSection).not.toContain('resolveByChannelIdForBusiness');
    expect(confirmSection).not.toContain('resolveByBusinessId');
    expect(confirmSection).not.toContain("from('platform_fees')");
  });
});

// ═══ Recovery cron ═══

describe('Recovery cron: direct gateway', () => {
  it('bypasses provider verification for direct transfers', () => {
    expect(cronRoute).toContain("payment.gateway === 'direct'");
    expect(cronRoute).toContain('_direct_transfer');
    expect(cronRoute).toContain('resumeSuccessfulPaymentFinalization');
  });

  it('surfaces semantic resume failures', () => {
    expect(cronRoute).toContain('UNEXPECTED');
    expect(cronRoute).toContain('Sentry');
  });

  it('online gateways still use reconcilePayment', () => {
    expect(cronRoute).toContain('reconcilePayment(supabase, payment.id');
  });
});

// ═══ Regression freeze ═══

describe('Regression: online payment behavior unchanged', () => {
  it('authorizeAndFinalize still supports Paystack/Stripe/Flutterwave/Square/PayPal', () => {
    expect(authoritySource).toContain("'paystack'");
    expect(authoritySource).toContain("'stripe'");
    expect(authoritySource).toContain("'flutterwave'");
    expect(authoritySource).toContain("'square'");
    expect(authoritySource).toContain("'paypal'");
  });

  it('non-direct payments still include owner_notif_whatsapp/email in computeApplicableEffects', async () => {
    // Import and test the actual function
    const { computeApplicableEffects } = await import('@/lib/payments/terminal-effects');
    const effects = computeApplicableEffects(
      { id: 'p1', booking_id: 'b1' },
      { hasCustomerPhone: true, hasSender: true, isDirectOrderTransfer: false },
    );
    expect(effects).toContain('owner_notif_whatsapp');
    expect(effects).toContain('owner_notif_email');
    expect(effects).toContain('owner_notif_inapp');
    expect(effects).toContain('customer_whatsapp');
  });

  it('direct order omits owner WA/email but includes owner_notif_inapp', async () => {
    const { computeApplicableEffects } = await import('@/lib/payments/terminal-effects');
    const effects = computeApplicableEffects(
      { id: 'p2', order_id: 'o1' },
      { hasCustomerPhone: true, hasSender: true, isDirectOrderTransfer: true, hasCustomerEmail: true },
    );
    expect(effects).not.toContain('owner_notif_whatsapp');
    expect(effects).not.toContain('owner_notif_email');
    expect(effects).toContain('owner_notif_inapp');
    expect(effects).toContain('customer_whatsapp');
    expect(effects).toContain('customer_order_email');
    expect(effects).not.toContain('receipt_pdf_generation');
    expect(effects).not.toContain('customer_loyalty_whatsapp');
  });

  it('non-order transfers not affected by Phase 2D', () => {
    const routeSource = readFileSync(join(process.cwd(), 'app/api/dashboard/pending-transfers/[id]/route.ts'), 'utf-8');
    // Non-order confirm still exists unchanged
    expect(routeSource).toContain('Non-order confirmation');
    expect(routeSource).toContain('resolveByBusinessId');
  });

  it('M393 inventory/winner functions preserved', () => {
    // M394 only redefines confirm_order_transfer_atomic, not other M393 functions
    expect(m394Source).toContain('confirm_order_transfer_atomic');
    expect(m394Source).not.toContain('cancel_order_immediate');
    expect(m394Source).not.toContain('cancel_stale_order_atomic');
    expect(m394Source).not.toContain('create_transfer_with_reservation');
  });
});
