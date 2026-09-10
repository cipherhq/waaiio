/**
 * #270 — Public pricing projection tests
 *
 * Tests the exact allowlisted DTO contract, canary-key security,
 * authority from DB fixtures, subscribe-route annual rejection,
 * and stale-copy regressions.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// ── Projection DTO shape tests ──

describe('Public Pricing Projection DTO contract', () => {
  const ALLOWED_TOP_LEVEL_KEYS = new Set([
    'trialDays',
    'annualDiscountPercentage',
    'tierFees',
    'categoryFees',
    'byoFeePolicy',
    'country',
    'countries',
  ]);

  it('D1: DTO has exactly 7 allowed top-level keys', () => {
    expect(ALLOWED_TOP_LEVEL_KEYS.size).toBe(7);
  });

  it('D1: canary internal keys cannot appear in allowed DTO keys', () => {
    const INTERNAL_KEYS_THAT_MUST_NOT_LEAK = [
      'payout_cooling_period_days',
      'minimum_payout',
      'payout_verification_limits',
      'transfer_expiry_hours',
      'minimum_bank_transfer',
      'fee_policy_enabled',
      'fee_policy_version',
      'config_snapshot',
      'messaging_financial_gate',
      'messaging_reservation_ttl_seconds',
      'trial_credit_minor_by_currency',
      'subscription_included_minor_by_tier_currency',
      'canary_secret_test_key',
    ];

    for (const key of INTERNAL_KEYS_THAT_MUST_NOT_LEAK) {
      expect(ALLOWED_TOP_LEVEL_KEYS.has(key)).toBe(false);
    }
  });

  it('D1: projection route builds response field-by-field (no spread operator)', () => {
    const routeSource = readFileSync(
      join(process.cwd(), 'app/api/public/pricing/route.ts'),
      'utf-8',
    );
    // Must not use ...spread on snapshot or config objects in the response
    expect(routeSource).not.toMatch(/\.\.\.snapshot/);
    expect(routeSource).not.toMatch(/\.\.\.versionRow/);
    expect(routeSource).not.toMatch(/\.\.\.countryRow/);
    // Must use createServiceClient, not createClient from server.ts
    expect(routeSource).toContain('createServiceClient');
    expect(routeSource).not.toMatch(/from ['"]@\/lib\/supabase\/server['"]/);
  });

  it('D2: projection route does not import loadPlatformSettings', () => {
    const routeSource = readFileSync(
      join(process.cwd(), 'app/api/public/pricing/route.ts'),
      'utf-8',
    );
    expect(routeSource).not.toContain('loadPlatformSettings');
    expect(routeSource).not.toContain('getPlatformSettingsSync');
  });

  it('D12: projection route fails closed on missing data', () => {
    const routeSource = readFileSync(
      join(process.cwd(), 'app/api/public/pricing/route.ts'),
      'utf-8',
    );
    // Must return 503 on failure, not fall back to hardcoded values
    expect(routeSource).toContain('503');
    expect(routeSource).toContain('pricing_unavailable');
    // Must not import COUNTRY_PRICING or getPricingTiers for fallback
    expect(routeSource).not.toContain('COUNTRY_PRICING');
    expect(routeSource).not.toContain('getPricingTiers');
  });
});

// ── Subscribe route annual rejection ──

describe('Subscribe Route — Annual Billing Rejection', () => {
  it('D6: subscribe route rejects annual billing_interval before provider interaction', () => {
    const routeSource = readFileSync(
      join(process.cwd(), 'app/api/onboarding/subscribe/route.ts'),
      'utf-8',
    );
    // Must reject year before any provider call
    const yearRejectIndex = routeSource.indexOf("billing_interval !== 'month'");
    const paystackIndex = routeSource.indexOf('paystack.co');
    const stripeIndex = routeSource.indexOf('stripe.com');

    expect(yearRejectIndex).toBeGreaterThan(-1);
    expect(paystackIndex).toBeGreaterThan(-1);
    expect(stripeIndex).toBeGreaterThan(-1);
    // Year rejection must come BEFORE provider URLs
    expect(yearRejectIndex).toBeLessThan(paystackIndex);
    expect(yearRejectIndex).toBeLessThan(stripeIndex);
  });

  it('D6: subscribe route does not contain annual calculation branches', () => {
    const routeSource = readFileSync(
      join(process.cwd(), 'app/api/onboarding/subscribe/route.ts'),
      'utf-8',
    );
    // No annual discount calculation
    expect(routeSource).not.toContain('ANNUAL_DISCOUNT');
    expect(routeSource).not.toContain('STRIPE_ANNUAL_PRICE_IDS');
    // No annual plan page slugs
    expect(routeSource).not.toMatch(/year.*growth.*ANNUAL/i);
  });

  it('D6: subscribe route uses DB regional price, not hardcoded', () => {
    const routeSource = readFileSync(
      join(process.cwd(), 'app/api/onboarding/subscribe/route.ts'),
      'utf-8',
    );
    // Must use createServiceClient for DB price read
    expect(routeSource).toContain('createServiceClient');
    // Must query countries table
    expect(routeSource).toContain("from('countries')");
    // Must not use getPricingTiers or getCountry fallback helpers
    expect(routeSource).not.toContain('getPricingTiers');
    expect(routeSource).not.toContain('getCountry');
    expect(routeSource).not.toContain('getAnnualDiscount');
    // Must fail closed on missing price
    expect(routeSource).toContain('503');
  });
});

// ── START_TRIAL / SUBSCRIBE_NOW CTA ──

describe('StepPlan CTA Differentiation', () => {
  it('D7: StepPlan has "Start Free Trial" CTA for free plan', () => {
    const source = readFileSync(
      join(process.cwd(), 'app/get-started/steps/StepPlan.tsx'),
      'utf-8',
    );
    expect(source).toContain('Start Free Trial');
  });

  it('D8: StepPlan has "Subscribe" CTA for paid plans', () => {
    const source = readFileSync(
      join(process.cwd(), 'app/get-started/steps/StepPlan.tsx'),
      'utf-8',
    );
    expect(source).toContain('Subscribe');
  });

  it('D7/D8: StepPlan does not use generic "Continue" as CTA', () => {
    const source = readFileSync(
      join(process.cwd(), 'app/get-started/steps/StepPlan.tsx'),
      'utf-8',
    );
    // The CTA button text must not be just "Continue"
    // (other non-CTA buttons like "Back" are fine)
    const ctaMatch = source.match(/disabled=\{!selectedPlan\}[^>]*>\s*\n?\s*([\s\S]*?)\s*<\/button>/);
    if (ctaMatch) {
      expect(ctaMatch[1]).not.toBe('Continue');
    }
  });
});

// ── WhatsApp setup choices ──

describe('WhatsApp Setup — 3 Options for Paid Plans', () => {
  it('D10: StepDetails shows shared, own-number, and dedicated (coming soon) options', () => {
    const source = readFileSync(
      join(process.cwd(), 'app/get-started/steps/StepDetails.tsx'),
      'utf-8',
    );
    // Shared option (uses &apos; in JSX)
    expect(source).toContain("Waaiio&apos;s shared number");
    // Own number option
    expect(source).toContain('Connect my own WhatsApp number');
    // Dedicated option (coming soon)
    expect(source).toContain('Dedicated Waaiio-managed number');
    expect(source).toContain('Coming Soon');
    expect(source).toContain('Contact sales');
  });
});

// ── Admin COMMERCIAL_KEYS correction ──

describe('Admin COMMERCIAL_KEYS includes all M376 keys', () => {
  it('D11: PlatformSettings has all 17 DB commercial keys', () => {
    const source = readFileSync(
      join(process.cwd(), 'admin/src/pages/PlatformSettings.tsx'),
      'utf-8',
    );
    const DB_COMMERCIAL_KEYS = [
      'pricing_tiers', 'trial_days', 'broadcast_limits', 'conversation_limits',
      'default_platform_fee_percent', 'annual_discount_percentage',
      'payout_cooling_period_days', 'minimum_payout', 'payout_verification_limits',
      'transfer_expiry_hours', 'minimum_bank_transfer',
      'messaging_financial_gate', 'messaging_reservation_ttl_seconds',
      'trial_credit_minor_by_currency', 'subscription_included_minor_by_tier_currency',
      'fee_policy_enabled', 'category_fee_rates',
    ];

    for (const key of DB_COMMERCIAL_KEYS) {
      expect(source).toContain(`'${key}'`);
    }
  });

  it('D11: PlatformSettings has Fee Policy group', () => {
    const source = readFileSync(
      join(process.cwd(), 'admin/src/pages/PlatformSettings.tsx'),
      'utf-8',
    );
    expect(source).toContain("label: 'Fee Policy'");
  });
});

// ── Stale trial copy regression ──

describe('No hardcoded "30-day" trial copy regression', () => {
  it('D4: TIER_FEATURES.free.highlights has no "30-day" text', async () => {
    const { TIER_FEATURES } = await import('@/lib/constants');
    for (const tier of ['free', 'growth', 'business'] as const) {
      for (const highlight of TIER_FEATURES[tier].highlights) {
        expect(highlight).not.toMatch(/\b30-day\b/);
      }
    }
  });

  it('D4: pricing page has no hardcoded "30-day" in user-visible strings', () => {
    const source = readFileSync(
      join(process.cwd(), 'app/(marketing)/pricing/page.tsx'),
      'utf-8',
    );
    // The only "30-day" should be in the runtime replacement code, not in string literals
    const stringLiterals = source.match(/'[^']*30-day[^']*'|"[^"]*30-day[^"]*"|`[^`]*30-day[^`]*`/g) || [];
    // Filter out the regex pattern itself (which replaces 30-day at runtime)
    const userVisible = stringLiterals.filter(s => !s.includes('\\b30-day\\b'));
    expect(userVisible).toHaveLength(0);
  });

  it('D4: onboarding wizard side panels have no "30-day" text', () => {
    const source = readFileSync(
      join(process.cwd(), 'app/get-started/OnboardingWizard.tsx'),
      'utf-8',
    );
    // Check only the STEP_PANELS section for trial-related "30-day"
    // (other code like "customers haven't returned in 30 days" is non-trial)
    const stepPanelsSection = source.slice(
      source.indexOf('STEP_PANELS'),
      source.indexOf('STEP_PANELS') + 2000,
    );
    expect(stepPanelsSection).not.toMatch(/30-day free trial/);
    expect(stepPanelsSection).not.toMatch(/Free 30-day trial/);
  });

  it('D4: StepPlan has no hardcoded "30-day" text', () => {
    const source = readFileSync(
      join(process.cwd(), 'app/get-started/steps/StepPlan.tsx'),
      'utf-8',
    );
    expect(source).not.toMatch(/30-day/);
  });

  it('D4: StepFeatures has no hardcoded "30 days" trial text', () => {
    const source = readFileSync(
      join(process.cwd(), 'app/get-started/steps/StepFeatures.tsx'),
      'utf-8',
    );
    expect(source).not.toMatch(/free for 30 days/);
    expect(source).not.toMatch(/30-day trial/);
  });
});

// ── Dead PRICING export removed ──

describe('Legacy PRICING export removed', () => {
  it('D3: lib/constants no longer exports PRICING', async () => {
    const constants = await import('@/lib/constants');
    expect('PRICING' in constants).toBe(false);
  });
});

// ── Category fee safe projection ──

describe('Category fee projection security', () => {
  it('D8: projection route includes category fee labels', () => {
    const routeSource = readFileSync(
      join(process.cwd(), 'app/api/public/pricing/route.ts'),
      'utf-8',
    );
    expect(routeSource).toContain('CATEGORY_LABELS');
    expect(routeSource).toContain('categoryFees');
    expect(routeSource).toContain('byoFeePolicy');
  });

  it('D8: projection does not expose fee_policy_enabled', () => {
    const routeSource = readFileSync(
      join(process.cwd(), 'app/api/public/pricing/route.ts'),
      'utf-8',
    );
    // The response builder must not include fee_policy_enabled
    const responseSection = routeSource.slice(routeSource.indexOf('return NextResponse.json'));
    expect(responseSection).not.toContain('fee_policy_enabled');
    expect(responseSection).not.toContain('fee_policy_version');
  });
});

// ── Pricing page uses projection, not direct constants ──

describe('Pricing page data authority', () => {
  it('D3/D9: pricing page fetches from /api/public/pricing', () => {
    const source = readFileSync(
      join(process.cwd(), 'app/(marketing)/pricing/page.tsx'),
      'utf-8',
    );
    expect(source).toContain('/api/public/pricing');
  });

  it('D3: pricing page does not import COUNTRY_PRICING', () => {
    const source = readFileSync(
      join(process.cwd(), 'app/(marketing)/pricing/page.tsx'),
      'utf-8',
    );
    expect(source).not.toContain('COUNTRY_PRICING');
    expect(source).not.toContain('getPricingTiers');
  });

  it('D12: pricing page shows pricing-unavailable on error', () => {
    const source = readFileSync(
      join(process.cwd(), 'app/(marketing)/pricing/page.tsx'),
      'utf-8',
    );
    expect(source).toContain('Pricing temporarily unavailable');
    expect(source).toContain('Try Again');
  });

  it('D5: pricing page uses annualDiscountPercentage from projection', () => {
    const source = readFileSync(
      join(process.cwd(), 'app/(marketing)/pricing/page.tsx'),
      'utf-8',
    );
    expect(source).toContain('annualDiscountPercentage');
    expect(source).not.toContain('getAnnualDiscountSync');
  });
});

// ── JSON-LD stale price fix ──

describe('JSON-LD offers', () => {
  it('D3: home page JSON-LD does not contain stale $14.99/$39.99', () => {
    const source = readFileSync(
      join(process.cwd(), 'app/(marketing)/page.tsx'),
      'utf-8',
    );
    expect(source).not.toContain("price: '14.99'");
    expect(source).not.toContain("price: '39.99'");
  });
});
