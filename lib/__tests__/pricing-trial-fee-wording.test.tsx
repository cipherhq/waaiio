// @vitest-environment jsdom
/**
 * Pricing wording (Owner 2026-11-08): Starter is 3% per paid transaction after
 * the trial, and Starter / Pro allow 100 / 1,000 bookings a month. The trial
 * waives only the Waaiio platform fee, so the page must not read as "no fees".
 */
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import PricingPage from '@/app/(marketing)/pricing/page';
import { TIER_TRANSACTION_LIMITS, TIER_FEATURES, PRICING_TIERS } from '@/lib/constants';

const ng = { code: 'NG', name: 'Nigeria', flag: 'NG', currencyCode: 'NGN', currencySymbol: '₦', currencyLocale: 'en-NG', gateway: 'paystack',
  pricing: { free: { price: 0, feePercentage: 3, feeFlat: 0 }, growth: { price: 49999, feePercentage: 1.5, feeFlat: 0 }, business: { price: 99999, feePercentage: 1, feeFlat: 0 } } };
const projection = { trialDays: 14, annualDiscountPercentage: 0, tierFees: { free: { feePercentage: 3 }, growth: { feePercentage: 1.5 }, business: { feePercentage: 1 } },
  categoryFees: {}, byoFeePolicy: '', country: ng, countries: [ng] };

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('pricing page fee wording', () => {
  it('says the trial waives only the platform fee, then 3% per paid transaction', async () => {
    vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} });
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => projection })));
    render(<PricingPage />);
    expect(await screen.findByText(/14-day free trial with no Waaiio platform fee, then a 3% standard platform fee on each paid transaction\./)).toBeTruthy();
    expect(screen.queryByText(/zero fees/i)).toBeNull();
    expect(screen.queryByText(/\(no fees\)/i)).toBeNull();
    expect(screen.getByText('Free trial (no platform fee)')).toBeTruthy();
  });

  it('shows the booking limits the bot and settings use: 100 and 1000 a month', async () => {
    vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} });
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => projection })));
    render(<PricingPage />);
    expect(await screen.findByText('Up to 100')).toBeTruthy();
    expect(screen.getByText('Up to 1000')).toBeTruthy();
  });
});

describe('booking limits agree everywhere', () => {
  it('enforced monthly booking limits match the plan limits (100 / 1,000 / unlimited)', () => {
    expect(TIER_TRANSACTION_LIMITS.free.bookings).toBe(100);
    expect(TIER_TRANSACTION_LIMITS.growth.bookings).toBe(1000);
    expect(TIER_TRANSACTION_LIMITS.business.bookings).toBe(-1);
    expect(PRICING_TIERS.free.maxBookings).toBe(TIER_TRANSACTION_LIMITS.free.bookings);
    expect(PRICING_TIERS.growth.maxBookings).toBe(TIER_TRANSACTION_LIMITS.growth.bookings);
    expect(TIER_FEATURES.free.maxBookings).toBe(100);
  });
});
