/**
 * Admin Messaging Financial Controls — serialization round-trip proof.
 *
 * Exercises the buildMessagingPayload() export to prove:
 *   - default_cost_minor preserved exactly
 *   - utility + marketing rates preserved independently
 *   - hidden category keys (*, authentication, service) preserved
 *   - no wildcard synthesized when none existed
 *   - changing one visible rate does not destroy others
 *   - active market with no rates fails visibly
 */
import { describe, it, expect, vi } from 'vitest';

// Mock modules that Countries.tsx imports at module scope
vi.mock('@/lib/supabase', () => ({
  supabase: { auth: { getSession: vi.fn() } },
  adminDb: { rpc: vi.fn(), from: vi.fn(() => ({ select: vi.fn(), update: vi.fn(), insert: vi.fn() })) },
}));
vi.mock('@/lib/countries', () => ({
  loadCountries: vi.fn().mockResolvedValue([]),
  invalidateCache: vi.fn(),
}));
vi.mock('@/lib/auditLog', () => ({ logAudit: vi.fn() }));
vi.mock('@/components/AdminLayout', () => ({
  useAdminSession: () => ({ userId: 'test', email: 'test@test.com', role: 'admin' }),
}));
vi.mock('@/lib/adminAuth', () => ({ isFullAdmin: () => true }));
vi.mock('@/components/SummaryCard', () => ({ SummaryCard: () => null }));
vi.mock('@/components/Pagination', () => ({ Pagination: () => null }));
vi.mock('lucide-react', () => ({
  Globe: () => null, Plus: () => null, Pencil: () => null, Trash2: () => null,
  Save: () => null, X: () => null, CreditCard: () => null, CheckCircle: () => null, XCircle: () => null,
}));

import { buildMessagingPayload } from '../pages/Countries';
import type { CountryRow } from '../lib/countries';

// Minimal CountryRow stubs
const NG: CountryRow = { code: 'NG', name: 'Nigeria', flag: '🇳🇬', dialing_code: '+234', currency_code: 'NGN', currency_symbol: '₦', currency_locale: 'en-NG', payment_gateway: 'paystack', phone_digits: 11, phone_pattern: '', phone_placeholder: '', is_active: true, sort_order: 1, cities: {}, pricing: {}, verification_tiers: {}, doc_types: [] } as CountryRow;
const US: CountryRow = { code: 'US', name: 'United States', flag: '🇺🇸', dialing_code: '+1', currency_code: 'USD', currency_symbol: '$', currency_locale: 'en-US', payment_gateway: 'stripe', phone_digits: 10, phone_pattern: '', phone_placeholder: '', is_active: true, sort_order: 2, cities: {}, pricing: {}, verification_tiers: {}, doc_types: [] } as CountryRow;

