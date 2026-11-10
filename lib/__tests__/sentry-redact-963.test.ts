/**
 * #963: private intake link tokens are scrubbed from everything sent to Sentry
 * (errors, transactions, spans, breadcrumbs) by every runtime's config.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { privateLinkScrubbers, redactPrivateLinkPath, scrubPrivateLinks } from '@/lib/sentry-redact';

const TOKEN = 'Ab3dEf_ghIjKlMnOpQrStUvWxYz0123456789-xyz';

describe('redactPrivateLinkPath', () => {
  it('replaces the token in page and API paths, absolute or relative', () => {
    expect(redactPrivateLinkPath(`https://waaiio.com/intake/${TOKEN}`)).toBe('https://waaiio.com/intake/[token]');
    expect(redactPrivateLinkPath(`/api/intake/${TOKEN}?x=1#y`)).toBe('/api/intake/[token]?x=1#y');
    expect(redactPrivateLinkPath(`GET /intake/${TOKEN} 200`)).toBe('GET /intake/[token] 200');
    for (const [input, out] of [
      [`fetch failed (https://w.com/api/intake/${TOKEN})`, 'fetch failed (https://w.com/api/intake/[token])'],
      [`see /intake/${TOKEN}.`, 'see /intake/[token].'],
      [`a /intake/${TOKEN}, b`, 'a /intake/[token], b'],
      [`url=/intake/${TOKEN}&x`, 'url=/intake/[token]&x'],
      [`/intake/${TOKEN}%20`, '/intake/[token]%20'],
    ]) expect(redactPrivateLinkPath(input)).toBe(out);
  });

  it('leaves other paths alone', () => {
    for (const s of ['/intakes/abc', '/form/abc', '/dashboard/forms', 'https://waaiio.com/', './lib/intake/answers.ts',
      'components/intake/IntakeFormView.tsx', '/intake/short', '/intake/[token]']) {
      expect(redactPrivateLinkPath(s)).toBe(s);
    }
  });
});

describe('scrubPrivateLinks', () => {
  it('scrubs every string in an event, transaction, span and breadcrumb', () => {
    const event = {
      request: { url: `https://waaiio.com/intake/${TOKEN}` },
      transaction: `/intake/${TOKEN}`,
      spans: [{ data: { 'url.full': `https://waaiio.com/api/intake/${TOKEN}`, 'url.path': `/api/intake/${TOKEN}` } }],
      breadcrumbs: [{ category: 'navigation', data: { from: '/', to: `/intake/${TOKEN}` } }],
      exception: { values: [{ value: `fetch failed for /api/intake/${TOKEN}` }] },
      count: 3,
      flag: true,
    };
    const out = scrubPrivateLinks(event);
    expect(JSON.stringify(out)).not.toContain(TOKEN);
    expect(out.request.url).toBe('https://waaiio.com/intake/[token]');
    expect(out.count).toBe(3);
    expect(out.flag).toBe(true);
  });

  it("never changes the caller's objects (console breadcrumbs carry the app's own logged values)", () => {
    const logged = { url: `https://waaiio.com/intake/${TOKEN}`, nested: [{ to: `/intake/${TOKEN}` }] };
    const breadcrumb = { category: 'console', message: 'sending intake', data: { arguments: [logged] } };
    const out = scrubPrivateLinks(breadcrumb);
    expect(logged.url).toBe(`https://waaiio.com/intake/${TOKEN}`);
    expect(logged.nested[0].to).toBe(`/intake/${TOKEN}`);
    expect(JSON.stringify(out)).not.toContain(TOKEN);
  });

  it('handles null, frozen objects, class instances and cycles without throwing', () => {
    expect(scrubPrivateLinks(null)).toBeNull();
    const frozen = Object.freeze({ url: `/intake/${TOKEN}` });
    expect(scrubPrivateLinks(frozen).url).toBe('/intake/[token]');
    expect(frozen.url).toBe(`/intake/${TOKEN}`);
    const err = new Error('x');
    expect(scrubPrivateLinks({ err }).err).toBe(err);
    const a: Record<string, unknown> = { url: `/intake/${TOKEN}` };
    a.self = a;
    const out = scrubPrivateLinks(a) as Record<string, unknown>;
    expect(out.url).toBe('/intake/[token]');
    expect(out.self).toBe(out);
    expect(a.url).toBe(`/intake/${TOKEN}`);
  });

  it('is wired into the client, server and edge Sentry configs', () => {
    expect(Object.keys(privateLinkScrubbers).sort()).toEqual(['beforeBreadcrumb', 'beforeSend', 'beforeSendSpan']);
    for (const file of ['sentry.client.config.ts', 'sentry.server.config.ts', 'sentry.edge.config.ts']) {
      const src = readFileSync(file, 'utf8');
      expect(src, file).toContain("import { privateLinkScrubbers } from './lib/sentry-redact';");
      expect(src, file).toContain('...privateLinkScrubbers,');
    }
  });
});
