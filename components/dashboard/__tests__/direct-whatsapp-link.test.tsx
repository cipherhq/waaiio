// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { DirectWhatsAppLink } from '../DirectWhatsAppLink';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const stub = (body: unknown, ok = true) => vi.stubGlobal('fetch', vi.fn(async () => ({ ok, json: async () => body })));

describe('overview direct WhatsApp link', () => {
  it('shows the server-verified link as plain text with why the Waaiio link is preferred', async () => {
    stub({ link: 'https://wa.me/2349037564008?text=CITADEL' });
    render(<DirectWhatsAppLink businessId="biz-1" />);
    expect(await screen.findByText('https://wa.me/2349037564008?text=CITADEL')).toBeTruthy();
    expect(screen.getByText(/Please share your Waaiio link instead/)).toBeTruthy();
    const box = screen.getByTestId('direct-whatsapp-link');
    expect(box.querySelector('button, input, a')).toBeNull();
    expect(box.querySelector('.select-none')).toBeTruthy();
  });
  it('shows nothing when the server has no working link', async () => {
    stub({ link: null });
    render(<DirectWhatsAppLink businessId="biz-1" />);
    await new Promise(r => setTimeout(r, 20));
    expect(screen.queryByTestId('direct-whatsapp-link')).toBeNull();
  });
  it('shows nothing when the request fails', async () => {
    stub({}, false);
    render(<DirectWhatsAppLink businessId="biz-1" />);
    await new Promise(r => setTimeout(r, 20));
    expect(screen.queryByTestId('direct-whatsapp-link')).toBeNull();
  });
});
