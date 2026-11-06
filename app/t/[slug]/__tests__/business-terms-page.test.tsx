/**
 * /t/[slug] — public business terms page (the link the bot sends as "📎 Terms:").
 *
 * Renders the real server component with a fake service client and the real
 * next/navigation notFound()/redirect(), so the 404 and the fallback redirect
 * are the same signals Next.js acts on.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

const db = vi.hoisted(() => ({
  result: { data: null as unknown, error: null as unknown },
  calls: [] as Array<[string, ...unknown[]]>,
}));

vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => {
    const chain = {
      select: (cols: string) => { db.calls.push(['select', cols]); return chain; },
      eq: (col: string, val: unknown) => { db.calls.push(['eq', col, val]); return chain; },
      maybeSingle: async () => db.result,
    };
    return { from: (table: string) => { db.calls.push(['from', table]); return chain; } };
  },
}));

import BusinessTermsPage, { generateMetadata } from '../page';

function params(slug: string) {
  return { params: Promise.resolve({ slug }) };
}

async function renderPage(slug: string): Promise<string> {
  return renderToStaticMarkup(await BusinessTermsPage(params(slug)));
}

async function navigationSignal(slug: string): Promise<string> {
  try {
    await BusinessTermsPage(params(slug));
  } catch (e) {
    return String((e as { digest?: string }).digest);
  }
  throw new Error('expected notFound() or redirect()');
}

beforeEach(() => {
  db.result = { data: null, error: null };
  db.calls = [];
});

describe('/t/[slug] business terms page', () => {
  it("renders the business's own terms text", async () => {
    db.result = {
      data: { name: 'Test Salon', terms_text: 'No refunds within 24 hours.\nArrive 10 minutes early.', require_terms: null },
      error: null,
    };

    const html = await renderPage('test-salon');

    expect(html).toContain('Test Salon');
    expect(html).toContain('Terms &amp; Conditions');
    expect(html).toContain('No refunds within 24 hours.\nArrive 10 minutes early.');
    expect(html).toContain('href="/terms"');
  });

  it('reads one active business by slug, selecting only its name and two metadata keys', async () => {
    db.result = { data: { name: 'Test Salon', terms_text: 'Policy', require_terms: 'true' }, error: null };

    await renderPage('test-salon');

    expect(db.calls).toEqual([
      ['from', 'businesses'],
      ['select', 'name, terms_text:metadata->>terms_text, require_terms:metadata->>require_terms_before_payment'],
      ['eq', 'slug', 'test-salon'],
      ['eq', 'status', 'active'],
    ]);
  });

  it('shows merchant text as text, never as HTML', async () => {
    db.result = { data: { name: 'Biz', terms_text: '<script>alert(1)</script><b>x</b>', require_terms: null }, error: null };

    const html = await renderPage('biz');

    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<b>x</b>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it("falls back to Waaiio's /terms when the business has no terms text", async () => {
    db.result = { data: { name: 'Test Salon', terms_text: null, require_terms: null }, error: null };
    expect(await navigationSignal('test-salon')).toMatch(/^NEXT_REDIRECT;replace;\/terms;307;/);
  });

  it("falls back to Waaiio's /terms when the terms text is only whitespace", async () => {
    db.result = { data: { name: 'Test Salon', terms_text: '   \n ', require_terms: null }, error: null };
    expect(await navigationSignal('test-salon')).toMatch(/^NEXT_REDIRECT;replace;\/terms;/);
  });

  it('does not show saved text once the merchant has switched terms off', async () => {
    db.result = { data: { name: 'Test Salon', terms_text: 'Old policy', require_terms: 'false' }, error: null };
    expect(await navigationSignal('test-salon')).toMatch(/^NEXT_REDIRECT;replace;\/terms;/);
  });

  it('returns 404 for an unknown or inactive slug', async () => {
    db.result = { data: null, error: null };
    expect(await navigationSignal('no-such-business')).toBe('NEXT_HTTP_ERROR_FALLBACK;404');
  });

  it('returns 404 for a malformed slug without querying the database', async () => {
    expect(await navigationSignal('bad slug/../x')).toBe('NEXT_HTTP_ERROR_FALLBACK;404');
    expect(db.calls).toEqual([]);
  });

  it('a database error is an error, not a 404 or a silent fallback', async () => {
    db.result = { data: null, error: { message: 'boom' } };
    await expect(BusinessTermsPage(params('test-salon'))).rejects.toThrow('Could not load business terms');
  });

  it('page title names the business; unknown slug gets a not-found title', async () => {
    db.result = { data: { name: 'Test Salon', terms_text: 'Policy', require_terms: null }, error: null };
    expect((await generateMetadata(params('test-salon'))).title).toBe('Test Salon — Terms & Conditions | Waaiio');

    db.result = { data: null, error: null };
    expect((await generateMetadata(params('nope'))).title).toBe('Not Found | Waaiio');
  });
});
