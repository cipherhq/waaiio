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
    ['other', ['ordering'], 'Packaging & receipts', 'Shop with us'],
    ['other', ['scheduling'], 'Front desk & Google profile', 'Book with us'],
    ['other', [], 'WhatsApp Status', 'Reach us'],
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
    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/couldn't copy/i));
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