describe('buildMessagingPayload — Admin serialization', () => {
  it('preserves default_cost_minor exactly', () => {
    const currState = {
      NGN: { spendCap: '1200000', trialCredit: '700000', growthIncluded: '150000', businessIncluded: '600000', defaultCostMinor: '42' },
      USD: { spendCap: '3000', trialCredit: '500', growthIncluded: '400', businessIncluded: '1500', defaultCostMinor: '7' },
    };
    const ctryState = {
      NG: { rates: { utility: '890', marketing: '6850' }, paystackGrowthPlan: 'PLN_g', paystackBusinessPlan: 'PLN_b' },
      US: { rates: { utility: '1', marketing: '3' }, paystackGrowthPlan: '', paystackBusinessPlan: '' },
    };
    const result = buildMessagingPayload([NG, US], currState, ctryState);

    expect(result.messagingPricing.NGN.default_cost_minor).toBe(42);
    expect(result.messagingPricing.USD.default_cost_minor).toBe(7);
  });

  it('preserves utility + marketing rates independently, no wildcard injected', () => {
    const currState = {
      NGN: { spendCap: '1200000', trialCredit: '700000', growthIncluded: '150000', businessIncluded: '600000', defaultCostMinor: '0' },
    };
    const ctryState = {
      NG: { rates: { utility: '890', marketing: '6850' }, paystackGrowthPlan: 'PLN_g', paystackBusinessPlan: 'PLN_b' },
    };
    const result = buildMessagingPayload([NG], currState, ctryState);

    const ngRates = result.messagingPricing.NGN.rates.NG;
    expect(ngRates.utility).toBe(890);
    expect(ngRates.marketing).toBe(6850);
    expect(ngRates['*']).toBeUndefined(); // No wildcard injected
  });

  it('preserves hidden category keys (*, authentication, service) that were loaded', () => {
    const currState = {
      NGN: { spendCap: '1200000', trialCredit: '700000', growthIncluded: '150000', businessIncluded: '600000', defaultCostMinor: '50' },
    };
    // Simulate Admin loading a snapshot that had *, authentication, and service keys
    const ctryState = {
      NG: {
        rates: { utility: '890', marketing: '6850', '*': '400', authentication: '200', service: '300' },
        paystackGrowthPlan: 'PLN_g', paystackBusinessPlan: 'PLN_b',
      },
    };
    const result = buildMessagingPayload([NG], currState, ctryState);

    const ngRates = result.messagingPricing.NGN.rates.NG;
    expect(ngRates.utility).toBe(890);
    expect(ngRates.marketing).toBe(6850);
    expect(ngRates['*']).toBe(400);
    expect(ngRates.authentication).toBe(200);
    expect(ngRates.service).toBe(300);
  });

  it('changing one visible rate preserves all untouched values', () => {
    const currState = {
      NGN: { spendCap: '1200000', trialCredit: '700000', growthIncluded: '150000', businessIncluded: '600000', defaultCostMinor: '42' },
    };
    // Start with existing rates, change only marketing
    const ctryState = {
      NG: {
        rates: { utility: '890', marketing: '9999', '*': '400', authentication: '200' },
        paystackGrowthPlan: 'PLN_g', paystackBusinessPlan: 'PLN_b',
      },
    };
    const result = buildMessagingPayload([NG], currState, ctryState);

    expect(result.messagingPricing.NGN.default_cost_minor).toBe(42); // Preserved
    expect(result.messagingPricing.NGN.rates.NG.utility).toBe(890); // Untouched
    expect(result.messagingPricing.NGN.rates.NG.marketing).toBe(9999); // Changed
    expect(result.messagingPricing.NGN.rates.NG['*']).toBe(400); // Preserved
    expect(result.messagingPricing.NGN.rates.NG.authentication).toBe(200); // Preserved
  });

  // ── default_cost_minor absence semantics ──

  it('absent default_cost_minor (empty string) → key omitted from bucket', () => {
    const currState = {
      NGN: { spendCap: '1200000', trialCredit: '700000', growthIncluded: '150000', businessIncluded: '600000', defaultCostMinor: '' },
    };
    const ctryState = {
      NG: { rates: { utility: '890', marketing: '6850' }, paystackGrowthPlan: 'PLN_g', paystackBusinessPlan: 'PLN_b' },
    };
    const result = buildMessagingPayload([NG], currState, ctryState);
    expect('default_cost_minor' in result.messagingPricing.NGN).toBe(false);
  });

  it('explicit zero default_cost_minor → preserved as 0', () => {
    const currState = {
      NGN: { spendCap: '1200000', trialCredit: '700000', growthIncluded: '150000', businessIncluded: '600000', defaultCostMinor: '0' },
    };
    const ctryState = {
      NG: { rates: { utility: '890', marketing: '6850' }, paystackGrowthPlan: 'PLN_g', paystackBusinessPlan: 'PLN_b' },
    };
    const result = buildMessagingPayload([NG], currState, ctryState);
    expect(result.messagingPricing.NGN.default_cost_minor).toBe(0);
  });

  it('non-zero default_cost_minor → preserved exactly', () => {
    const currState = {
      NGN: { spendCap: '1200000', trialCredit: '700000', growthIncluded: '150000', businessIncluded: '600000', defaultCostMinor: '42' },
    };
    const ctryState = {
      NG: { rates: { utility: '890', marketing: '6850' }, paystackGrowthPlan: 'PLN_g', paystackBusinessPlan: 'PLN_b' },
    };
    const result = buildMessagingPayload([NG], currState, ctryState);
    expect(result.messagingPricing.NGN.default_cost_minor).toBe(42);
  });

  // ── Active market category readiness ──

  it('active market missing utility rate → fails visibly', () => {
    const currState = {
      NGN: { spendCap: '1200000', trialCredit: '700000', growthIncluded: '150000', businessIncluded: '600000', defaultCostMinor: '' },
    };
    const ctryState = {
      NG: { rates: { utility: '', marketing: '6850' }, paystackGrowthPlan: 'PLN_g', paystackBusinessPlan: 'PLN_b' },
    };
    expect(() => buildMessagingPayload([NG], currState, ctryState))
      .toThrow('NG: Utility rate is required');
  });

  it('active market missing marketing rate → fails visibly', () => {
    const currState = {
      NGN: { spendCap: '1200000', trialCredit: '700000', growthIncluded: '150000', businessIncluded: '600000', defaultCostMinor: '' },
    };
    const ctryState = {
      NG: { rates: { utility: '890', marketing: '' }, paystackGrowthPlan: 'PLN_g', paystackBusinessPlan: 'PLN_b' },
    };
    expect(() => buildMessagingPayload([NG], currState, ctryState))
      .toThrow('NG: Marketing rate is required');
  });

  it('active market with both utility + marketing succeeds; hidden categories preserved', () => {
    const currState = {
      NGN: { spendCap: '1200000', trialCredit: '700000', growthIncluded: '150000', businessIncluded: '600000', defaultCostMinor: '' },
    };
    const ctryState = {
      NG: { rates: { utility: '890', marketing: '6850', '*': '400', service: '100' }, paystackGrowthPlan: 'PLN_g', paystackBusinessPlan: 'PLN_b' },
    };
    const result = buildMessagingPayload([NG], currState, ctryState);
    expect(result.messagingPricing.NGN.rates.NG.utility).toBe(890);
    expect(result.messagingPricing.NGN.rates.NG.marketing).toBe(6850);
    expect(result.messagingPricing.NGN.rates.NG['*']).toBe(400);
    expect(result.messagingPricing.NGN.rates.NG.service).toBe(100);
  });

  it('hidden categories alone do not satisfy active-market readiness', () => {
    const currState = {
      NGN: { spendCap: '1200000', trialCredit: '700000', growthIncluded: '150000', businessIncluded: '600000', defaultCostMinor: '' },
    };
    const ctryState = {
      NG: { rates: { utility: '', marketing: '', '*': '400', authentication: '200' }, paystackGrowthPlan: 'PLN_g', paystackBusinessPlan: 'PLN_b' },
    };
    expect(() => buildMessagingPayload([NG], currState, ctryState))
      .toThrow('NG: Utility rate is required');
  });
});
