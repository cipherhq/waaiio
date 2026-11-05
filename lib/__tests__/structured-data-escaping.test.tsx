// Structured data (JSON-LD) on public pages is written into a <script> tag.
// Merchant-controlled text must stay inside that tag as data.
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { serializeJsonLd } from '@/lib/utils/json-ld';

const HOSTILE = '</script><script>window.__x=1</script><!-- & \u2028 \u2029 >';
const mocks = vi.hoisted(() => ({ text: '' }));

// Generic chainable Supabase double: every builder call returns itself; awaiting gives `result`.
function chain(result: unknown) {
  const c: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'in', 'order', 'gte', 'lte', 'limit', 'is', 'neq', 'or']) c[m] = () => c;
  c.single = () => Promise.resolve(result);
  c.maybeSingle = () => Promise.resolve(result);
  c.then = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve);
  return c;
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    from: (table: string) => table === 'events'
      ? chain({ data: {
          id: 'e1', name: mocks.text, description: mocks.text, date: '2030-01-01', time: '10:00', end_date: null, end_time: null,
          venue: mocks.text, total_tickets: 10, tickets_sold: 0, price: 5, image_url: null, max_per_order: null, slug: 'e',
          businesses: { id: 'b1', name: mocks.text, slug: 'b', logo_url: null, country_code: 'NG', payment_gateway: null },
          event_ticket_types: [],
        }, error: null })
      : chain({ data: [], error: null }),
    rpc: () => Promise.resolve({ data: [], error: null }),
  }),
}));
vi.mock('@/lib/supabase/safe-view-query', () => ({
  queryBusinessesPublic: async () => ({ data: {
    id: 'b1', name: mocks.text, slug: 'b', logo_url: null, description: mocks.text, address: mocks.text,
    operating_hours: null, country_code: 'NG',
  }, error: null }),
}));
vi.mock('@/app/b/[slug]/BookingForm', () => ({ default: () => null }));
vi.mock('@/app/e/[slug]/EventPurchaseForm', () => ({ default: () => null }));

import PublicBookingPage from '@/app/b/[slug]/page';
import PublicEventPage from '@/app/e/[slug]/page';

// Returns the text inside each <script type="application/ld+json"> in the rendered HTML.
function ldScripts(html: string): string[] {
  return [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map(m => m[1]);
}

type Page = (p: { params: Promise<{ slug: string }> }) => Promise<React.ReactElement>;
async function render(page: Page, text: string) {
  mocks.text = text;
  return renderToStaticMarkup(await page({ params: Promise.resolve({ slug: 's' }) }));
}

describe('serializeJsonLd', () => {
  it('escapes characters that could end the script tag, and parses back to the same value', () => {
    const value = { name: HOSTILE, nested: { list: [HOSTILE] } };
    const out = serializeJsonLd(value);
    expect(out).not.toMatch(/[<>&\u2028\u2029]/);
    expect(JSON.parse(out)).toEqual(value);
  });
  it('leaves ordinary data unchanged', () => {
    expect(serializeJsonLd({ name: 'Sunset Villa' })).toBe(JSON.stringify({ name: 'Sunset Villa' }));
  });
});

describe.each([
  ['public business page', PublicBookingPage as unknown as Page],
  ['public event page', PublicEventPage as unknown as Page],
])('%s structured data', (_label, page) => {
  it('keeps hostile business or event text inside one data tag', async () => {
    const html = await render(page, HOSTILE);
    const scripts = ldScripts(html);
    expect(scripts).toHaveLength(1);
    // No second script tag and no markup from the text reaches the page.
    expect(html.match(/<script/g)).toHaveLength(1);
    expect(html).not.toContain('window.__x=1</script>');
    expect(JSON.stringify(JSON.parse(scripts[0]))).toContain('window.__x=1');
  });
  it('renders ordinary text as before', async () => {
    const html = await render(page, 'Sunset Villa');
    expect(JSON.parse(ldScripts(html)[0]).name).toBe('Sunset Villa');
  });
});
