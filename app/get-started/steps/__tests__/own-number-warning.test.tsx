// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';

vi.mock('@/components/auth/PhoneInput', () => ({ PhoneInput: () => null }));
vi.mock('@/components/ui/AddressAutocomplete', () => ({ default: () => null }));
vi.mock('qrcode.react', () => ({ QRCodeSVG: () => null, QRCodeCanvas: () => null }));
const { StepDetails } = await import('../StepDetails');
const { StepSuccess } = await import('../StepSuccess');

const WARNING = 'Use a brand-new number that has never had WhatsApp — for example a new SIM. This is the only way we support. A number that already has WhatsApp or WhatsApp Business on it will not connect.';
afterEach(cleanup);

// Every prop the details step needs: no-op setters, empty values.
const detailsProps = new Proxy({ waMethod: 'transfer', selectedCountry: 'NG', selectedPlan: 'free', discoveredWabas: [], nameCheckStatus: 'idle', botCodeStatus: 'idle', fbConnectionData: null } as Record<string, unknown>, {
  get: (t, k: string) => (k in t ? t[k] : /^(set|handle|on)/.test(k) ? () => {} : typeof k === 'string' && /^(fb|agreed|loading)/.test(k) ? false : ''),
  has: () => true,
});

describe('own WhatsApp number: only a brand-new number works', () => {
  it('signup details: the own-number option and its note carry the warning; no "existing number" promise', () => {
    render(<StepDetails {...(detailsProps as any)} />);
    expect(screen.getByText('Needs a brand-new number that has never had WhatsApp (for example a new SIM)')).toBeTruthy();
    expect(screen.getByTestId('own-number-warning').textContent?.trim()).toBe(WARNING);
    expect(screen.queryByText(/existing business or personal number/)).toBeNull();
  });
  it('success screen shows the warning next to "Connect Your Own WhatsApp Number"', () => {
    render(<StepSuccess loading={false} successData={{ bot_code: 'CITADEL', business_id: '123e4567-e89b-12d3-a456-426614174000' }} waMethod="shared" waLink="https://www.waaiio.com/m/CITADEL" qrLink="https://www.waaiio.com/m/123e4567-e89b-12d3-a456-426614174000" category="shop" selectedCapabilities={['ordering']} error="" setStep={vi.fn()} setError={vi.fn()} fbConnectionData={null} />);
    expect(screen.getByTestId('own-number-warning').textContent?.trim()).toBe(WARNING);
  });
  it('dashboard connect page and signup plan panel use the approved wording', () => {
    const connect = readFileSync('app/dashboard/whatsapp/connect/page.tsx', 'utf8');
    expect(connect).toContain(WARNING);
    expect(connect).not.toContain('Add or connect your own number');
    const wizard = readFileSync('app/get-started/OnboardingWizard.tsx', 'utf8');
    expect(wizard).toContain("'Connect your own WhatsApp number on any plan'");
    expect(wizard).not.toContain('Pro & Premium: connect your own WhatsApp number');
  });
});
