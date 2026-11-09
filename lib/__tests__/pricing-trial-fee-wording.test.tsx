// @vitest-environment jsdom
/**
 * Pricing wording (Owner decisions 2026-11-08): Waaiio's fee (Starter 3%) applies
 * from day one, plus payment gateway fees paid by the business; the 14-day
 * free trial is for Pro and Premium features. Starter / Pro allow 100 / 1,000
 * bookings a month. The page must not read as "no fees".
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
  it('says 3% from day one plus gateway fees, and that the trial is for Pro and Premium features', async () => {
    vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} });
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => projection })));
    render(<PricingPage />);
    expect(await screen.findByText(/Try every Pro and Premium feature free for 14 days\. Starter has no monthly fee: a 3% Waaiio fee applies to each paid transaction from day one, and payment gateway fees are paid by your business\./)).toBeTruthy();
    expect(screen.queryByText(/zero fees/i)).toBeNull();
    expect(screen.queryByText(/\(no fees\)/i)).toBeNull();
    expect(screen.getByText('14-day trial of Pro & Premium features')).toBeTruthy();
    expect(screen.queryByText(/no (waaiio )?platform fee/i)).toBeNull();
    expect(screen.getByText(/are separate and are paid by your business/)).toBeTruthy();
  });

  it('shows the booking limits the bot and settings use: 100 and 1,000 a month', async () => {
    vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} });
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => projection })));
    render(<PricingPage />);
    expect(await screen.findByText('Up to 100')).toBeTruthy();
    expect(screen.getByText('Up to 1,000')).toBeTruthy();
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

describe('upgrade banner uses the same limits', () => {
  it('stays hidden at 60 Starter bookings (60 of 100), where it used to say the limit was reached', async () => {
    const { UpgradeBanner } = await import('@/components/dashboard/UpgradeBanner');
    render(<UpgradeBanner currentBookings={60} tier="free" />);
    expect(screen.queryByText(/limit/i)).toBeNull();
  });

  it('warns at 75 of 100 and names the Pro limit of 1,000', async () => {
    const { UpgradeBanner } = await import('@/components/dashboard/UpgradeBanner');
    render(<UpgradeBanner currentBookings={75} tier="free" />);
    expect(screen.getByText("You've used 75 of 100 bookings this month. Upgrade to Pro for 1,000 bookings.")).toBeTruthy();
  });

  it('says the limit is reached only at 100', async () => {
    const { UpgradeBanner } = await import('@/components/dashboard/UpgradeBanner');
    render(<UpgradeBanner currentBookings={100} tier="free" />);
    expect(screen.getByText('Booking limit reached')).toBeTruthy();
  });
});

describe('plan emails quote the current rates', () => {
  it('trial and subscription emails say 3% / 1.5% / 1% and no 2.5%, ₦75 or 7-day trial', async () => {
    const t = await import('@/lib/email/templates');
    const html = [
      t.trialExpiringEmail('Biz', 3).html, t.trialEndedEmail('Biz').html,
      t.subscriptionExpiringEmail('Biz', 3, 'https://x').html, t.subscriptionExpiredEmail('Biz', 'https://x').html,
    ].join('\n');
    expect(html).not.toMatch(/2\.5%|₦75|7-day/);
    expect(t.trialExpiringEmail('Biz', 3).html).toMatch(/3% per transaction[\s\S]*1\.5% per transaction[\s\S]*1% per transaction/);
    expect(t.trialEndedEmail('Biz').html).toContain('Pro and Premium features are now switched off. Your per-transaction fee stays the same.');
    expect(t.trialExpiringEmail('Biz', 3).html).not.toMatch(/start paying per-transaction fees/);
    expect(t.subscriptionExpiredEmail('Biz', 'https://x').html).toContain('3%');
  });
});
