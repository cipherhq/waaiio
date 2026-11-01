// @vitest-environment jsdom
/**
 * Directory permanent link surface test.
 *
 * Verifies: no hardcoded US phone number, permanent Waaiio UUID link
 * used as primary href, no raw phone display in WhatsApp CTA.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';

const BIZ_ID = '550e8400-e29b-41d4-a716-446655440000';
const mockBusinesses = [
  {
    id: BIZ_ID,
    name: 'Test Biz',
    category: 'shop',
    country_code: 'NG',
    city: 'Lagos',
    address: '1 Test St',
    bot_code: 'TESTBIZ',
    wa_method: 'shared' as string | null,
    wa_phone: '+2348001234567' as string | null,
    slug: 'test-biz',
    services: [],
    capabilities: ['ordering', 'chat'],
    events: [],
  },
];

// The API exposes a phone only for the persisted ready channel assignment.
beforeEach(() => {
  mockBusinesses[0].wa_method = 'shared';
  mockBusinesses[0].wa_phone = '+2348001234567';
  mockBusinesses[0].bot_code = 'TESTBIZ';
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      businesses: mockBusinesses,
      categories: [{ key: 'shop', label: 'Shop', icon: '🛒' }],
      countries: [{ code: 'NG', name: 'Nigeria', flag: '🇳🇬' }],
    }),
  }));
});

vi.mock('next/link', () => ({
  default: ({ href, children, className }: { href: string; children: React.ReactNode; className?: string }) => (
    <a href={href} className={className}>{children}</a>
  ),
}));

import DirectoryClient from '../DirectoryClient';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('Directory permanent link surface', () => {
  it('does not display hardcoded US phone number (12029226251)', async () => {
    render(<DirectoryClient />);
    await waitFor(() => expect(screen.getByText('Test Biz')).toBeTruthy());
    const html = document.body.innerHTML;
    expect(html).not.toContain('12029226251');
    expect(html).not.toContain('1-202-922-6251');
  });

  it('WhatsApp button links to permanent Waaiio URL with business UUID', async () => {
    render(<DirectoryClient />);
    await waitFor(() => expect(screen.getByText('Test Biz')).toBeTruthy());
    const waBtn = screen.getByText('WhatsApp').closest('a');
    expect(waBtn).toBeTruthy();
    expect(waBtn!.getAttribute('href')).toBe(`https://www.waaiio.com/m/${BIZ_ID}`);
    // No wa.me direct link
    expect(waBtn!.getAttribute('href')).not.toContain('wa.me');
  });

  it('CTA says "Opens a WhatsApp conversation" not raw phone instructions', async () => {
    render(<DirectoryClient />);
    await waitFor(() => expect(screen.getByText('Test Biz')).toBeTruthy());
    expect(screen.getByText(/Opens a WhatsApp conversation/i)).toBeTruthy();
    expect(document.body.textContent).not.toContain('+2348001234567');
    // No "Text ... to +1-202..." instruction
    expect(screen.queryByText(/Text.*to.*\+1/)).toBeNull();
  });

  it('hides the WhatsApp CTA when the assigned shared channel is unavailable', async () => {
    // The directory API returns both fields null for an inactive/unready assignment.
    mockBusinesses[0].wa_method = null;
    mockBusinesses[0].wa_phone = null;
    render(<DirectoryClient />);
    await screen.findByText('Test Biz');
    expect(screen.getByText('WhatsApp connection unavailable')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'WhatsApp' })).toBeNull();
    expect(screen.queryByText(/Opens a WhatsApp conversation/i)).toBeNull();
  });

  it('hides the shared CTA without a business routing code even when its channel is ready', async () => {
    mockBusinesses[0].bot_code = '';
    render(<DirectoryClient />);
    await screen.findByText('Test Biz');
    expect(screen.getByText('WhatsApp connection unavailable')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'WhatsApp' })).toBeNull();
  });

});
