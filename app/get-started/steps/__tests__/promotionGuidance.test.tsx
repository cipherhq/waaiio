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
const permanentLink = 'https://www.waaiio.com/m/123e4567-e89b-12d3-a456-426614174000';

const props: StepSuccessProps = {
  loading: false,
  successData: { bot_code: 'SHOP-NOW', business_id: '123e4567-e89b-12d3-a456-426614174000' },
  waMethod: 'shared',
  waLink: permanentLink,
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
    // Permanent links are used for promotion captions
    expect(writeText).toHaveBeenCalledWith('Shop with us on WhatsApp: ' + permanentLink);
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

  it('shows account created (not live), QR, test link, and setup actions', () => {
    render(<StepSuccess {...props} />);
    expect(screen.getByText('Account created')).toBeTruthy();
    expect(screen.getByText(/permanent Waaiio link is ready/i)).toBeTruthy();
    expect(screen.queryByText("You're live!")).toBeNull();
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

  it('accepts a permanent Waaiio merchant link (base UUID only)', () => {
    const permanentMerchantLink = 'https://www.waaiio.com/m/550e8400-e29b-41d4-a716-446655440000';
    render(<StepSuccess {...props} waLink={permanentMerchantLink} />);
    expect(screen.getByRole('link', { name: 'Test on WhatsApp' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Copy Link' })).toBeTruthy();
    expect(screen.queryByText(/link is being set up/i)).toBeNull();
  });

  it('accepts staging Waaiio permanent links', () => {
    const stagingLink = 'https://staging.waaiio.com/m/550e8400-e29b-41d4-a716-446655440000';
    render(<StepSuccess {...props} waLink={stagingLink} />);
    expect(screen.getByRole('link', { name: 'Test on WhatsApp' })).toBeTruthy();
  });

  it.each([
    ['https://www.waaiio.com/m/550e8400-e29b-41d4-a716-446655440000/book', 'action suffix not accepted by StepSuccess'],
    ['https://www.waaiio.com/m/550e8400-e29b-41d4-a716-446655440000?redirect=x', 'query string'],
    ['https://www.waaiio.com/m/550e8400-e29b-41d4-a716-446655440000#frag', 'hash fragment'],
    ['https://evil-preview.vercel.app/m/550e8400-e29b-41d4-a716-446655440000', 'arbitrary vercel.app'],
    ['https://user:pass@www.waaiio.com/m/550e8400-e29b-41d4-a716-446655440000', 'credentials'],
    ['https://www.waaiio.com:8080/m/550e8400-e29b-41d4-a716-446655440000', 'non-standard port'],
  ])('rejects %s (%s)', (url) => {
    render(<StepSuccess {...props} waLink={url} />);
    expect(screen.queryByRole('link', { name: 'Test on WhatsApp' })).toBeNull();
    expect(screen.getByText(/link is being set up/i)).toBeTruthy();
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

describe('Resumed onboarding success — no raw phone fallback', () => {
  it('empty waLink (no business_id yet) shows pending, no raw phone or sharing', () => {
    render(<StepSuccess {...props} successData={null} waLink="" />);
    // No sharing content — successData is null shows error/pending branch
    expect(screen.queryByRole('link', { name: 'Test on WhatsApp' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Copy Link' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Download QR Code' })).toBeNull();
    // No raw phone numbers in output
    const html = document.body.innerHTML;
    expect(html).not.toContain('wa.me');
    expect(html).not.toContain('12029226251');
  });

  it('loading state shows verifying spinner, not share content', () => {
    render(<StepSuccess {...props} loading={true} successData={null} waLink="" />);
    expect(screen.getByText(/Verifying payment/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Copy Link' })).toBeNull();
  });

  it('confirmed permanent link shows QR and copy with exact UUID URL', () => {
    render(<StepSuccess {...props} />);
    expect(screen.getByRole('link', { name: 'Test on WhatsApp' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Copy Link' })).toBeTruthy();
    // The displayed link is the permanent Waaiio URL
    const html = document.body.innerHTML;
    expect(html).toContain(permanentLink);
    expect(html).not.toContain('wa.me/1202');
    expect(html).not.toContain('12029226251');
  });
});
