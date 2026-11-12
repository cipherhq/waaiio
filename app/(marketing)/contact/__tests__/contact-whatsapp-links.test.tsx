// @vitest-environment jsdom
/**
 * Contact page: direct WhatsApp chat links (Owner request 2026-11-06).
 *
 * Renders the real page and checks both team WhatsApp links open a chat
 * directly, safely in a new tab, with a readable country label and number.
 * Also checks the existing contact details are still shown.
 */
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';

// The form (Turnstile, fetch) is not under test; a stub keeps the DOM small
// so role queries stay fast.
vi.mock('../ContactForm', () => ({ ContactForm: () => <form aria-label="contact form stub" /> }));

import ContactPage from '../page';

afterEach(() => cleanup());

const LINES = [
  { country: 'United States', display: '+1 571 274 6425', href: 'https://wa.me/15712746425' },
  { country: 'Nigeria', display: '+234 906 627 0361', href: 'https://wa.me/2349066270361' },
];

// First render in jsdom is slow on a cold start (~5s locally), so allow more time.
describe('Contact page WhatsApp chat links', { timeout: 20_000 }, () => {
  it('shows a "Chat with us on WhatsApp" section with exactly the two team lines', () => {
    render(<ContactPage />);
    const section = screen.getByRole('region', { name: 'Chat with us on WhatsApp' });
    const links = within(section).getAllByRole('link');
    expect(links.map((a) => a.getAttribute('href'))).toEqual(LINES.map((l) => l.href));
  });

  for (const line of LINES) {
    it(`links ${line.country} to ${line.href} with label and readable number`, () => {
      render(<ContactPage />);
      const section = screen.getByRole('region', { name: 'Chat with us on WhatsApp' });
      const link = within(section).getByRole('link', {
        name: `${line.country} ${line.display} (opens WhatsApp in a new tab)`,
      });

      expect(link.getAttribute('href')).toBe(line.href);
      expect(link.getAttribute('target')).toBe('_blank');
      const rel = (link.getAttribute('rel') ?? '').split(/\s+/);
      expect(rel).toContain('noopener');
      expect(rel).toContain('noreferrer');

      expect(within(link).getByText(line.country)).toBeTruthy();
      expect(within(link).getByText(line.display)).toBeTruthy();
      expect(link.className).toContain('bg-whatsapp');
    });
  }

  it('keeps the existing contact details on the page', () => {
    render(<ContactPage />);
    expect(screen.getAllByText('hello@waaiio.com')[0].closest('a')?.getAttribute('href')).toBe(
      'mailto:hello@waaiio.com',
    );
    const existingWhatsApp = screen.getByText('+1 (202) 922-6251').closest('a');
    expect(existingWhatsApp?.getAttribute('href')).toBe('https://wa.me/12029226251');
    expect(screen.getByText('Send us a message')).toBeTruthy();
    expect(screen.getByRole('form', { name: 'contact form stub' })).toBeTruthy();
  });
});
