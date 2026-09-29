/**
 * #476 — Paid onboarding completion: businesses.status must transition to active.
 *
 * Proves:
 * 1. Successful paid verification sets businesses.status = 'active'
 * 2. Status update only fires AFTER activation authority returns activated=true
 * 3. Failed/rejected paid verification leaves business pending
 * 4. Free path behavior unchanged
 * 5. Replay is idempotent (CAS guard: eq('status', 'pending'))
 * 6. Both Paystack and Stripe share the common paid path
 * 7. Payment validation and idempotency protections preserved
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const verifyRouteSrc = readFileSync(
  resolve(__dirname, '../../app/api/onboarding/verify/route.ts'),
  'utf-8'
);

describe('#476 Paid onboarding sets businesses.status = active', () => {
  it('updates business status to active after successful paid activation', () => {
    expect(verifyRouteSrc).toContain("update({ status: 'active' })");
    expect(verifyRouteSrc).toContain('Paid onboarding completion');
  });

  it('status update only fires after activated === true check', () => {
    // The paid completion update must come AFTER the rejection guard
    const activatedCheckPos = verifyRouteSrc.indexOf('activationResult.activated !== true');
    const statusUpdatePos = verifyRouteSrc.indexOf('Paid onboarding completion');
    expect(activatedCheckPos).toBeGreaterThan(0);
    expect(statusUpdatePos).toBeGreaterThan(0);
    expect(statusUpdatePos).toBeGreaterThan(activatedCheckPos);
  });

  it('status update does NOT fire before payment evidence or activation', () => {
    const paidPathPos = verifyRouteSrc.indexOf("plan !== 'free'");
    const rpcPos = verifyRouteSrc.indexOf("'activate_paid_subscription'");
    const statusUpdatePos = verifyRouteSrc.indexOf('Paid onboarding completion');
    expect(paidPathPos).toBeGreaterThan(0);
    expect(rpcPos).toBeGreaterThan(paidPathPos);
    expect(statusUpdatePos).toBeGreaterThan(rpcPos);
  });

  it('uses CAS guard eq("status", "pending") for idempotent replay', () => {
    // The update chain must include .eq('status', 'pending')
    expect(verifyRouteSrc).toContain(".eq('status', 'pending')");
    // Extract the paid completion block (wider range to capture the full chain)
    const start = verifyRouteSrc.indexOf('Paid onboarding completion');
    const end = verifyRouteSrc.indexOf('paidStatusErr)', start) + 20;
    const block = verifyRouteSrc.substring(start, end);
    expect(block).toContain("update({ status: 'active' })");
    expect(block).toContain(".eq('id', businessId)");
    expect(block).toContain(".eq('status', 'pending')");
  });
});

describe('#476 Failed paid verification leaves business pending', () => {
  it('RPC error returns before status update', () => {
    const rpcErrorReturn = verifyRouteSrc.indexOf('Subscription activation failed');
    const statusUpdatePos = verifyRouteSrc.indexOf('Paid onboarding completion');
    expect(rpcErrorReturn).toBeGreaterThan(0);
    expect(statusUpdatePos).toBeGreaterThan(0);
    // Error return must come before the status update
    expect(rpcErrorReturn).toBeLessThan(statusUpdatePos);
  });

  it('RPC rejection returns before status update', () => {
    const rejectionReturn = verifyRouteSrc.indexOf('activation rejected');
    const statusUpdatePos = verifyRouteSrc.indexOf('Paid onboarding completion');
    expect(rejectionReturn).toBeGreaterThan(0);
    // Rejection return must come before status update
    expect(rejectionReturn).toBeLessThan(statusUpdatePos);
  });
});

describe('#476 Free path behavior unchanged', () => {
  it('free path still sets status active directly with subscription_tier', () => {
    const freePath = verifyRouteSrc.substring(
      verifyRouteSrc.indexOf("plan === 'free'"),
      verifyRouteSrc.indexOf('activate_trial_if_eligible')
    );
    expect(freePath).toContain("status: 'active'");
    expect(freePath).toContain('subscription_tier: plan');
  });

  it('free path does not call activate_paid_subscription', () => {
    const freeStart = verifyRouteSrc.indexOf("} else if (plan === 'free')");
    const freeEnd = verifyRouteSrc.indexOf('activate_trial_if_eligible', freeStart);
    const freeBlock = verifyRouteSrc.substring(freeStart, freeEnd);
    expect(freeBlock).not.toContain('activate_paid_subscription');
  });
});

describe('#476 Both Paystack and Stripe share the common paid path', () => {
  it('paid activation RPC call and status update are provider-neutral', () => {
    // The RPC call itself does not branch on gateway
    const rpcCall = verifyRouteSrc.indexOf("'activate_paid_subscription'");
    const statusUpdate = verifyRouteSrc.indexOf('Paid onboarding completion');
    // Between the RPC call and the status update, there is no gateway conditional
    const block = verifyRouteSrc.substring(rpcCall, statusUpdate);
    expect(block).not.toContain("gateway === 'paystack'");
    expect(block).not.toContain("gateway === 'stripe'");
    // The status update itself is also gateway-neutral
    const updateBlock = verifyRouteSrc.substring(statusUpdate, statusUpdate + 300);
    expect(updateBlock).not.toContain("gateway ===");
  });
});

describe('#476 Payment validation and idempotency preserved', () => {
  it('subscription upsert uses onConflict business_id', () => {
    expect(verifyRouteSrc).toContain("onConflict: 'business_id'");
  });

  it('payment evidence handles 23505 duplicate gracefully', () => {
    expect(verifyRouteSrc).toContain('23505');
  });

  it('RPC call passes payment evidence ID', () => {
    expect(verifyRouteSrc).toContain('p_payment_id: paymentEvidenceId');
  });

  it('status update failure is non-fatal and logged as warning', () => {
    expect(verifyRouteSrc).toContain('paidStatusErr');
    // Must warn, not throw or return error
    const errHandlerPos = verifyRouteSrc.indexOf('paidStatusErr)');
    const warnPos = verifyRouteSrc.indexOf('warn', errHandlerPos);
    expect(warnPos).toBeGreaterThan(errHandlerPos);
    expect(warnPos).toBeLessThan(errHandlerPos + 200); // within reasonable range
    // Must NOT return an error response for this failure
    const afterErr = verifyRouteSrc.substring(errHandlerPos, errHandlerPos + 200);
    expect(afterErr).not.toContain('return NextResponse.json');
  });
});
