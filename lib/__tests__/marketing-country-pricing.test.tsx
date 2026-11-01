// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import Footer from '@/components/marketing/Footer';
const route = vi.hoisted(() => ({ pathname: '/pricing' }));
vi.mock('next/navigation', () => ({ usePathname: () => route.pathname }));
import PricingPage from '@/app/(marketing)/pricing/page';

const countries = [
  { code: 'NG', name: 'Nigeria', flag: 'NG', pricing: { free: {price:0,feePercentage:2.5,feeFlat:0}, growth:{price:49000,feePercentage:1.5,feeFlat:0}, business:{price:99000,feePercentage:1,feeFlat:0} } },
  { code: 'US', name: 'United States', flag: 'US', pricing: { free: {price:0,feePercentage:2.5,feeFlat:0}, growth:{price:49,feePercentage:8,feeFlat:0}, business:{price:89.99,feePercentage:1,feeFlat:0} } },
];
const response = (index: number) => ({ ok: true, json: async () => ({trialDays:14,annualDiscountPercentage:0,tierFees:{free:{feePercentage:2.5},growth:{feePercentage:1.5},business:{feePercentage:1}},categoryFees:{},byoFeePolicy:'',country:countries[index],countries}) });
afterEach(() => { route.pathname = '/pricing'; cleanup(); vi.unstubAllGlobals(); });
describe('public country pricing', () => {
  it('shows only Nigeria even when the pricing API includes other countries', async () => {
    vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} });
    const fetchMock = vi.fn().mockResolvedValue(response(0));
    vi.stubGlobal('fetch', fetchMock);
    render(<PricingPage />);
    await screen.findByText('₦49,000');
    expect(screen.getByText('₦99,000')).toBeTruthy();
    expect(screen.getByText(/Available in Nigeria/)).toBeTruthy();
    expect(screen.getByText('Built for Nigeria')).toBeTruthy();
    expect(screen.queryByText(/United States|Ghana|5 Countries/)).toBeNull();
    expect(fetchMock).toHaveBeenCalledWith('/api/public/pricing?country=NG');
    expect(screen.getByText(/Connected merchants receive payments through their provider/)).toBeTruthy();
    expect(screen.getByText(/admin-controlled process with payment confirmation/)).toBeTruthy();
  });
  it('retries unavailable Nigeria pricing without falling back to another country', async () => {
    vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} });
    const fetchMock = vi.fn().mockRejectedValueOnce(new Error('unavailable')).mockResolvedValue(response(0));
    vi.stubGlobal('fetch', fetchMock);
    render(<PricingPage />);
    await screen.findByText('Pricing temporarily unavailable');
    fireEvent.click(screen.getByRole('button', { name: 'Try Again' }));
    await screen.findByText('₦49,000');
    expect(fetchMock.mock.calls.map(call => call[0])).toEqual([
      '/api/public/pricing?country=NG', '/api/public/pricing?country=NG',
    ]);
  });
});

describe('pricing footer country scope', () => {
  it('shows only Nigeria on the pricing page', () => {
    render(<Footer />);
    expect(screen.getByText('Nigeria')).toBeTruthy();
    expect(screen.queryByText('Ghana')).toBeNull();
    expect(screen.queryByText('US')).toBeNull();
    expect(screen.queryByText('UK')).toBeNull();
    expect(screen.queryByText('Canada')).toBeNull();
  });
  it('preserves the footer on other pages', () => {
    route.pathname = '/';
    render(<Footer />);
    expect(screen.getByText('Ghana')).toBeTruthy();
    expect(screen.getByText('Nigeria')).toBeTruthy();
  });
});
