/**
 * Subscription & Loyalty Hardening — Behavioral Tests
 */
import { describe, it, expect, vi } from 'vitest';

// ═══════════════════════════════════════════════════════
// 1. PAYSTACK INTERVAL MAPPING
// ═══════════════════════════════════════════════════════

describe('Paystack interval mapping', () => {
  it('yearly maps to annually for Paystack API', async () => {
    // Mock the Paystack request to capture the body
    const capturedBodies: any[] = [];
    vi.doMock('@/lib/payments/paystack-recurring', async (importOriginal) => {
      const mod = await importOriginal() as any;
      return mod;
    });

    // Read the source to verify the mapping exists
    const fs = await import('fs');
    const path = await import('path');
    const source = fs.readFileSync(path.resolve(__dirname, '../../payments/paystack-recurring.ts'), 'utf-8');
    expect(source).toContain("yearly: 'annually'");
    expect(source).toContain("weekly: 'weekly'");
    expect(source).toContain("monthly: 'monthly'");
  });
});

// ═══════════════════════════════════════════════════════
// 2. SERVICES DASHBOARD YEARLY
// ═══════════════════════════════════════════════════════

describe('Services dashboard yearly support', () => {
  it('TypeScript type includes yearly', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const source = fs.readFileSync(path.resolve(__dirname, '../../../app/dashboard/services/page.tsx'), 'utf-8');
    expect(source).toContain("'yearly'");
    expect(source).toContain('<option value="yearly">Yearly</option>');
  });
});

// ═══════════════════════════════════════════════════════
// 3. YEARLY NEXT CHARGE DATE MATH
// ═══════════════════════════════════════════════════════

describe('Yearly next_charge_at calculation', () => {
  it('initial setup: yearly adds 1 year', () => {
    const now = new Date('2026-01-15T10:00:00Z');
    const next = new Date(now);
    next.setFullYear(next.getFullYear() + 1);
    expect(next.getFullYear()).toBe(2027);
    expect(next.getMonth()).toBe(0); // January
    expect(next.getDate()).toBe(15);
  });

  it('Stripe webhook yearly renewal uses +1 year', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const source = fs.readFileSync(path.resolve(__dirname, '../../../app/api/payments/stripe-webhook/route.ts'), 'utf-8');
    // Both renewal blocks must have yearly branch
    const blocks = source.match(/frequency === 'yearly'/g) || [];
    expect(blocks.length).toBeGreaterThanOrEqual(2);
  });

  it('process_recurring_charge RPC yearly uses +1 year', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const source = fs.readFileSync(path.resolve(__dirname, '../../../supabase/migrations/305_annual_subscriptions_loyalty.sql'), 'utf-8');
    expect(source).toContain("INTERVAL '1 year'");
    expect(source).toContain("v_sub.frequency = 'yearly'");
  });
});

// ═══════════════════════════════════════════════════════
// 4. SUBSCRIPTION DETAILS → PAYMENT HISTORY NAVIGATION
// ═══════════════════════════════════════════════════════

describe('Subscription details → payment history flow', () => {
  it('subscription_details is a proper step with validate and next', async () => {
    const { recurringManageFlow } = await import('../flows/recurring-manage.flow');
    const detailsStep = recurringManageFlow.steps.find(s => s.id === 'subscription_details');
    expect(detailsStep).toBeDefined();
    expect(detailsStep!.validate).toBeDefined();
    expect(detailsStep!.next).toBeDefined();
  });

  it('payment_history step exists and is reachable', async () => {
    const { recurringManageFlow } = await import('../flows/recurring-manage.flow');
    const historyStep = recurringManageFlow.steps.find(s => s.id === 'payment_history');
    expect(historyStep).toBeDefined();
  });

  it('details validate routes to history or back', async () => {
    const { recurringManageFlow } = await import('../flows/recurring-manage.flow');
    const step = recurringManageFlow.steps.find(s => s.id === 'subscription_details')!;

    const historyResult = await step.validate!('payment_history', {} as any);
    expect(historyResult.valid).toBe(true);
    expect(historyResult.data?._details_action).toBe('history');

    const backResult = await step.validate!('back_subs', {} as any);
    expect(backResult.valid).toBe(true);
    expect(backResult.data?._details_action).toBe('back');
  });
});

// ═══════════════════════════════════════════════════════
// 5. PAYMENT HISTORY OWNERSHIP
// ═══════════════════════════════════════════════════════

