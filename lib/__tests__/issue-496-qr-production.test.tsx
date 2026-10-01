// @vitest-environment jsdom

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const state = vi.hoisted(() => ({
  business: {} as Record<string, unknown>,
  sharedPhone: '+12025550199',
}));

vi.mock('@/components/dashboard/DashboardProvider', () => ({
  useBusiness: () => state.business,
}));

vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    from: () => ({
      select: () => {
        const chain = {
          eq: () => chain,
          limit: () => chain,
          maybeSingle: async () => ({ data: null, error: null }),
        };
        return chain;
      },
    }),
  }),
}));

vi.mock('@/lib/supabase/safe-view-query', () => ({
  queryChannelsPublic: async () => ({
    data: { phone_number: state.sharedPhone },
    error: null,
  }),
}));

vi.mock('qrcode.react', () => ({
  QRCodeCanvas: ({ value }: { value: string }) => (
    <div data-testid="qr-value" data-value={value} />
  ),
}));

vi.mock('@/components/dashboard/PageHelp', () => ({
  PageHelp: () => null,
}));

import QRCodePage from '@/app/dashboard/qr-code/page';

afterEach(() => cleanup());

beforeEach(() => {
  state.sharedPhone = '+12025550199';
  state.business = {
    id: '11111111-1111-4111-8111-111111111111',
    name: 'QR Test Business',
    slug: 'qr-test-business',
    bot_code: 'TESTBIZ',
    phone: '+12025550000',
    country_code: 'US',
    wa_method: 'shared',
    assigned_channel_id: null,
    whatsapp_channel_id: null,
    subscription_tier: 'free',
    capabilities: ['payment', 'chat'],
    logo_url: null,
  };
});

function qrValue(): string {
  return screen.getByTestId('qr-value').getAttribute('data-value') || '';
}

describe('#496 QR production routing safety', () => {
  it('preserves the shared-number routing code in the production generic QR link', async () => {
    render(<QRCodePage />);

    await waitFor(() => {
      expect(qrValue()).toBe('https://wa.me/12025550199?text=TESTBIZ');
    });
  });

  it('keeps routing code immutable while adding production template suffixes', async () => {
    render(<QRCodePage />);

    await waitFor(() => expect(qrValue()).toContain('text=TESTBIZ'));

    fireEvent.click(screen.getByRole('button', { name: /Scan to Pay/i }));
    await waitFor(() => {
      expect(qrValue()).toBe('https://wa.me/12025550199?text=TESTBIZ%3Apayment');
    });

    fireEvent.click(screen.getByRole('button', { name: /Scan to Chat/i }));
    await waitFor(() => {
      expect(qrValue()).toBe('https://wa.me/12025550199?text=TESTBIZ%3Achat');
    });
  });

  it('does not inject a routing code for a dedicated-number business', async () => {
    state.business = {
      ...state.business,
      wa_method: 'dedicated',
      bot_code: 'SHOULD_NOT_APPEAR',
    };

    render(<QRCodePage />);

    await waitFor(() => {
      expect(qrValue()).toBe('https://wa.me/12025550199?text=Hi');
      expect(qrValue()).not.toContain('SHOULD_NOT_APPEAR');
    });
  });
});
