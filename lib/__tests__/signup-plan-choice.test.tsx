// @vitest-environment jsdom
import React, { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { StepFeatures } from '@/app/get-started/steps/StepFeatures';
import { StepPlan } from '@/app/get-started/steps/StepPlan';
import { getPricingTiers, type SubscriptionTier } from '@/lib/constants';
import { CAPABILITY_TIER_REQUIREMENTS, type CapabilityId } from '@/lib/capabilities/types';
import type { WizardStep } from '@/app/get-started/steps/types';

const pricing = getPricingTiers('NG');
const tiers = {
  ...pricing,
  free: { ...pricing.free, price: 0, feePercentage: 3.2, feeFlat: 20 },
  growth: { ...pricing.growth, price: 12000, feePercentage: 1.7, feeFlat: 0 },
  business: { ...pricing.business, price: 30000, feePercentage: 0.8, feeFlat: 10 },
};
const paidCapability = Object.entries(CAPABILITY_TIER_REQUIREMENTS).find(([, tier]) => tier === 'business')![0] as CapabilityId;
function Journey({ initialCapabilities = ['payment'] as CapabilityId[] }) {
  const [step, setStep] = useState<WizardStep>('features');
  const [selectedPlan, setSelectedPlan] = useState<SubscriptionTier>('free');
  const [selectedCapabilities, setSelectedCapabilities] = useState(initialCapabilities);
  const requiredPlan = selectedCapabilities.some(c => CAPABILITY_TIER_REQUIREMENTS[c] === 'business') ? 'business' : 'free';
  const props = { selectedPlan, setSelectedPlan, selectedCapabilities, setSelectedCapabilities, selectedCountry: 'NG' as const, requiredPlan: requiredPlan as SubscriptionTier, localTiers: tiers, setStep };
  return <>{step === 'features' ? <StepFeatures {...props} category="salon" /> : step === 'plan' ? <StepPlan {...props} /> : <><p>Details for {selectedPlan}</p><button onClick={() => setStep('plan')}>Back to plans</button></>}<output data-testid="capabilities">{selectedCapabilities.join(',')}</output></>;
}
afterEach(cleanup);
const openPlans = () => fireEvent.click(screen.getByRole('button', { name: 'Continue to plans' }));
describe('Signup explicit plan choice', () => {
  it('defaults Free, shows projected fees including flat charges and allows upgrading later', () => {
    render(<Journey />); openPlans();
    expect(screen.getByRole('button', { name: /Starter.*no monthly fee/ }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByText(/3.2% \+ ₦20 Waaiio fee/)).toBeTruthy();
    expect(screen.getByText(/1.7% Waaiio fee/)).toBeTruthy();
    expect(screen.getByText(/0.8% \+ ₦10 Waaiio fee/)).toBeTruthy();
    expect(screen.getByText(/Payment-provider processing charges are separate/)).toBeTruthy();
    // Owner 2026-11-08: Starter's fee applies from day one; the trial is for Pro & Premium features.
    expect(screen.getByText(/3.2% \+ ₦20 Waaiio fee per transaction from day one, plus payment gateway fees/)).toBeTruthy();
    expect(screen.queryByText(/after trial/)).toBeNull();
    expect(screen.getByText(/try every Pro and Premium feature free for 14 days/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Start free — upgrade later' }));
    expect(screen.getByText('Details for free')).toBeTruthy();
  }, 15000);
  it('allows paid fee savings with only free features and preserves choice on back', () => {
    render(<Journey />); openPlans();
    fireEvent.click(screen.getByRole('button', { name: /Premium.*₦30,000/ }));
    expect(screen.getByTestId('capabilities').textContent).toBe('payment');
    fireEvent.click(screen.getByRole('button', { name: 'Back' })); openPlans();
    expect(screen.getByRole('button', { name: /Premium.*₦30,000/ }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: /Continue with/ }));
    expect(screen.getByText('Details for business')).toBeTruthy();
    expect(screen.getByTestId('capabilities').textContent).toBe('payment');
  });
  it('keeps Free selected with paid features, discloses exclusions and filters on continuation', () => {
    render(<Journey initialCapabilities={['payment', paidCapability]} />); openPlans();
    expect(screen.getByText(/1 selected feature\(s\) require a higher plan/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Start free — upgrade later' }));
    expect(screen.getByTestId('capabilities').textContent).toBe('payment');
  });
  it('prevents an empty feature set after tier filtering', () => {
    render(<Journey initialCapabilities={[paidCapability]} />); openPlans();
    expect((screen.getByRole('button', { name: 'Start free — upgrade later' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: /Premium.*₦30,000/ }));
    expect((screen.getByRole('button', { name: /Continue with/ }) as HTMLButtonElement).disabled).toBe(false);
  });
});