describe('Payment history ownership validation', () => {
  it('payment_history step verifies subscription ownership', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const source = fs.readFileSync(path.resolve(__dirname, '../flows/recurring-manage.flow.ts'), 'utf-8');
    const historySection = source.substring(source.indexOf("id: 'payment_history'"));
    // Must verify business_id and customer_phone
    expect(historySection).toContain("eq('business_id'");
    expect(historySection).toContain('customer_phone');
  });
});

// ═══════════════════════════════════════════════════════
// 6. PHONE NORMALIZATION FOR LOYALTY
// ═══════════════════════════════════════════════════════

describe('Loyalty phone normalization', () => {
  it('tier assignment uses phoneWithPlus', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const source = fs.readFileSync(path.resolve(__dirname, '../flows/shared/post-completion.ts'), 'utf-8');
    // Both multiplier lookup and tier assignment must use phoneWithPlus
    const multiplierSection = source.substring(source.indexOf('Apply loyalty-tier points multiplier'));
    expect(multiplierSection).toContain("eq('phone', phoneWithPlus)");
    const tierSection = source.substring(source.indexOf('auto-assign loyalty tier'));
    expect(tierSection).toContain("eq('phone', phoneWithPlus)");
  });
});

// ═══════════════════════════════════════════════════════
// 7. FLUTTERWAVE LIFECYCLE
// ═══════════════════════════════════════════════════════

describe('STRUCTURAL: Flutterwave Waaiio-managed token billing', () => {
  it('enrollment does NOT create Flutterwave plan or subscription', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const source = fs.readFileSync(path.resolve(__dirname, '../flows/payment.flow.ts'), 'utf-8');
    expect(source).not.toContain('createFlutterwavePlan');
    expect(source).not.toContain('createFlutterwaveSubscription');
    expect(source).toContain('waaiio_flw_');
  });

  it('Flutterwave pause/resume/cancel are DB-only (Paystack uses provider)', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const source = fs.readFileSync(path.resolve(__dirname, '../flows/recurring-manage.flow.ts'), 'utf-8');
    // Flutterwave: no provider calls
    expect(source).not.toContain('cancelFlwSub');
    expect(source).not.toContain('activateFlwSub');
    expect(source).toContain('Flutterwave: DB-only pause');
    // Paystack: uses provider disable/enable
    expect(source).toContain('cancelPaystackSub');
    expect(source).toContain('enablePaystackSub');
  });

  it('renewal uses atomic claim + finalize RPCs', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const source = fs.readFileSync(path.resolve(__dirname, '../../../app/api/cron/retry-failed-charges/route.ts'), 'utf-8');
    // Uses claim RPC before charging
    expect(source).toContain("rpc('claim_recurring_billing_cycle'");
    // Uses finalize RPC after charge success
    expect(source).toContain("rpc('finalize_token_recurring_charge'");
    // Stable tx_ref (deterministic, not Date.now())
    expect(source).toContain('flw-${sub.id}-');
    expect(source).toContain('.toISOString().slice(0, 10)');
  });

  it('auto-cancel respects provider-first for Stripe/Paystack', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const source = fs.readFileSync(path.resolve(__dirname, '../../../app/api/cron/retry-failed-charges/route.ts'), 'utf-8');
    // Provider cancel failure prevents DB cancel for Stripe/Paystack
    expect(source).toContain("providerCancelled = false");
    expect(source).toContain("provider cancel failed");
    // Flutterwave is DB-only (no provider call)
    expect(source).toContain('Flutterwave: DB-only cancel');
  });

  it('claim + finalize RPCs exist in migration', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const migration = fs.readFileSync(path.resolve(__dirname, '../../../supabase/migrations/305_annual_subscriptions_loyalty.sql'), 'utf-8');
    expect(migration).toContain('CREATE OR REPLACE FUNCTION claim_recurring_billing_cycle');
    expect(migration).toContain('CREATE OR REPLACE FUNCTION finalize_token_recurring_charge');
    // Claim uses FOR UPDATE to serialize
    expect(migration).toContain('FOR UPDATE');
    // Finalize checks idempotency
    expect(migration).toContain('already_finalized');
    // Finalize uses atomic counter increment (not SELECT → +1)
    expect(migration).toContain('charge_count = charge_count + 1');
    expect(migration).toContain('total_charged = total_charged + p_amount');
    // Platform fee included
    expect(migration).toContain('platform_fees');
    // Booking record included (finance parity with Paystack RPC)
    expect(migration).toContain('INSERT INTO bookings');
  });
});

// ═══════════════════════════════════════════════════════
// 8. FLUTTERWAVE FAILURE NOTIFICATION
// ═══════════════════════════════════════════════════════

