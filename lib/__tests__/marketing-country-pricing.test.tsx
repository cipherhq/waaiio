// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import PricingPage from '@/app/(marketing)/pricing/page';

const countries = [
  { code: 'NG', name: 'Nigeria', flag: 'NG', pricing: { free: {price:0,feePercentage:2.5,feeFlat:0}, growth:{price:49000,feePercentage:1.5,feeFlat:0}, business:{price:99000,feePercentage:1,feeFlat:0} } },
  { code: 'US', name: 'United States', flag: 'US', pricing: { free: {price:0,feePercentage:2.5,feeFlat:0}, growth:{price:49,feePercentage:8,feeFlat:0}, business:{price:89.99,feePercentage:1,feeFlat:0} } },
];
const response = (index: number) => ({ ok: true, json: async () => ({trialDays:14,annualDiscountPercentage:0,tierFees:{free:{feePercentage:2.5},growth:{feePercentage:1.5},business:{feePercentage:1}},categoryFees:{},byoFeePolicy:'',country:countries[index],countries}) });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
describe('public country pricing', () => {
  it('hides old-country prices while the selected country loads, then uses its values', async () => {
    vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} });
    let finish!: (value: unknown) => void;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(response(0)).mockImplementationOnce(() => new Promise(resolve => { finish=resolve; })));
    render(<PricingPage />);
    await screen.findByText('₦49,000');
    fireEvent.click(screen.getByRole('button', {name:/US\s*United States/}));
    expect(screen.queryByText('$49,000')).toBeNull();
    expect(screen.getByText('Loading pricing...')).toBeTruthy();
    await act(async () => { finish(response(1)); });
    await screen.findByText('$49');
    expect(screen.queryByText('₦49,000')).toBeNull();
    expect(screen.queryByText('8%')).toBeNull();
    expect(screen.getAllByText('1.5%').length).toBeGreaterThan(0);
  });
});
