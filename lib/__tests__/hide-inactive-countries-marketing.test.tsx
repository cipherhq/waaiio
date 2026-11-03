// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import PricingPage from '@/app/(marketing)/pricing/page';
import Footer from '@/components/marketing/Footer';
import { metadata } from '@/app/(marketing)/pricing/layout';
import { readFileSync } from 'node:fs';

// Owner decision (2026-11-03): Ghana is switched off in admin and must not be
// offered on the marketing site. The pricing feature card follows the same
// active-country data as the country picker.
const price = { free: { price: 0, feePercentage: 2.5, feeFlat: 0 }, growth: { price: 49, feePercentage: 1.5, feeFlat: 0 }, business: { price: 99, feePercentage: 1, feeFlat: 0 } };
const country = (code: string, name: string) => ({ code, name, flag: code, currencyCode: 'X', currencySymbol: '$', currencyLocale: 'en-US', gateway: 'stripe', pricing: price });
const active = [country('NG', 'Nigeria'), country('US', 'United States'), country('GB', 'United Kingdom'), country('CA', 'Canada')];
const body = { trialDays: 14, annualDiscountPercentage: 0, tierFees: { free: { feePercentage: 2.5 }, growth: { feePercentage: 1.5 }, business: { feePercentage: 1 } }, categoryFees: {}, byoFeePolicy: '', country: active[0], countries: active };

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('inactive countries are not offered on marketing pages', () => {
  it('pricing feature card lists exactly the active countries from the API', async () => {
    vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => body }));
    render(<PricingPage />);
    const title = await screen.findByText('4 Countries');
    const card = title.closest('div') as HTMLElement;
    expect(within(card).getByText('Nigeria, United States, United Kingdom, Canada with localized pricing and payment gateways.')).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/Ghana/);
    expect(screen.queryByText('5 Countries')).toBeNull();
  });

  it('footer country badges do not include Ghana', () => {
    render(<Footer />);
    const text = document.body.textContent || '';
    for (const name of ['Nigeria', 'US', 'UK', 'Canada']) expect(text).toContain(name);
    expect(text).not.toMatch(/Ghana/);
  });

  it('pricing page description does not offer Ghana', () => {
    expect(String(metadata.description)).not.toMatch(/Ghana/);
    expect(String(metadata.description)).toMatch(/Nigeria/);
  });

  it('public llms.txt summary does not offer Ghana', () => {
    expect(readFileSync('public/llms.txt', 'utf8')).not.toMatch(/Ghana/);
  });
});
