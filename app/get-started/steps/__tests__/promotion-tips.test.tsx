// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { PromotionTips } from '../PromotionTips';
import { buildPromotionTips } from '../promotion-tips';

const link = 'https://wa.me/12029226251?text=BALASHOP';

describe('get-started promotion tips', () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it('gives product sellers Instagram, Status and parcel tips', () => {
    const tips = buildPromotionTips('shop', ['ordering'], 'BALASHOP', link);
    expect(tips).toHaveLength(3);
    expect(tips[0].copyText).toContain('Shop with us on WhatsApp');
    expect(tips[0].copyText).toContain(link);
    expect(tips[2].description).toContain('parcels');
  });

  it('uses category-specific language for food, events, giving and bookings', () => {
    expect(buildPromotionTips('restaurant', ['ordering'], 'Cafe', link)[0].copyText).toContain('Order with us');
    expect(buildPromotionTips('events', ['ticketing'], 'Show', link)[1].copyText).toContain('Get tickets');
    expect(buildPromotionTips('church', ['giving'], 'Giving', link)[0].copyText).toContain('Give or contribute');
    expect(buildPromotionTips('salon', ['appointment'], 'Salon', link)[0].copyText).toContain('Book with us');
  });

  it('falls back safely for unknown categories and preserves the provided link exactly', () => {
    const raw = 'https://wa.me/12029226251?text=A%26B';
    const tips = buildPromotionTips('', [], '  O\'Brien & Sons  ', raw);
    expect(tips[0].copyText).toContain('O\'Brien & Sons');
    expect(tips[0].copyText).toContain(raw);
    expect(tips[0].copyText).not.toContain('http://localhost');
  });

  it('copies Instagram text without posting to Instagram or changing the link', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window.navigator, 'clipboard', { configurable: true, value: { writeText } });
    render(<PromotionTips category="shop" capabilities={['ordering']} businessName="BALASHOP" waLink={link} />);
    expect(screen.getByText('Nothing is posted automatically.', { exact: false })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Copy bio text' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(expect.stringContaining(link)));
    expect(screen.getByRole('button', { name: 'Copied!' })).toBeTruthy();
  });

  it('shows a useful failure state when clipboard permission is denied', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('NotAllowedError'));
    Object.defineProperty(window.navigator, 'clipboard', { configurable: true, value: { writeText } });
    render(<PromotionTips category="events" capabilities={['ticketing']} businessName="Event" waLink={link} />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy status caption' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Could not copy'));
  });

  it('renders user names as text rather than executable HTML', () => {
    render(<PromotionTips category="shop" capabilities={['ordering']} businessName={'<img src=x onerror=alert(1)>'} waLink={link} />);
    expect(document.querySelector('img')).toBeNull();
  });
});
