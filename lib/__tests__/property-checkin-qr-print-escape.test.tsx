// @vitest-environment jsdom
// The property check-in "Print QR" window is built with document.write. A
// merchant-controlled property name must be written as text, never as markup.
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const HOSTILE = '<img src=x onerror="alert(1)">Villa & "Sea" <b>';
const mocks = vi.hoisted(() => ({ name: '' }));

vi.mock('next/navigation', () => ({
  useParams: () => ({ id: 'property-1' }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('next/image', () => ({ default: () => null }));
vi.mock('@/components/dashboard/PageHelp', () => ({ PageHelp: () => null }));
vi.mock('qrcode', () => ({ toCanvas: vi.fn() }));
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    from: (table: string) => {
      const result = table === 'properties'
        ? { data: { id: 'property-1', name: mocks.name, description: null, property_type: 'apartment', price: 1000, deposit_amount: 0, max_guests: 2, bedrooms: 1, bathrooms: 1, amenities: [], photos: [], address: null, is_active: true } }
        : { data: [] };
      const chain: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'order']) chain[m] = () => chain;
      chain.single = () => Promise.resolve(result);
      chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve);
      return chain;
    },
  }),
}));

import PropertyDetailPage from '@/app/dashboard/properties/[id]/page';
import { DashboardProvider, type Business } from '@/components/dashboard/DashboardProvider';

const business = {
  id: 'business-1', owner_id: 'owner-1', name: 'Fixture business', description: '', address: '', city: '',
  phone: '', email: '', category: 'other', subscription_tier: 'free', country_code: 'NG', metadata: {},
  operating_hours: null, deposit_per_guest: 0, logo_url: null, capabilities: [], selectedCapabilities: [],
  pausedCapabilities: [], disabledCapabilities: [], capabilityOverrides: [],
} as unknown as Business;

describe('property check-in QR print window', () => {
  let written: string;
  beforeEach(() => {
    written = '';
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,QUJD');
    vi.spyOn(window, 'open').mockReturnValue({
      document: { write: (html: string) => { written += html; }, close: vi.fn() },
      print: vi.fn(),
    } as unknown as Window);
  });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  async function printWith(name: string) {
    mocks.name = name;
    render(<DashboardProvider business={business} userId="owner-1"><PropertyDetailPage /></DashboardProvider>);
    fireEvent.click(await screen.findByRole('button', { name: 'Show QR' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Print QR' }));
    return written;
  }

  it('writes a hostile property name as escaped text in the title and heading', async () => {
    const html = await printWith(HOSTILE);
    const escaped = '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;Villa &amp; &quot;Sea&quot; &lt;b&gt;';
    expect(html).toContain(`<title>Check-in QR - ${escaped}</title>`);
    expect(html).toContain(`<h2>${escaped}</h2>`);
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<b>');
    // The only image is the QR data URL.
    expect(html.match(/<img /g)).toHaveLength(1);
    expect(html).toContain('<img src="data:image/png;base64,QUJD" />');
    expect(html).toContain('https://waaiio.com/checkin/property/property-1');
  });

  it('leaves an ordinary property name unchanged', async () => {
    const html = await printWith('Sunset Villa');
    expect(html).toContain('<h2>Sunset Villa</h2>');
  });
});
