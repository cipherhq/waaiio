/**
 * #270 — Onboarding fail-closed pricing: component-level runtime proofs
 *
 * Renders actual production StepPlan component using react-dom/server
 * (Node env, no jsdom required) to prove:
 * 1. Zeroed commercial fields do not render constants/fallback prices
 * 2. DB fixture values render correctly when projection is present
 * 3. CTA differentiation with the real component
 * 4. Pricing-unavailable gate blocks progression
 */

import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { getPricingTiers, type CountryCode } from '@/lib/constants';
import type { CapabilityId } from '@/lib/capabilities/types';
import { readFileSync } from 'fs';
import { join } from 'path';

// Mock framer-motion for SSR
const MockDiv = React.forwardRef(function MockDiv(props: any, ref: any) {
  return React.createElement('div', { ...props, ref, whileHover: undefined, transition: undefined }, props.children);
});
const MockSvg = React.forwardRef(function MockSvg(props: any, ref: any) {
  return React.createElement('svg', { ...props, ref, animate: undefined, transition: undefined }, props.children);
});
vi.mock('framer-motion', () => ({
  motion: { div: MockDiv, svg: MockSvg },
  AnimatePresence: function MockAnimatePresence({ children }: any) { return children; },
}));

// Mock next/link for server render
vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: any) =>
    React.createElement('a', { href, ...props }, children),
}));

// Import the REAL production StepPlan component
import { StepPlan } from '@/app/get-started/steps/StepPlan';

describe('StepPlan — component-level fail-closed pricing proof', () => {
  const CONSTANTS_TIERS_NG = getPricingTiers('NG');
  const noop = () => {};

  function renderPlanToHTML(overrides: {
    localTiers: ReturnType<typeof getPricingTiers>;
    selectedPlan?: 'free' | 'growth' | 'business';
  }): string {
    return renderToString(
      React.createElement(StepPlan, {
        selectedPlan: overrides.selectedPlan || 'growth',
        setSelectedPlan: noop,
        selectedCapabilities: [] as CapabilityId[],
        setSelectedCapabilities: noop as any,
        selectedCountry: 'NG' as CountryCode,
        requiredPlan: 'free',
        localTiers: overrides.localTiers,
        setStep: noop as any,
      }),
    );
  }

  it('zeroed localTiers renders NO constants NG growth/business prices', () => {
    const zeroed = {
      free: { ...CONSTANTS_TIERS_NG.free, price: 0, feePercentage: 0, feeFlat: 0 },
      growth: { ...CONSTANTS_TIERS_NG.growth, price: 0, feePercentage: 0, feeFlat: 0 },
      business: { ...CONSTANTS_TIERS_NG.business, price: 0, feePercentage: 0, feeFlat: 0 },
    };

    const html = renderPlanToHTML({
      localTiers: zeroed,
    });

    // Known NG constants prices must NOT appear in rendered output
    expect(html).not.toContain('20,000'); // NG growth = ₦20,000
    expect(html).not.toContain('60,000'); // NG business = ₦60,000
    // Fee percentages are 0, not the constants 2.5%/1.5%
    expect(html).toContain('0%');
    // Sanity: real component rendered
    expect(html).toContain('Starter');
    expect(html).toContain('Choose your plan');
  });

  it('DB-fixture localTiers renders exact DB prices, NOT constants prices', () => {
    const DB_GROWTH = 25000;
    const DB_BUSINESS = 70000;
    const DB_FREE_FEE = 3.5;

    const projected = {
      free: { ...CONSTANTS_TIERS_NG.free, price: 0, feePercentage: DB_FREE_FEE, feeFlat: 200 },
      growth: { ...CONSTANTS_TIERS_NG.growth, price: DB_GROWTH, feePercentage: 2.0, feeFlat: 75 },
      business: { ...CONSTANTS_TIERS_NG.business, price: DB_BUSINESS, feePercentage: 1.0, feeFlat: 100 },
    };

    const html = renderPlanToHTML({
      localTiers: projected,
    });

    // DB growth price (₦25,000) must appear
    expect(html).toContain('25,000');
    // DB business price (₦70,000) must appear
    expect(html).toContain('70,000');
    // DB free fee percentage (3.5%) must appear (React SSR may insert <!-- --> between text nodes)
    expect(html).toMatch(/3\.5.*%/);
    // Constants NG growth price (₦20,000) must NOT appear
    expect(html).not.toMatch(/20,000/);
  });

  it('Subscribe CTA contains exact DB fixture price for growth plan', () => {
    const DB_GROWTH = 35000;

    const projected = {
      free: { ...CONSTANTS_TIERS_NG.free, price: 0, feePercentage: 2.5, feeFlat: 150 },
      growth: { ...CONSTANTS_TIERS_NG.growth, price: DB_GROWTH, feePercentage: 1.5, feeFlat: 50 },
      business: { ...CONSTANTS_TIERS_NG.business, price: 60000, feePercentage: 1.5, feeFlat: 75 },
    };

    const html = renderPlanToHTML({
      localTiers: projected,
      selectedPlan: 'growth',
    });

    // Must contain "Subscribe" CTA with ₦35,000
    expect(html).toContain('Subscribe');
    expect(html).toContain('35,000');
  });

  it('free plan renders "Start Free Trial", not "Subscribe"', () => {
    const zeroed = {
      free: { ...CONSTANTS_TIERS_NG.free, price: 0, feePercentage: 0, feeFlat: 0 },
      growth: { ...CONSTANTS_TIERS_NG.growth, price: 0, feePercentage: 0, feeFlat: 0 },
      business: { ...CONSTANTS_TIERS_NG.business, price: 0, feePercentage: 0, feeFlat: 0 },
    };

    const html = renderPlanToHTML({
      localTiers: zeroed,
      selectedPlan: 'free',
    });

    expect(html).toContain('Start Free Trial');
  });

  it('zeroed tiers never show constants fee percentages (2.5%/1.5%)', () => {
    const zeroed = {
      free: { ...CONSTANTS_TIERS_NG.free, price: 0, feePercentage: 0, feeFlat: 0 },
      growth: { ...CONSTANTS_TIERS_NG.growth, price: 0, feePercentage: 0, feeFlat: 0 },
      business: { ...CONSTANTS_TIERS_NG.business, price: 0, feePercentage: 0, feeFlat: 0 },
    };

    const html = renderPlanToHTML({
      localTiers: zeroed,
    });

    // All fee% rendered should be 0%, not 2.5% or 1.5%
    expect(html).not.toContain('2.5%');
    expect(html).not.toContain('1.5%');
  });
});

