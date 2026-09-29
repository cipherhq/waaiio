/**
 * #467 — Payment short-link hardening tests.
 *
 * Covers:
 * 1.  Paystack + stored checkout_url → 302 exact stored URL
 * 2.  Stripe + stored checkout_url → 302 exact stored URL
 * 3.  Paystack no checkout_url + access_code → 302 access-code URL
 * 4.  Paystack no checkout_url + no access_code → safe failure, never fabricated gateway-reference URL
 * 5.  Canonical short-link generation uses www.waaiio.com when production env is apex
 * 6.  Non-production/custom origins are preserved
 * 7.  Both shared-payment generation sites covered
 * 8.  Recurring/payment.flow short-link site covered
 * 9.  Pending payment reuse does not initialize provider again
 * 10. Shared + dedicated WhatsApp channel/origin behavior unchanged
 * 11. Payment-success callback generation unchanged by this PR
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── 1. canonicalPublicOrigin tests ──

describe('#467 canonicalPublicOrigin', () => {
  const originalEnv = process.env.NEXT_PUBLIC_APP_URL;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.NEXT_PUBLIC_APP_URL;
    } else {
      process.env.NEXT_PUBLIC_APP_URL = originalEnv;
    }
    vi.resetModules();
  });

  it('normalizes production apex https://waaiio.com to https://www.waaiio.com', async () => {
    process.env.NEXT_PUBLIC_APP_URL = 'https://waaiio.com';
    const { canonicalPublicOrigin } = await import('@/lib/url');
    expect(canonicalPublicOrigin()).toBe('https://www.waaiio.com');
  });

  it('preserves www origin unchanged', async () => {
    process.env.NEXT_PUBLIC_APP_URL = 'https://www.waaiio.com';
    const { canonicalPublicOrigin } = await import('@/lib/url');
    expect(canonicalPublicOrigin()).toBe('https://www.waaiio.com');
  });

  it('preserves custom/staging origins unchanged', async () => {
    process.env.NEXT_PUBLIC_APP_URL = 'https://staging.waaiio.com';
    const { canonicalPublicOrigin } = await import('@/lib/url');
    expect(canonicalPublicOrigin()).toBe('https://staging.waaiio.com');
  });

  it('preserves localhost dev origins unchanged', async () => {
    process.env.NEXT_PUBLIC_APP_URL = 'http://localhost:3000';
    const { canonicalPublicOrigin } = await import('@/lib/url');
    expect(canonicalPublicOrigin()).toBe('http://localhost:3000');
  });

  it('falls back to https://www.waaiio.com when env is unset', async () => {
    delete process.env.NEXT_PUBLIC_APP_URL;
    const { canonicalPublicOrigin } = await import('@/lib/url');
    expect(canonicalPublicOrigin()).toBe('https://www.waaiio.com');
  });
});

// ── 2. /api/pay route redirect tests ──

describe('#467 /api/pay route — redirect status and Paystack fallback', () => {
  // Verify the route source code directly for redirect behavior.
  // We test the route handler by importing it and calling with mock requests.

  let routeModule: { GET: (req: import('next/server').NextRequest) => Promise<import('next/server').NextResponse> };
  const mockMaybeSingle = vi.fn();
  const mockSelect = vi.fn();

  beforeEach(async () => {
    vi.resetModules();

    // Build a chainable Supabase query mock
    const chainable = () => {
      const q: Record<string, unknown> = {};
      for (const m of ['select', 'like', 'eq', 'order', 'limit']) {
        q[m] = vi.fn().mockReturnValue(q);
      }
      q.maybeSingle = mockMaybeSingle;
      mockSelect.mockReturnValue(q);
      return q;
    };

    vi.doMock('@/lib/supabase/service', () => ({
      createServiceClient: () => ({
        from: vi.fn().mockReturnValue({ select: vi.fn().mockReturnValue(chainable()) }),
      }),
    }));

    routeModule = await import('@/app/api/pay/route');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makeRequest(ref: string): import('next/server').NextRequest {
    const { NextRequest } = require('next/server');
    return new NextRequest(new URL(`https://www.waaiio.com/api/pay?ref=${ref}`));
  }

  it('Paystack + stored checkout_url → 302 redirect to exact stored URL', async () => {
    const storedUrl = 'https://checkout.paystack.com/ac_test_exact_url';
    mockMaybeSingle.mockResolvedValueOnce({
      data: {
        gateway: 'paystack',
        gateway_reference: 'WA-PY-1234',
        metadata: { checkout_url: storedUrl },
      },
    });

    const res = await routeModule.GET(makeRequest('-PY-1234'));
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(storedUrl);
  });

  it('Stripe + stored checkout_url → 302 redirect to exact stored URL', async () => {
    const storedUrl = 'https://checkout.stripe.com/c/pay/cs_live_test123';
    mockMaybeSingle.mockResolvedValueOnce({
      data: {
        gateway: 'stripe',
        gateway_reference: 'cs_live_test1234567890ab',
        metadata: { checkout_url: storedUrl },
      },
    });

    const res = await routeModule.GET(makeRequest('7890ab'));
    // Ref too short (6 chars is min), should still work
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(storedUrl);
  });

  it('Paystack no checkout_url + access_code → 302 redirect to access-code URL', async () => {
    mockMaybeSingle.mockResolvedValueOnce({
      data: {
        gateway: 'paystack',
        gateway_reference: 'WA-PY-5678',
        metadata: { access_code: 'ac_live_xyz789' },
      },
    });

    const res = await routeModule.GET(makeRequest('-PY-5678'));
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://checkout.paystack.com/ac_live_xyz789');
  });

  it('Paystack no checkout_url + no access_code → safe failure, never fabricated URL', async () => {
    mockMaybeSingle.mockResolvedValueOnce({
      data: {
        gateway: 'paystack',
        gateway_reference: 'WA-PY-9999',
        metadata: {},
      },
    });

    const res = await routeModule.GET(makeRequest('-PY-9999'));
    expect(res.status).toBe(302);
    const location = res.headers.get('location')!;
    // Must NOT contain the gateway_reference fabricated as a checkout URL
    expect(location).not.toContain('checkout.paystack.com/WA-PY-9999');
    expect(location).not.toContain('checkout.paystack.com/' + 'WA-PY-9999');
    // Should redirect to safe failure page
    expect(location).toContain('/payment-success');
    expect(location).toContain('error=link-expired');
  });

  it('all redirects use explicit 302 status (no default 307)', async () => {
    // No payment found → fallback redirect
    mockMaybeSingle
      .mockResolvedValueOnce({ data: null })  // payment lookup
      .mockResolvedValueOnce({ data: null }); // booking lookup

    const res = await routeModule.GET(makeRequest('NOSUCH'));
    expect(res.status).toBe(302);
    expect(res.status).not.toBe(307);
  });

  it('short ref under 6 chars → 302 redirect to homepage', async () => {
    const res = await routeModule.GET(makeRequest('ABC'));
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('/');
  });
});

// ── 3. Short-link generation in shared/payment.ts ──

describe('#467 short-link generation — canonical origin', () => {
  const originalEnv = process.env.NEXT_PUBLIC_APP_URL;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.NEXT_PUBLIC_APP_URL;
    } else {
      process.env.NEXT_PUBLIC_APP_URL = originalEnv;
    }
  });

  it('shared/payment.ts imports canonicalPublicOrigin from @/lib/url', async () => {
    const source = await import('fs').then(fs =>
      fs.readFileSync(require('path').resolve(__dirname, '../bot/flows/shared/payment.ts'), 'utf-8')
    );
    expect(source).toContain("import { canonicalPublicOrigin } from '@/lib/url'");
    // Must NOT use raw process.env.NEXT_PUBLIC_APP_URL for short-link generation
    // (may appear in other contexts like callback URLs — that's OK and out of scope)
    const shortLinkLines = source.split('\n').filter(l => l.includes('/api/pay?ref='));
    for (const line of shortLinkLines) {
      expect(line).toContain('appUrl');
      expect(line).not.toContain('process.env');
    }
  });

  it('payment.flow.ts imports canonicalPublicOrigin from @/lib/url', async () => {
    const source = await import('fs').then(fs =>
      fs.readFileSync(require('path').resolve(__dirname, '../bot/flows/payment.flow.ts'), 'utf-8')
    );
    expect(source).toContain("import { canonicalPublicOrigin } from '@/lib/url'");
    // The recurring Stripe short-link site must use canonicalPublicOrigin
    const shortLinkLines = source.split('\n').filter(l => l.includes('/api/pay?ref='));
    for (const line of shortLinkLines) {
      expect(line).toContain('appUrl');
      expect(line).not.toContain('process.env');
    }
  });

  it('short links use www.waaiio.com when NEXT_PUBLIC_APP_URL is apex', async () => {
    process.env.NEXT_PUBLIC_APP_URL = 'https://waaiio.com';
    vi.resetModules();
    const { canonicalPublicOrigin } = await import('@/lib/url');
    const appUrl = canonicalPublicOrigin();
    const shortRef = 'WA-PY-2828'.slice(-8);
    const url = `${appUrl}/api/pay?ref=${shortRef}`;
    expect(url).toBe('https://www.waaiio.com/api/pay?ref=-PY-2828');
    expect(url).not.toContain('https://waaiio.com/api');
  });
});

// ── 4. Pending payment reuse — no provider reinitialization ──

describe('#467 pending payment reuse — no provider reinitialization', () => {
  it('shared/payment.ts reuse path returns existing checkout URL without calling provider', async () => {
    const source = await import('fs').then(fs =>
      fs.readFileSync(require('path').resolve(__dirname, '../bot/flows/shared/payment.ts'), 'utf-8')
    );
    // The reuse path (existingPayment with checkout_url) must return early
    // before any gateway.initializePayment call
    const lines = source.split('\n');
    const reuseLine = lines.findIndex(l => l.includes('Reusing existing pending payment'));
    const initLine = lines.findIndex(l => l.includes('gateway.initializePayment('));
    expect(reuseLine).toBeGreaterThan(0);
    expect(initLine).toBeGreaterThan(0);
    // Reuse return must come BEFORE provider initialization
    expect(reuseLine).toBeLessThan(initLine);
  });
});

// ── 5. WhatsApp channel/origin persistence unchanged ──

describe('#467 WhatsApp channel/origin persistence unchanged', () => {
  it('shared/payment.ts reuse path still persists _inbound_channel_id and _confirmation_origin', async () => {
    const source = await import('fs').then(fs =>
      fs.readFileSync(require('path').resolve(__dirname, '../bot/flows/shared/payment.ts'), 'utf-8')
    );
    // Channel persistence on reuse must still be present
    expect(source).toContain('_inbound_channel_id');
    expect(source).toContain('_confirmation_origin');
    // WhatsApp fail-closed behavior must still be present
    expect(source).toContain("opts.confirmationOrigin === 'whatsapp'");
  });
});

// ── 6. Payment-success callback unchanged ──

describe('#467 payment-success callback generation unchanged', () => {
  it('Paystack callback_url construction is NOT modified by this PR', async () => {
    const source = await import('fs').then(fs =>
      fs.readFileSync(require('path').resolve(__dirname, '../payments/paystack.ts'), 'utf-8')
    );
    // callback_url must still use process.env.NEXT_PUBLIC_APP_URL (not canonicalPublicOrigin)
    // because callback URLs are provider-stored and follow a different lifecycle
    expect(source).toContain("callback_url: `${process.env.NEXT_PUBLIC_APP_URL");
    expect(source).toContain('/payment-success?ref=');
    // Must NOT import canonicalPublicOrigin
    expect(source).not.toContain('canonicalPublicOrigin');
  });
});

// ── 7. /api/pay route never fabricates checkout.paystack.com/<gateway_reference> ──

describe('#467 /api/pay route — no fabricated Paystack URLs', () => {
  it('route source does not contain checkout.paystack.com/${payment.gateway_reference}', async () => {
    const source = await import('fs').then(fs =>
      fs.readFileSync(require('path').resolve(__dirname, '../../app/api/pay/route.ts'), 'utf-8')
    );
    // Must never fabricate checkout URL from gateway_reference
    expect(source).not.toContain('checkout.paystack.com/${payment.gateway_reference}');
    // Must use access_code for Paystack fallback
    expect(source).toContain('access_code');
    expect(source).toContain('checkout.paystack.com/${accessCode}');
    // All redirects must specify explicit 302
    const redirectLines = source.split('\n').filter(l => l.includes('NextResponse.redirect('));
    for (const line of redirectLines) {
      expect(line).toContain('302');
    }
  });
});
