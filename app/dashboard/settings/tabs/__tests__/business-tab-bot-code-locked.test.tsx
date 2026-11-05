// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Owner decision 2026-11-03: bot codes are locked; owners cannot edit them in Settings.
const writes = vi.hoisted(() => [] as Array<{ table: string; payload: unknown }>);
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    from: (table: string) => {
      const chain: Record<string, any> = {};
      for (const key of ['select', 'eq', 'neq', 'order', 'limit']) chain[key] = () => chain;
      chain.maybeSingle = () => Promise.resolve({ data: null, error: null });
      chain.update = (payload: unknown) => { writes.push({ table, payload }); return chain; };
      chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(resolve);
      return chain;
    },
  }),
}));
vi.mock('@/hooks/useCategoryConfig', () => ({ useCategoryConfig: () => ({ labels: { personLabel: 'guest', entityNamePlural: 'bookings' } }) }));
vi.mock('@/components/auth/PhoneInput', () => ({ PhoneInput: () => null }));
vi.mock('@/components/ui/PlacesAutocomplete', () => ({ default: () => null }));
vi.mock('next/image', () => ({ default: () => null }));

import { BusinessTab } from '@/app/dashboard/settings/tabs/BusinessTab';

afterEach(cleanup);

describe('Settings: WhatsApp name (bot code) is read-only', () => {
  it('shows the code with a contact-support note and no edit control', () => {
    const props = {
      business: { id: 'business-1', name: 'Citadel', slug: 'citadel', bot_code: 'CITADEL', status: 'active', address: '', city: '', phone: '', email: '', description: '', subscription_tier: 'free', category: 'other', metadata: {} },
      capabilities: [], country: 'NG', curr: 'NGN', saving: false, saved: false,
      setSaving: vi.fn(), setSaved: vi.fn(), openSections: ['profile'], toggleSection: vi.fn(),
    } as unknown as React.ComponentProps<typeof BusinessTab>;
    render(<BusinessTab {...props} />);
    expect(screen.getByText('CITADEL')).toBeTruthy();
    expect(screen.getByText(/contact support if you need a different name/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(screen.queryByPlaceholderText('YOUR-BOT-CODE')).toBeNull();
    expect(writes.filter(w => w.table === 'businesses' && JSON.stringify(w.payload).includes('bot_code'))).toEqual([]);
  });

  it('source no longer writes bot_code from the browser', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync('app/dashboard/settings/tabs/BusinessTab.tsx', 'utf8');
    expect(src).not.toMatch(/update\(\{\s*bot_code/);
  });
});