describe('Onboarding pricing gate — production code proof', () => {
  it('features/plan/details steps all gated by pricingReady + PricingLoadingOrUnavailable', () => {
    const source = readFileSync(
      join(process.cwd(), 'app/get-started/OnboardingWizard.tsx'),
      'utf-8',
    );

    const featIdx = source.indexOf("step === 'features'");
    const planIdx = source.indexOf("step === 'plan'", featIdx + 1);
    const detailsIdx = source.indexOf("step === 'details'", planIdx + 1);
    const successIdx = source.indexOf("step === 'success'", detailsIdx + 1);

    expect(featIdx).toBeGreaterThan(-1);
    expect(planIdx).toBeGreaterThan(-1);
    expect(detailsIdx).toBeGreaterThan(-1);
    expect(successIdx).toBeGreaterThan(-1);

    const featuresBlock = source.slice(featIdx, planIdx);
    const planBlock = source.slice(planIdx, detailsIdx);
    const detailsBlock = source.slice(detailsIdx, successIdx);

    expect(featuresBlock).toContain('pricingReady');
    expect(featuresBlock).toContain('PricingLoadingOrUnavailable');
    expect(planBlock).toContain('pricingReady');
    expect(planBlock).toContain('PricingLoadingOrUnavailable');
    expect(detailsBlock).toContain('pricingReady');
    expect(detailsBlock).toContain('PricingLoadingOrUnavailable');
  });

  it('no ?? 20 annual discount fallback in wizard', () => {
    const source = readFileSync(
      join(process.cwd(), 'app/get-started/OnboardingWizard.tsx'),
      'utf-8',
    );
    expect(source).not.toMatch(/pricingProjection\?\.annualDiscountPercentage\b/);
    expect(source).not.toMatch(/annualDiscountPercentage.*\?\?\s*20/);
  });

  it('localTiers zeros commercial fields when projection absent', () => {
    const source = readFileSync(
      join(process.cwd(), 'app/get-started/OnboardingWizard.tsx'),
      'utf-8',
    );
    const memoBlock = source.slice(
      source.indexOf('const localTiers = useMemo'),
      source.indexOf('], [pricingProjection, selectedCountry]'),
    );
    expect(memoBlock).toContain('price: 0, feePercentage: 0, feeFlat: 0');
    expect(memoBlock).not.toMatch(/cp\.growth\?\.price\s*\?\?\s*base/);
  });
});

