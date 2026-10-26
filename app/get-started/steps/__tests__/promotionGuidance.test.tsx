// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { getPromotionGuidance } from '../promotionGuidance';
import { StepSuccess } from '../StepSuccess';
import type { StepSuccessProps } from '../types';

vi.mock('qrcode.react', () => ({
  QRCodeSVG: () => <span>Test QR</span>,
  QRCodeCanvas: () => <canvas />,
}));

const link = 'https://wa.me/15551234567?text=SHOP-NOW';

const props: StepSuccessProps = {
  loading: false,
  successData: { bot_code: 'SHOP-NOW', business_id: 'test-business' },
  waMethod: 'shared',
  waLink: link,
  category: 'shop',
  selectedCapabilities: ['ordering'],
  error: '',
  setStep: vi.fn(),
  setError: vi.fn(),
  fbConnectionData: null,
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('Signup success promotion guidance', () => {
  it.each([
    ['shop', ['ordering'], 'Instagram & TikTok bio', 'Shop with us'],
    ['restaurant', ['ordering', 'scheduling'], 'Menu & counter QR', 'See our menu'],
    ['barber', ['appointment'], 'Instagram booking bio', 'Book with us'],
    ['events', ['ticketing'], 'Flyers & posters', 'Find our events'],
    ['church', ['giving'], 'Bulletins & programs', 'Support us'],
    ['', ['ordering'], 'Packaging & receipts', 'Shop with us'],
    ['', ['scheduling'], 'Front desk & Google profile', 'Book with us'],
    ['', [], 'WhatsApp Status', 'Reach us'],
  ] as const)('adapts %s / %s guidance', (category, capabilities, suggestedPlace, captionStart) => {
    const guidance = getPromotionGuidance(category, [...capabilities], link);
    expect(guidance.tips.some(tip => tip.title === suggestedPlace)).toBe(true);
    expect(guidance.caption).toBe(captionStart + (captionStart === 'See our menu' ? ' on WhatsApp: ' : captionStart === 'Find our events' ? ' on WhatsApp: ' : captionStart === 'Support us' ? ' on WhatsApp: ' : captionStart === 'Reach us' ? ' on WhatsApp: ' : ' on WhatsApp: ') + link);
  });

  it('preserves the exact bot-specific link, including encoding', () => {
    const exactLink = 'https://wa.me/2348001234567?text=AB%20CD%26EF';
    expect(getPromotionGuidance('shop', ['ordering'], exactLink).caption.endsWith(exactLink)).toBe(true);
  });

  it('copies the ready-to-share message and confirms only after clipboard success', async () => {
    let finishCopy!: () => void;
    const writeText = vi.fn(() => new Promise<void>(resolve => { finishCopy = resolve; }));
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    render(<StepSuccess {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy message' }));
    expect(writeText).toHaveBeenCalledWith('Shop with us on WhatsApp: ' + link);
    expect(screen.queryByText('Message copied!')).toBeNull();
    finishCopy();
    await waitFor(() => expect(screen.getByText('Message copied!')).toBeTruthy());
  });

  it('reports clipboard failure without claiming the message copied', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('Clipboard blocked'));
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    render(<StepSuccess {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy message' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/couldn't copy/i));
    expect(screen.queryByText('Message copied!')).toBeNull();
  });

  it('keeps the existing QR, WhatsApp test, and setup actions', () => {
    render(<StepSuccess {...props} />);
    expect(screen.getByRole('button', { name: 'Download QR Code' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Test on WhatsApp' })).toBeTruthy();
    expect(screen.getByRole('link', { name: /Connect WhatsApp Number/ })).toBeTruthy();
    expect(screen.getByText('Set up your bot')).toBeTruthy();
  });
});

describe('URL safety guard', () => {
  it('accepts a valid wa.me link with encoded query parameters', () => {
    const validLink = 'https://wa.me/2348001234567?text=Hello%20World%26Order';
    render(<StepSuccess {...props} waLink={validLink} />);
    expect(screen.getByRole('link', { name: 'Test on WhatsApp' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Copy Link' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Copy message' })).toBeTruthy();
    expect(screen.queryByText(/link is being set up/i)).toBeNull();
  });

  it('accepts a plain wa.me link without query parameters', () => {
    render(<StepSuccess {...props} waLink="https://wa.me/15551234567" />);
    expect(screen.getByRole('link', { name: 'Test on WhatsApp' })).toBeTruthy();
  });

  it.each([
    ['javascript:alert(1)', 'javascript scheme'],
    ['data:text/html,<script>alert(1)</script>', 'data scheme'],
    ['http://wa.me/1234567890', 'non-HTTPS'],
    ['https://evil.com/1234567890', 'unexpected host'],
    ['https://wa.me.evil.com/1234567890', 'host suffix attack'],
    ['https://user:pass@wa.me/1234567890', 'credentials in URL'],
    ['https://wa.me:8080/1234567890', 'unexpected port'],
    ['https://wa.me/1234567890/extra/path', 'trailing path content'],
    ['https://wa.me/', 'missing phone number'],
    ['https://wa.me/abc', 'non-digit phone path'],
    ['not-a-url', 'unparseable string'],
    ['', 'empty string'],
  ])('rejects %s (%s) — hides sharing actions, shows explanation', (_url, _reason) => {
    render(<StepSuccess {...props} waLink={_url} />);
    // Sharing actions must not be rendered
    expect(screen.queryByRole('link', { name: 'Test on WhatsApp' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Copy Link' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Copy message' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Download QR Code' })).toBeNull();
    // Explanation is shown
    expect(screen.getByText(/link is being set up/i)).toBeTruthy();
    // Existing non-sharing actions are preserved
    expect(screen.getByRole('link', { name: /Connect WhatsApp Number/ })).toBeTruthy();
    expect(screen.getByText('Set up your bot')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Go to Dashboard' })).toBeTruthy();
  });

  it('preserves encoded query params through the full copy chain', async () => {
    const encoded = 'https://wa.me/2348001234567?text=A%20B%26C';
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    render(<StepSuccess {...props} waLink={encoded} />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy Link' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(encoded));
  });
});
