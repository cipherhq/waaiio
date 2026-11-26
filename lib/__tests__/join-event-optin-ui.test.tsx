// @vitest-environment jsdom
/**
 * Join-event page success screen, rendered with fetch mocked: a new guest gets
 * their own RSVP buttons; a guest already on the list is pointed to WhatsApp.
 */
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ optin: {} as Record<string, unknown> }));
vi.mock('next/navigation', () => ({ useParams: () => ({ id: 'p1' }) }));
vi.mock('@/components/auth/PhoneInput', () => ({
  PhoneInput: ({ value, onChange }: { value: string; onChange: (v: string) => void }) =>
    <input aria-label="phone" value={value} onChange={e => onChange(e.target.value)} />,
}));

import PublicInvitePage from '@/app/join-event/[id]/page';

const event = {
  id: 'p1', name: 'Party', date: '2026-12-01', time: null, venue: null, description: null, image_url: null,
  invite_message: null, type: 'party', host_name: 'Host', business_name: 'Biz', business_country: 'NG', subscription_tier: 'free',
};

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const body = String(url).startsWith('/api/invite-details') ? { event } : state.optin;
    return { ok: true, json: async () => body } as Response;
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

async function submit() {
  render(<PublicInvitePage />);
  const phone = await screen.findByLabelText('phone');
  fireEvent.change(phone, { target: { value: '08031234567' } });
  fireEvent.submit(phone.closest('form')!);
}

describe('join-event success screen', () => {
  it('new guest: shows their WhatsApp and web RSVP buttons', async () => {
    state.optin = { success: true, whatsapp_sent: true, rsvp_url: 'https://x/rsvp/' + 'n'.repeat(24), invite_token: 'n'.repeat(24), wa_number: '2349010000000' };
    await submit();
    await waitFor(() => expect(screen.getByText("You're in!")).toBeTruthy());
    expect(screen.getByText('RSVP on WhatsApp').closest('a')?.getAttribute('href')).toContain('n'.repeat(24));
    expect(screen.getByText('Or RSVP on Web').closest('a')?.getAttribute('href')).toBe('https://x/rsvp/' + 'n'.repeat(24));
  });

  it('guest already on the list: no RSVP buttons, pointed to WhatsApp', async () => {
    state.optin = { success: true, already_invited: true, whatsapp_sent: true };
    await submit();
    await waitFor(() => expect(screen.getByText("You're on the list!")).toBeTruthy());
    expect(screen.getByText("We've sent your RSVP link to your WhatsApp. Open it there to reply or change your answer.")).toBeTruthy();
    expect(screen.queryByText('RSVP on WhatsApp')).toBeNull();
    expect(screen.queryByText('Or RSVP on Web')).toBeNull();
  });

  it('guest already on the list, message not sent: no RSVP buttons, no false "sent" claim', async () => {
    state.optin = { success: true, already_invited: true, whatsapp_sent: false };
    await submit();
    await waitFor(() => expect(screen.getByText("You're on the list!")).toBeTruthy());
    expect(screen.getByText('Check your WhatsApp for your RSVP link.')).toBeTruthy();
    expect(screen.queryByText(/We've sent/)).toBeNull();
    expect(screen.queryByText('RSVP on WhatsApp')).toBeNull();
    expect(screen.queryByText('Or RSVP on Web')).toBeNull();
  });
});
