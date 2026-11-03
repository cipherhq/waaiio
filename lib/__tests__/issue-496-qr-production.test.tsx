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

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
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

/** Get all rendered QR values — production renders multiple QR instances sharing the same canonical URL */
function allQrValues(): string[] {
  return screen.getAllByTestId('qr-value').map(el => el.getAttribute('data-value') || '');
}

describe('#496 QR production routing safety', () => {
  // QR codes now encode permanent Waaiio links /m/{uuid}[/{action}].
  // Server-side resolves to shared bot_code:capability / dedicated ?text=Hi.
  // Handler tests in permanent-merchant-links.test.ts verify redirect semantics.

  const base = () => `https://www.waaiio.com/m/${state.business.id}`;

  it('generic template encodes base permanent link (no action suffix)', async () => {
    render(<QRCodePage />);
    await waitFor(() => {
      for (const v of allQrValues()) expect(v).toBe(base());
    });
  });

  it('template change updates action suffix in permanent link', async () => {
    render(<QRCodePage />);
    await waitFor(() => { for (const v of allQrValues()) expect(v).toBe(base()); });

    fireEvent.click(screen.getByRole('button', { name: /Scan to Pay/i }));
    await waitFor(() => { for (const v of allQrValues()) expect(v).toBe(`${base()}/pay`); });

    fireEvent.click(screen.getByRole('button', { name: /Scan to Chat/i }));
    await waitFor(() => { for (const v of allQrValues()) expect(v).toBe(`${base()}/chat`); });
  });

  it('dedicated business uses same permanent link pattern (no bot_code leak)', async () => {
    state.business = { ...state.business, wa_method: 'dedicated', bot_code: 'SHOULD_NOT_APPEAR' };
    render(<QRCodePage />);
    await waitFor(() => {
      for (const v of allQrValues()) {
        expect(v).toBe(base());
        expect(v).not.toContain('SHOULD_NOT_APPEAR');
        expect(v).not.toContain('wa.me');
      }
    });
  });

  it('poster preview shows permanent link, not raw phone number', async () => {
    render(<QRCodePage />);
    await waitFor(() => expect(allQrValues().length).toBeGreaterThanOrEqual(1));
    const html = document.body.innerHTML;
    // Preview fallback section: permanent URL, not raw phone
    expect(html).toContain('Or open this link');
    expect(html).toContain(base());
    expect(html).not.toContain('Or send a message to');
    // No hardcoded US fallback number
    expect(html).not.toContain('12025550199');
    expect(html).not.toContain('+12025550000'); // business.phone
  });
});
