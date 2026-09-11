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
import { describe, it, expect } from 'vitest';
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

  it('does not synthesize wildcard when none existed — no rates for active market fails', () => {
    const currState = {
      NGN: { spendCap: '1200000', trialCredit: '700000', growthIncluded: '150000', businessIncluded: '600000', defaultCostMinor: '0' },
    };
    const ctryState = {
      NG: { rates: { utility: '', marketing: '' }, paystackGrowthPlan: 'PLN_g', paystackBusinessPlan: 'PLN_b' },
    };
    expect(() => buildMessagingPayload([NG], currState, ctryState))
      .toThrow('NG: At least one messaging rate');
  });

  it('empty default_cost_minor string serializes as 0 (not NaN)', () => {
    const currState = {
      NGN: { spendCap: '1200000', trialCredit: '700000', growthIncluded: '150000', businessIncluded: '600000', defaultCostMinor: '' },
    };
    const ctryState = {
      NG: { rates: { utility: '890', marketing: '6850' }, paystackGrowthPlan: 'PLN_g', paystackBusinessPlan: 'PLN_b' },
    };
    const result = buildMessagingPayload([NG], currState, ctryState);
    expect(result.messagingPricing.NGN.default_cost_minor).toBe(0);
  });
});