describe('No hardcoded commercial fee fallbacks in presentation', () => {
  it('StepFeatures has no hardcoded fee percentage fallbacks', () => {
    const source = readFileSync(join(process.cwd(), 'app/get-started/steps/StepFeatures.tsx'), 'utf-8');
    // Must not contain ?? 2, ?? 1.5, ?? 1 fee fallbacks
    expect(source).not.toMatch(/feePercentage\s*\?\?\s*\d/);
    // Must not contain || 0 price fallbacks in commercial display
    expect(source).not.toMatch(/localTiers\?\.growth\?\.price\)\s*\|\|\s*0/);
    expect(source).not.toMatch(/localTiers\?\.business\?\.price\)\s*\|\|\s*0/);
  });

  it('StepPlan has no hardcoded fee percentage fallbacks', () => {
    const source = readFileSync(join(process.cwd(), 'app/get-started/steps/StepPlan.tsx'), 'utf-8');
    expect(source).not.toMatch(/feePercentage\s*\?\?\s*\d/);
  });

  it('pricing page ROI calculator has no hardcoded fee fallback', () => {
    const source = readFileSync(join(process.cwd(), 'app/(marketing)/pricing/page.tsx'), 'utf-8');
    const roiSection = source.slice(source.indexOf('function RoiCalculator'));
    // Must not contain ?? 2.5 or any numeric fee fallback
    expect(roiSection).not.toMatch(/feePercentage\s*\?\?\s*[\d.]/);
    expect(roiSection).not.toMatch(/feeFlat\s*\?\?\s*\d/);
    expect(roiSection).not.toMatch(/price\s*\?\?\s*\d/);
  });

  it('pricing page fee estimates have no hardcoded fallback', () => {
    const source = readFileSync(join(process.cwd(), 'app/(marketing)/pricing/page.tsx'), 'utf-8');
    const feeSection = source.slice(source.indexOf('feeEstimates'), source.indexOf('feeEstimates') + 500);
    expect(feeSection).not.toMatch(/\?\?\s*\d/);
  });
});

describe('Annual billing is non-actionable / informational only', () => {
  it('pricing page has no annual toggle or selectable annual billing', () => {
    const source = readFileSync(join(process.cwd(), 'app/(marketing)/pricing/page.tsx'), 'utf-8');
    // No isAnnual state or toggle
    expect(source).not.toContain('isAnnual');
    expect(source).not.toContain("aria-label=\"Toggle annual billing\"");
    // No "/mo billed annually" actionable pricing
    expect(source).not.toContain('billed annually');
    // Annual discount is informational only ("coming soon")
    expect(source).toContain('coming soon');
  });

  it('StepPlan renders monthly-only prices, no annual branches', () => {
    const source = readFileSync(join(process.cwd(), 'app/get-started/steps/StepPlan.tsx'), 'utf-8');
    // No annual price computation or /year display
    expect(source).not.toContain('/year');
    expect(source).not.toContain('annualMultiplier');
    expect(source).not.toContain('Billed annually');
  });

  it('StepFeatures renders monthly-only prices, no annual branches', () => {
    const source = readFileSync(join(process.cwd(), 'app/get-started/steps/StepFeatures.tsx'), 'utf-8');
    expect(source).not.toContain('/year');
    expect(source).not.toContain('annualMultiplier');
  });

  it('StepPlan component renders only /mo prices, never /year', () => {
    const base = getPricingTiers('NG');
    const tiers = {
      free: { ...base.free, price: 0, feePercentage: 3.0, feeFlat: 0 },
      growth: { ...base.growth, price: 25000, feePercentage: 2.0, feeFlat: 75 },
      business: { ...base.business, price: 70000, feePercentage: 1.0, feeFlat: 100 },
    };

    const noop = () => {};
    const html = renderToString(
      React.createElement(StepPlan, {
        selectedPlan: 'growth',
        setSelectedPlan: noop,
        selectedCapabilities: [] as CapabilityId[],
        setSelectedCapabilities: noop as any,
        selectedCountry: 'NG' as CountryCode,
        requiredPlan: 'free',
        localTiers: tiers,
        setStep: noop as any,
      }),
    );

    // Must contain /mo, never /year
    expect(html).toContain('/mo');
    expect(html).not.toContain('/year');
    // Must not contain annual savings messaging
    expect(html).not.toContain('Save 25%');
  });
});
