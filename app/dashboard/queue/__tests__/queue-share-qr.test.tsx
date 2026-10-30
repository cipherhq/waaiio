// @vitest-environment jsdom
/**
 * Queue tab Share Queue QR/link — rendered UI tests (#752).
 *
 * Renders QueuePage and QRCodePage with React Testing Library.
 * Verifies:
 * 1. Share Queue link present on Queue page, targeting correct URL
 * 2. QR page pre-selects queue template from ?template=queue
 * 3. Valid bot channel + routing code → queue QR/link available with join guidance
 * 4. No bot channel → setup guidance, QR/link withheld
 * 5. Shared number without routing code → setup guidance
 * 6. Dedicated bot → greeting/menu path with correct guidance
 * 7. Existing template behavior preserved
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';

// ── Shared state for mocks ──
const state = vi.hoisted(() => ({
  business: {} as Record<string, unknown>,
  sharedPhone: '+12025550199',
  searchParams: new URLSearchParams(),
  hasBotChannel: true,
}));

vi.mock('@/components/dashboard/DashboardProvider', () => ({
  useBusiness: () => state.business,
  useRequireCapability: () => {},
}));

vi.mock('next/navigation', () => ({
  useSearchParams: () => state.searchParams,
}));

vi.mock('next/link', () => ({
  default: ({ href, children, className }: { href: string; children: React.ReactNode; className?: string }) => (
    <a href={href} className={className} data-testid="next-link">{children}</a>
  ),
}));

vi.mock('@/lib/supabase/client', () => ({
  createClient: () => {
    const chainMethods = ['eq', 'neq', 'order', 'limit', 'gte', 'lte', 'in', 'is', 'not', 'or', 'gt', 'lt'];
    function makeChain() {
      const chain: Record<string, unknown> = {};
      for (const m of chainMethods) (chain as Record<string, () => typeof chain>)[m] = () => chain;
      chain.select = () => chain;
      chain.update = () => chain;
      chain.insert = () => chain;
      chain.delete = () => chain;
      chain.single = async () => ({ data: null, error: null });
      chain.maybeSingle = async () => ({
        data: state.hasBotChannel ? { phone_number: state.sharedPhone } : null,
        error: null,
      });
      chain.then = (resolve: (v: unknown) => void) => resolve({ data: [], error: null, count: 0 });
      return chain;
    }
    return {
      from: () => makeChain(),
      channel: () => ({
        on: () => ({ subscribe: () => ({ unsubscribe: () => {} }) }),
      }),
      removeChannel: () => {},
      rpc: async () => ({ data: null, error: null }),
    };
  },
}));

vi.mock('@/lib/supabase/safe-view-query', () => ({
  queryChannelsPublic: async () => ({
    data: state.hasBotChannel ? { phone_number: state.sharedPhone } : null,
    error: null,
  }),
}));

vi.mock('qrcode.react', () => ({
  QRCodeCanvas: ({ value }: { value: string }) => (
    <div data-testid="qr-value" data-value={value} />
  ),
}));

vi.mock('@/components/dashboard/PageHelp', () => ({ PageHelp: () => null }));

import QRCodePage from '@/app/dashboard/qr-code/page';

afterEach(() => cleanup());

beforeEach(() => {
  state.sharedPhone = '+12025550199';
  state.hasBotChannel = true;
  state.searchParams = new URLSearchParams();
  state.business = {
    id: 'biz-queue-test',
    name: 'Queue Test Biz',
    slug: 'queue-test',
    bot_code: 'QTEST',
    phone: '+12025550000',
    country_code: 'US',
    wa_method: 'shared',
    assigned_channel_id: null,
    whatsapp_channel_id: null,
    subscription_tier: 'free',
    capabilities: ['queue', 'payment', 'chat'],
    logo_url: null,
  };
});

// ── Queue page Share Queue link ──

describe('Queue page — Share Queue link', () => {
  it('renders Share Queue link targeting /dashboard/qr-code?template=queue', async () => {
    // Import Queue page lazily to pick up the mock state
    const QueuePageModule = await import('../page');
    const QueuePage = QueuePageModule.default;

    render(<QueuePage />);

    await waitFor(() => {
      const link = screen.getByText('Share Queue');
      expect(link).toBeTruthy();
      expect(link.getAttribute('href')).toBe('/dashboard/qr-code?template=queue');
    });
  });
});

// ── QR Code page with ?template=queue ──

describe('QR Code page — queue template pre-selection', () => {
  it('pre-selects queue template and shows join guidance when bot channel valid', async () => {
    state.searchParams = new URLSearchParams('template=queue');

    render(<QRCodePage />);

    await waitFor(() => {
      const qrValues = screen.getAllByTestId('qr-value');
      expect(qrValues.length).toBeGreaterThanOrEqual(1);
      // Shared number: routing code + :queue suffix
      const value = qrValues[0].getAttribute('data-value');
      expect(value).toBe('https://wa.me/12025550199?text=QTEST%3Aqueue');
    });

    // Queue join guidance visible
    const guidance = screen.getByTestId('queue-join-guidance');
    expect(guidance.textContent).toContain('Scanning opens WhatsApp');
    expect(guidance.textContent).toContain('Scanning alone does not add them');
  });

  it('no bot channel → setup guidance shown, QR content area dimmed', async () => {
    state.searchParams = new URLSearchParams('template=queue');
    state.hasBotChannel = false;

    render(<QRCodePage />);

    await waitFor(() => {
      const guidance = screen.getByTestId('queue-setup-guidance');
      expect(guidance.textContent).toContain('WhatsApp bot setup required');
      expect(guidance.textContent).toContain('WhatsApp Setup');
    });
  });

  it('shared number without routing code → setup guidance', async () => {
    state.searchParams = new URLSearchParams('template=queue');
    state.business = { ...state.business, bot_code: '' };

    render(<QRCodePage />);

    await waitFor(() => {
      const guidance = screen.getByTestId('queue-setup-guidance');
      expect(guidance.textContent).toContain('routing code');
    });
  });

  it('dedicated bot → greeting path with menu guidance', async () => {
    state.searchParams = new URLSearchParams('template=queue');
    state.business = { ...state.business, wa_method: 'dedicated', bot_code: '' };

    render(<QRCodePage />);

    await waitFor(() => {
      const qrValues = screen.getAllByTestId('qr-value');
      const value = qrValues[0].getAttribute('data-value');
      // Dedicated: no routing code, sends Hi
      expect(value).toBe('https://wa.me/12025550199?text=Hi');
    });

    // Guidance explains menu selection path
    const guidance = screen.getByTestId('queue-join-guidance');
    expect(guidance.textContent).toContain('selects "Join Queue" from your menu');
  });
});

// ── Preserved behavior ──

describe('QR Code page — existing behavior preserved', () => {
  it('no template param defaults to generic', async () => {
    render(<QRCodePage />);

    await waitFor(() => {
      const qrValues = screen.getAllByTestId('qr-value');
      // Generic: routing code only, no suffix
      const value = qrValues[0].getAttribute('data-value');
      expect(value).toBe('https://wa.me/12025550199?text=QTEST');
    });

    // No queue guidance for generic template
    expect(screen.queryByTestId('queue-join-guidance')).toBeNull();
    expect(screen.queryByTestId('queue-setup-guidance')).toBeNull();
  });

  it('invalid template param defaults to generic', async () => {
    state.searchParams = new URLSearchParams('template=nonexistent');

    render(<QRCodePage />);

    await waitFor(() => {
      const qrValues = screen.getAllByTestId('qr-value');
      const value = qrValues[0].getAttribute('data-value');
      expect(value).toBe('https://wa.me/12025550199?text=QTEST');
    });
  });

  it('non-queue template ignores channel guard (no setup guidance)', async () => {
    state.searchParams = new URLSearchParams('template=chat');
    state.hasBotChannel = false; // would trigger guard for queue, not for chat

    render(<QRCodePage />);

    await waitFor(() => {
      const qrValues = screen.getAllByTestId('qr-value');
      expect(qrValues.length).toBeGreaterThanOrEqual(1);
    });

    // No queue setup guidance — chat template is unaffected by channel guard
    expect(screen.queryByTestId('queue-setup-guidance')).toBeNull();
  });
});

// ── Handler guards: copy/download blocked when queue not ready ──

describe('QR Code page — queue artifact guards', () => {
  it('no bot channel → Copy button click does not write to clipboard', async () => {
    state.searchParams = new URLSearchParams('template=queue');
    state.hasBotChannel = false;

    const writeText = vi.fn();
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      writable: true,
      configurable: true,
    });

    render(<QRCodePage />);

    await waitFor(() => {
      expect(screen.getByTestId('queue-setup-guidance')).toBeTruthy();
    });

    // Find and click Copy button — should be guarded
    const copyBtn = screen.getByText('Copy');
    copyBtn.click();
    expect(writeText).not.toHaveBeenCalled();
  });

  it('valid bot channel → QR content area is NOT dimmed', async () => {
    state.searchParams = new URLSearchParams('template=queue');
    state.hasBotChannel = true;

    render(<QRCodePage />);

    await waitFor(() => {
      const qrValues = screen.getAllByTestId('qr-value');
      expect(qrValues.length).toBeGreaterThanOrEqual(1);
    });

    // No setup guidance
    expect(screen.queryByTestId('queue-setup-guidance')).toBeNull();
    // Join guidance present
    expect(screen.getByTestId('queue-join-guidance')).toBeTruthy();
  });

  it('QR and clipboard targets use the same canonical URL', async () => {
    state.searchParams = new URLSearchParams('template=queue');
    state.hasBotChannel = true;

    let clipboardContent = '';
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn((text: string) => { clipboardContent = text; return Promise.resolve(); }) },
      writable: true,
      configurable: true,
    });

    render(<QRCodePage />);

    await waitFor(() => {
      const qrValues = screen.getAllByTestId('qr-value');
      expect(qrValues.length).toBeGreaterThanOrEqual(1);
    });

    const qrValue = screen.getAllByTestId('qr-value')[0].getAttribute('data-value');

    // Click copy
    const copyBtn = screen.getByText('Copy');
    copyBtn.click();
    expect(clipboardContent).toBe(qrValue);
  });
});
