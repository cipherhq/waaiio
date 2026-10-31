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
    wa_method: 'shared',
    wa_phone: null,
    slug: 'test-biz',
    services: [],
    capabilities: ['ordering', 'chat'],
    events: [],
  },
];

// Mock fetch for directory API
global.fetch = vi.fn().mockResolvedValue({
  ok: true,
  json: async () => ({
    businesses: mockBusinesses,
    categories: [{ key: 'shop', label: 'Shop', icon: '🛒' }],
    countries: [{ code: 'NG', name: 'Nigeria', flag: '🇳🇬' }],
  }),
});

vi.mock('next/link', () => ({
  default: ({ href, children, className }: { href: string; children: React.ReactNode; className?: string }) => (
    <a href={href} className={className}>{children}</a>
  ),
}));

import DirectoryClient from '../DirectoryClient';

afterEach(() => cleanup());

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
    // No "Text ... to +1-202..." instruction
    expect(screen.queryByText(/Text.*to.*\+1/)).toBeNull();
  });
});
