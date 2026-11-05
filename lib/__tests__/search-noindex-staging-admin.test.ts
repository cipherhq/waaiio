import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { middleware } from '@/middleware';
import { STAGING_APP_PROJECT_ID, STAGING_SUPABASE_URL } from '@/lib/staging-test-mode';

// Keep staging (and both admin panels) out of search engines without
// changing anything the production merchant site sends to Google.

const auth = vi.hoisted(() => ({ getUser: vi.fn(), create: vi.fn() }));
vi.mock('@supabase/ssr', () => ({ createServerClient: auth.create }));

const PRODUCTION_PROJECT_ID = 'prj_QkvBTiDA905GHTwX5DQCJVyZzd9d';
const PRODUCTION_SUPABASE_URL = 'https://cxcmiqotkowhxinjbytg.supabase.co';

function settingsTable() {
  const chain = {
    select: () => chain,
    eq: () => chain,
    single: async () => ({ data: { value: false }, error: null }),
  };
  return chain;
}

let requestNumber = 0;
function get(host: string, path: string) {
  return new NextRequest(`https://${host}${path}`, {
    method: 'GET',
    headers: { 'x-request-id': `noindex-${++requestNumber}`, 'x-forwarded-for': `198.51.100.${requestNumber % 250}` },
  });
}

function useEnvironment(projectId: string, supabaseUrl: string) {
  vi.stubEnv('VERCEL_PROJECT_ID', projectId);
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', supabaseUrl);
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'test-anon-key');
}

beforeEach(() => {
  vi.clearAllMocks();
  auth.getUser.mockResolvedValue({ data: { user: null }, error: null });
  auth.create.mockReturnValue({ auth: { getUser: auth.getUser }, from: settingsTable });
});
afterEach(() => vi.unstubAllEnvs());

describe('staging merchant site — real middleware', () => {
  beforeEach(() => useEnvironment(STAGING_APP_PROJECT_ID, STAGING_SUPABASE_URL));

  it('serves a robots.txt that blocks every crawler from everything', async () => {
    const response = await middleware(get('staging.waaiio.com', '/robots.txt'));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('User-agent: *\nDisallow: /\n');
    expect(response.headers.get('Content-Type')).toBe('text/plain; charset=utf-8');
    expect(response.headers.get('X-Robots-Tag')).toBe('noindex, nofollow');
    expect(auth.create).not.toHaveBeenCalled();
  });

  it('publishes no sitemap', async () => {
    const response = await middleware(get('staging.waaiio.com', '/sitemap.xml'));
    expect(response.status).toBe(404);
    expect(response.headers.get('X-Robots-Tag')).toBe('noindex, nofollow');
  });

  it.each([
    ['staging.waaiio.com', '/'],
    ['staging.waaiio.com', '/pricing'],
    ['waaiio.vercel.app', '/'],
    ['staging.waaiio.com', '/api/release-identity'],
  ])('marks %s%s as noindex', async (host, path) => {
    const response = await middleware(get(host, path));
    expect(response.status).toBe(200);
    expect(response.headers.get('X-Robots-Tag')).toBe('noindex, nofollow');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
  });

  it('marks redirects as noindex too', async () => {
    const response = await middleware(get('staging.waaiio.com', '/dashboard'));
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toContain('/login');
    expect(response.headers.get('X-Robots-Tag')).toBe('noindex, nofollow');
  });
});

describe('production merchant site is unchanged — real middleware', () => {
  beforeEach(() => useEnvironment(PRODUCTION_PROJECT_ID, PRODUCTION_SUPABASE_URL));

  it.each(['/robots.txt', '/sitemap.xml'])('passes %s through to the normal Next.js route', async path => {
    const response = await middleware(get('www.waaiio.com', path));
    expect(response.status).toBe(200);
    expect(response.headers.get('x-middleware-next')).toBe('1');
    expect(response.headers.get('X-Robots-Tag')).toBeNull();
  });

  it.each(['/', '/pricing', '/b/some-business'])('sends no X-Robots-Tag on %s', async path => {
    const response = await middleware(get('www.waaiio.com', path));
    expect(response.status).toBe(200);
    expect(response.headers.get('X-Robots-Tag')).toBeNull();
  });

  it('does not treat a half-matching identity as staging', async () => {
    useEnvironment(STAGING_APP_PROJECT_ID, PRODUCTION_SUPABASE_URL);
    const robots = await middleware(get('www.waaiio.com', '/robots.txt'));
    expect(robots.headers.get('x-middleware-next')).toBe('1');
    const page = await middleware(get('www.waaiio.com', '/'));
    expect(page.headers.get('X-Robots-Tag')).toBeNull();
  });
});

describe('root layout robots meta tag', () => {
  async function loadMetadata() {
    vi.resetModules();
    vi.doMock('next/font/google', () => ({ Inter: () => ({ variable: 'font-inter', className: 'font-inter' }) }));
    vi.doMock('@/components/PostHogProvider', () => ({ PostHogProvider: () => null }));
    vi.doMock('@/components/marketing/CookieConsent', () => ({ default: () => null }));
    vi.doMock('@/app/globals.css', () => ({}));
    const layout = await import('@/app/layout');
    return layout.metadata;
  }

  it('is noindex, nofollow on staging', async () => {
    useEnvironment(STAGING_APP_PROJECT_ID, STAGING_SUPABASE_URL);
    expect((await loadMetadata()).robots).toEqual({ index: false, follow: false });
  });

  it('is absent on production, so pages stay indexable', async () => {
    useEnvironment(PRODUCTION_PROJECT_ID, PRODUCTION_SUPABASE_URL);
    const metadata = await loadMetadata();
    expect(metadata).not.toHaveProperty('robots');
    expect(metadata.alternates?.canonical).toBeDefined();
  });
});

describe('admin panel (production and staging) is never indexed', () => {
  const admin = (file: string) => readFileSync(resolve(process.cwd(), 'admin', file), 'utf8');

  it('sends X-Robots-Tag on every path', () => {
    const config = JSON.parse(admin('vercel.json'));
    const rule = config.headers.find((entry: { source: string }) => entry.source === '/(.*)');
    expect(rule.headers).toContainEqual({ key: 'X-Robots-Tag', value: 'noindex, nofollow' });
    // The single-page-app rewrite must stay in place.
    expect(config.rewrites).toEqual([{ source: '/(.*)', destination: '/index.html' }]);
  });

  it('ships a robots.txt that blocks everything', () => {
    expect(admin('public/robots.txt')).toBe('User-agent: *\nDisallow: /\n');
  });

  it('has a robots meta tag in the page', () => {
    expect(admin('index.html')).toContain('<meta name="robots" content="noindex, nofollow" />');
  });
});