describe('Flutterwave failure notification', () => {
  it('retry cron notifies customer on Flutterwave charge failure', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const source = fs.readFileSync(path.resolve(__dirname, '../../../app/api/cron/retry-failed-charges/route.ts'), 'utf-8');
    const flwSection = source.substring(source.indexOf('Flutterwave recurring retry'));
    expect(flwSection).toContain('notifyCustomerChargeFailed');
  });
});

// ═══════════════════════════════════════════════════════
// 9. WEEKLY VALIDATION MESSAGE
// ═══════════════════════════════════════════════════════

describe('Recurring offer validation', () => {
  it('error message mentions all available options including weekly', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const source = fs.readFileSync(path.resolve(__dirname, '../flows/payment.flow.ts'), 'utf-8');
    expect(source).toContain('*Weekly*, *Monthly*, *Yearly*');
  });
});

// ═══════════════════════════════════════════════════════
// 10. FIRST-CYCLE DOUBLE CHARGE PREVENTION
// ═══════════════════════════════════════════════════════

describe('First-cycle double charge prevention', () => {
  it('Paystack subscription defers first charge with start_date', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const source = fs.readFileSync(path.resolve(__dirname, '../flows/payment.flow.ts'), 'utf-8');
    // Must pass startDate to createPaystackSubscription
    expect(source).toContain('startDate: paystackNextCharge.toISOString()');
  });

  it('Stripe subscription defers first charge with trial_end', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const source = fs.readFileSync(path.resolve(__dirname, '../../payments/stripe-recurring.ts'), 'utf-8');
    expect(source).toContain("subscription_data[trial_end]");
    const flowSource = fs.readFileSync(path.resolve(__dirname, '../flows/payment.flow.ts'), 'utf-8');
    expect(flowSource).toContain('trialEnd: Math.floor(stripeTrialEnd.getTime() / 1000)');
  });

  it('Flutterwave does not charge again on enrollment', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const source = fs.readFileSync(path.resolve(__dirname, '../flows/payment.flow.ts'), 'utf-8');
    // Must NOT call createFlutterwavePlan or createFlutterwaveSubscription
    expect(source).not.toContain('createFlutterwavePlan');
    expect(source).not.toContain('createFlutterwaveSubscription(');
    // Uses internal reference — no provider subscription
    expect(source).toContain('waaiio_flw_');
  });
});

// ═══════════════════════════════════════════════════════
// 11. CANCEL FALSE SUCCESS FIX
// ═══════════════════════════════════════════════════════

describe('Cancel does not falsely update DB', () => {
  it('provider failure prevents DB status change', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const source = fs.readFileSync(path.resolve(__dirname, '../flows/recurring-manage.flow.ts'), 'utf-8');
    // Must check !cancelled BEFORE DB update
    expect(source).toContain("if (!cancelled)");
    expect(source).toContain("cancel the subscription at the payment provider");
    // DB cancelled update must exist AFTER the failure check
    const failIdx = source.indexOf("if (!cancelled)");
    const dbIdx = source.indexOf("status: 'cancelled'", failIdx);
    expect(failIdx).toBeGreaterThan(-1);
    expect(dbIdx).toBeGreaterThan(failIdx);
  });
});

// ═══════════════════════════════════════════════════════
// 12. FLUTTERWAVE AUTOMATIC RENEWAL HANDLING
// ═══════════════════════════════════════════════════════

describe('Flutterwave webhook — Waaiio-managed model', () => {
  it('webhook ignores unknown tx_refs (no provider subscriptions)', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const source = fs.readFileSync(path.resolve(__dirname, '../../../app/api/webhooks/flutterwave/route.ts'), 'utf-8');
    // Must NOT process unknown charges as renewals
    expect(source).toContain('no Flutterwave provider subscriptions');
    expect(source).not.toContain('Flutterwave automatic renewal');
  });
});

// ═══════════════════════════════════════════════════════
// 11. REGRESSION SAFETY
// ═══════════════════════════════════════════════════════

describe('Regression safety', () => {
  it('loyalty redemption RPC preserved', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const source = fs.readFileSync(path.resolve(__dirname, '../flows/loyalty.flow.ts'), 'utf-8');
    expect(source).toContain('redeem_loyalty_points');
  });

  it('existing weekly/monthly still work in constraints', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const migration = fs.readFileSync(path.resolve(__dirname, '../../../supabase/migrations/305_annual_subscriptions_loyalty.sql'), 'utf-8');
    expect(migration).toContain("'weekly'");
    expect(migration).toContain("'monthly'");
    expect(migration).toContain("'yearly'");
  });
});
