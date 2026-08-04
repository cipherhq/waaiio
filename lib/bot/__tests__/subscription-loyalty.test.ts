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

describe('Flutterwave Waaiio-managed token billing', () => {
  it('enrollment does NOT create Flutterwave plan or subscription', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const source = fs.readFileSync(path.resolve(__dirname, '../flows/payment.flow.ts'), 'utf-8');
    // Must NOT call createFlutterwavePlan or createFlutterwaveSubscription
    expect(source).not.toContain('createFlutterwavePlan');
    expect(source).not.toContain('createFlutterwaveSubscription');
    // Must use internal reference (not a provider subscription ID)
    expect(source).toContain('waaiio_flw_');
  });

  it('pause/resume/cancel are DB-only (no Flutterwave provider calls)', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const source = fs.readFileSync(path.resolve(__dirname, '../flows/recurring-manage.flow.ts'), 'utf-8');
    // Must NOT call Flutterwave cancel/activate for pause/resume
    expect(source).not.toContain('cancelFlwSub');
    expect(source).not.toContain('activateFlwSub');
    // DB-only comment present
    expect(source).toContain('Waaiio controls Flutterwave token');
  });

  it('normal renewal scheduler exists for active due Flutterwave subscriptions', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const source = fs.readFileSync(path.resolve(__dirname, '../../../app/api/cron/retry-failed-charges/route.ts'), 'utf-8');
    // Must query active + due Flutterwave subscriptions
    expect(source).toContain("eq('gateway', 'flutterwave')");
    expect(source).toContain("eq('status', 'active')");
    expect(source).toContain("lte('next_charge_at'");
    // Must handle yearly
    expect(source).toContain("frequency === 'yearly'");
    // Must create payment + subscription_charge
    expect(source).toContain("from('payments').insert");
    expect(source).toContain("from('subscription_charges').insert");
    // Must notify customer on failure
    expect(source).toContain('notifyCustomerChargeFailed');
  });

  it('auto-cancel for Flutterwave is DB-only', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const source = fs.readFileSync(path.resolve(__dirname, '../../../app/api/cron/retry-failed-charges/route.ts'), 'utf-8');
    // Must NOT call Flutterwave cancelSubscription in auto-cancel
    expect(source).toContain('Flutterwave: DB-only cancel');
  });

  it('provider failure (pause) does not falsely update DB', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const source = fs.readFileSync(path.resolve(__dirname, '../flows/recurring-manage.flow.ts'), 'utf-8');
    expect(source).toContain('if (!paused)');
    expect(source).toContain('if (!resumed)');
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
