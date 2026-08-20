/**
 * Product event instrumentation tests.
 * Behavioral tests for sanitizer, interceptor, and source-contract verification.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  PRODUCT_EVENTS,
  getTestRunId,
  sanitizeEventProps,
  getBrowserTestRunId,
  installTestRunFetchInterceptor,
  _resetInterceptorForTest,
  captureProductEvent,
} from '@/lib/observability/product-events';

describe('test_run_id propagation', () => {
  it('extracts from request headers when present', () => {
    const request = { headers: { get: (name: string) => name === 'x-test-run-id' ? 'run-abc' : null } };
    expect(getTestRunId(request)).toBe('run-abc');
  });

  it('returns undefined when absent (normal traffic)', () => {
    expect(getTestRunId({ headers: { get: () => null } })).toBeUndefined();
  });

  it('returns undefined for empty header', () => {
    expect(getTestRunId({ headers: { get: (n: string) => n === 'x-test-run-id' ? '' : null } })).toBeUndefined();
  });
});

describe('event name stability', () => {
  it('all canonical events have stable dot-separated names', () => {
    const events = Object.values(PRODUCT_EVENTS);
    expect(events.length).toBeGreaterThanOrEqual(23);
    for (const name of events) {
      expect(name).toMatch(/^[a-z_]+\.[a-z_]+$/);
    }
  });

  it('critical events exist', () => {
    expect(PRODUCT_EVENTS.BUSINESS_CREATED).toBe('business.created');
    expect(PRODUCT_EVENTS.PAYMENT_COMPLETED).toBe('payment.completed');
    expect(PRODUCT_EVENTS.PAYMENT_FAILED).toBe('payment.failed');
    expect(PRODUCT_EVENTS.PAYMENT_FINALIZATION_FAILED).toBe('payment.finalization_failed');
    expect(PRODUCT_EVENTS.PROMO_WINNER_FULFILLED).toBe('promo.winner_fulfilled');
    expect(PRODUCT_EVENTS.CAPABILITY_ENABLED).toBe('capability.enabled');
    expect(PRODUCT_EVENTS.CAPABILITY_DISABLED).toBe('capability.disabled');
    expect(PRODUCT_EVENTS.PRODUCT_CREATED).toBe('product.created');
    expect(PRODUCT_EVENTS.SERVICE_CREATED).toBe('service.created');
  });
});

// ── BEHAVIORAL: Privacy sanitizer (allowlist) ──

describe('privacy sanitizer (allowlist behavioral)', () => {
  it('passes only allowed keys', () => {
    const input = {
      business_id: 'biz-1', entity_id: 'e-1', entity_type: 'product',
      status: 'success', provider: 'paystack', capability: 'ordering',
      error_code: 'E001', test_run_id: 'run-1', request_id: 'req-1',
      message_id: 'msg-1', amount: 5000, currency: 'NGN', gateway: 'paystack',
    };
    const safe = sanitizeEventProps(input);
    expect(Object.keys(safe).sort()).toEqual([
      'amount', 'business_id', 'capability', 'currency', 'entity_id',
      'entity_type', 'error_code', 'gateway', 'message_id', 'provider',
      'request_id', 'status', 'test_run_id',
    ]);
  });

  it('strips all known sensitive keys', () => {
    const input = {
      business_id: 'biz-1',
      password: 'x', token: 'x', access_token: 'x', refresh_token: 'x',
      secret: 'x', otp: 'x', card: 'x', card_number: 'x', cvv: 'x',
      email: 'x', phone: 'x', message: 'x', message_body: 'x',
      api_key: 'x', api_secret: 'x', private_key: 'x',
    };
    const safe = sanitizeEventProps(input);
    expect(safe).toEqual({ business_id: 'biz-1' });
  });

  it('strips variant sensitive key names', () => {
    const safe = sanitizeEventProps({
      business_id: 'biz-1',
      customer_email: 'leak@test.com',
      user_phone: '+123',
      auth_token: 'tok',
      card_details: '4111',
      customer_name: 'John',
      stripe_secret: 'sk_test',
      meta_access_token: 'EAA...',
    });
    // All non-allowed keys are dropped regardless of naming
    expect(safe).toEqual({ business_id: 'biz-1' });
  });

  it('preserves message_id but strips message and message_body', () => {
    const safe = sanitizeEventProps({
      message_id: 'wamid.123',
      message: 'Hello customer',
      message_body: 'private content',
    });
    expect(safe).toEqual({ message_id: 'wamid.123' });
  });

  it('does not mutate original', () => {
    const input = { password: 'secret', business_id: 'b' };
    sanitizeEventProps(input);
    expect(input.password).toBe('secret');
  });

  it('handles empty props', () => {
    expect(sanitizeEventProps({})).toEqual({});
  });
});

// ── BEHAVIORAL: Fetch interceptor (real function) ──

describe('fetch interceptor (real installTestRunFetchInterceptor)', () => {
  let originalFetch: typeof globalThis.fetch;
  let capturedUrl: string;
  let capturedInit: RequestInit | undefined;

  beforeEach(() => {
    _resetInterceptorForTest();
    capturedUrl = '';
    capturedInit = undefined;
    originalFetch = globalThis.fetch;

    // Mock window + location
    (globalThis as any).window = {
      location: { href: 'https://www.waaiio.com/dashboard', origin: 'https://www.waaiio.com' },
      fetch: vi.fn((...args: any[]) => {
        capturedUrl = typeof args[0] === 'string' ? args[0] : args[0] instanceof URL ? args[0].href : (args[0] as Request).url;
        capturedInit = args[1];
        return Promise.resolve(new Response('ok'));
      }),
    };
    // Make sessionStorage available
    const store: Record<string, string> = {};
    (globalThis as any).sessionStorage = {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => { store[k] = v; },
      removeItem: (k: string) => { delete store[k]; },
    };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete (globalThis as any).window;
    delete (globalThis as any).sessionStorage;
    _resetInterceptorForTest();
  });

  function getAttachedHeader(): string | null {
    if (!capturedInit?.headers) return null;
    const h = capturedInit.headers instanceof Headers ? capturedInit.headers : new Headers(capturedInit.headers as HeadersInit);
    return h.get('x-test-run-id');
  }

  it('adds header to relative same-origin URL', async () => {
    sessionStorage.setItem('waaiio_test_run_id', 'run-rel');
    installTestRunFetchInterceptor();
    await (globalThis as any).window.fetch('/api/products', { method: 'POST' });
    expect(getAttachedHeader()).toBe('run-rel');
  });

  it('adds header to absolute same-origin URL', async () => {
    sessionStorage.setItem('waaiio_test_run_id', 'run-abs');
    installTestRunFetchInterceptor();
    await (globalThis as any).window.fetch('https://www.waaiio.com/api/test');
    expect(getAttachedHeader()).toBe('run-abs');
  });

  it('adds header when input is a URL object', async () => {
    sessionStorage.setItem('waaiio_test_run_id', 'run-url');
    installTestRunFetchInterceptor();
    await (globalThis as any).window.fetch(new URL('/api/test', 'https://www.waaiio.com'));
    expect(getAttachedHeader()).toBe('run-url');
  });

  it('adds header when input is a Request object and preserves existing headers', async () => {
    sessionStorage.setItem('waaiio_test_run_id', 'run-req');
    installTestRunFetchInterceptor();
    const req = new Request('https://www.waaiio.com/api/test', {
      headers: { 'Authorization': 'Bearer tok', 'Content-Type': 'application/json' },
    });
    await (globalThis as any).window.fetch(req);
    const headers = capturedInit?.headers instanceof Headers ? capturedInit.headers : new Headers(capturedInit?.headers as HeadersInit);
    expect(headers.get('x-test-run-id')).toBe('run-req');
    expect(headers.get('Authorization')).toBe('Bearer tok');
    expect(headers.get('Content-Type')).toBe('application/json');
  });

  it('does NOT add header to third-party URL (Stripe)', async () => {
    sessionStorage.setItem('waaiio_test_run_id', 'run-stripe');
    installTestRunFetchInterceptor();
    await (globalThis as any).window.fetch('https://api.stripe.com/v1/charges');
    expect(getAttachedHeader()).toBeNull();
  });

  it('does NOT add header to Meta graph API', async () => {
    sessionStorage.setItem('waaiio_test_run_id', 'run-meta');
    installTestRunFetchInterceptor();
    await (globalThis as any).window.fetch('https://graph.facebook.com/v22.0/me');
    expect(getAttachedHeader()).toBeNull();
  });

  it('does NOT add header to PostHog', async () => {
    sessionStorage.setItem('waaiio_test_run_id', 'run-ph');
    installTestRunFetchInterceptor();
    await (globalThis as any).window.fetch('https://us.i.posthog.com/capture');
    expect(getAttachedHeader()).toBeNull();
  });

  it('does NOT add header to Supabase', async () => {
    sessionStorage.setItem('waaiio_test_run_id', 'run-sb');
    installTestRunFetchInterceptor();
    await (globalThis as any).window.fetch('https://cxcmiqotkowhxinjbytg.supabase.co/rest/v1/businesses');
    expect(getAttachedHeader()).toBeNull();
  });

  it('rejects look-alike domain (waaiio.com.evil.example)', async () => {
    sessionStorage.setItem('waaiio_test_run_id', 'run-evil');
    installTestRunFetchInterceptor();
    await (globalThis as any).window.fetch('https://www.waaiio.com.evil.example/steal');
    expect(getAttachedHeader()).toBeNull();
  });

  it('rejects protocol-relative URL (//evil.example/path)', async () => {
    sessionStorage.setItem('waaiio_test_run_id', 'run-proto');
    installTestRunFetchInterceptor();
    await (globalThis as any).window.fetch('//evil.example/path');
    expect(getAttachedHeader()).toBeNull();
  });

  it('does not add header when test_run_id is not set (normal traffic)', async () => {
    // No sessionStorage value
    installTestRunFetchInterceptor();
    await (globalThis as any).window.fetch('/api/test');
    expect(getAttachedHeader()).toBeNull();
  });

  it('is idempotent — second call does not double-wrap', async () => {
    sessionStorage.setItem('waaiio_test_run_id', 'run-idem');
    installTestRunFetchInterceptor();
    installTestRunFetchInterceptor(); // second call
    await (globalThis as any).window.fetch('/api/test');
    expect(getAttachedHeader()).toBe('run-idem');
  });

  it('reads test_run_id on each request — setting after install begins propagation', async () => {
    // Install with no test_run_id set
    installTestRunFetchInterceptor();
    await (globalThis as any).window.fetch('/api/before');
    expect(getAttachedHeader()).toBeNull();

    // Now set it — next request should pick it up without reinstall
    sessionStorage.setItem('waaiio_test_run_id', 'run-late');
    await (globalThis as any).window.fetch('/api/after');
    expect(getAttachedHeader()).toBe('run-late');
  });

  it('clearing test_run_id stops propagation without reload', async () => {
    sessionStorage.setItem('waaiio_test_run_id', 'run-clear');
    installTestRunFetchInterceptor();
    await (globalThis as any).window.fetch('/api/with');
    expect(getAttachedHeader()).toBe('run-clear');

    // Clear it
    sessionStorage.removeItem('waaiio_test_run_id');
    await (globalThis as any).window.fetch('/api/without');
    expect(getAttachedHeader()).toBeNull();
  });

  it('test_run_id reaches getTestRunId on server', () => {
    const mockRequest = { headers: { get: (n: string) => n === 'x-test-run-id' ? 'run-e2e-42' : null } };
    expect(getTestRunId(mockRequest)).toBe('run-e2e-42');
  });
});

// ── SOURCE CONTRACT: Real flow wiring ──

describe('server event wiring', () => {
  it('onboarding/register emits business.created', () => {
    const fs = require('fs');
    const src = fs.readFileSync('app/api/onboarding/register/route.ts', 'utf-8');
    expect(src).toContain("'business.created'");
    expect(src).toContain('emitServerEvent');
  });

  it('capabilities/configure emits per-capability enabled/disabled', () => {
    const fs = require('fs');
    const src = fs.readFileSync('app/api/capabilities/configure/route.ts', 'utf-8');
    expect(src).toContain("'capability.enabled'");
    expect(src).toContain("'capability.disabled'");
    expect(src).toContain('capability: cap');
    expect(src).toContain('for (const cap of requestedCaps)');
    expect(src).toContain('for (const cap of currentSelected)');
  });

  it('WhatsApp embedded-signup emits connect_completed and connect_failed', () => {
    const fs = require('fs');
    const src = fs.readFileSync('app/api/whatsapp/embedded-signup/route.ts', 'utf-8');
    expect(src).toContain("'whatsapp.connect_completed'");
    expect(src).toContain("'whatsapp.connect_failed'");
  });

  it('Promotions fulfillment emits promo.winner_fulfilled ONLY for fulfilled status', () => {
    const fs = require('fs');
    const src = fs.readFileSync('app/api/promotions/fulfillment/route.ts', 'utf-8');
    expect(src).toContain("'promo.winner_fulfilled'");
    expect(src).toContain("fulfillmentStatus === 'fulfilled'");
    expect(src).not.toContain("'fulfillment.completed'");
  });

  it('payment processing distinguishes completion from finalization failure', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/payments/process-success.ts', 'utf-8');
    expect(src).toContain("'payment.completed'");
    expect(src).toContain("'payment.finalization_failed'");
    expect(src).not.toContain("'payment.failed'");
  });
});

// ── Client-side product/service creation instrumentation ──

describe('product/service creation instrumentation', () => {
  it('products page calls captureProductEvent on successful insert', () => {
    const fs = require('fs');
    const src = fs.readFileSync('app/dashboard/products/page.tsx', 'utf-8');
    expect(src).toContain("captureProductEvent('product.created'");
    expect(src).toContain('entity_type: \'product\'');
    expect(src).toContain('entity_id: productId');
    expect(src).toContain('business_id: business.id');
    // Must be wrapped in try/catch to never affect creation
    expect(src).toContain('never affect creation');
  });

  it('services page calls captureProductEvent on successful insert', () => {
    const fs = require('fs');
    const src = fs.readFileSync('app/dashboard/services/page.tsx', 'utf-8');
    expect(src).toContain("captureProductEvent('service.created'");
    expect(src).toContain('entity_type: \'service\'');
    expect(src).toContain('entity_id: inserted.id');
    expect(src).toContain('business_id: business.id');
    expect(src).toContain('never affect creation');
  });

  it('services insert now returns the ID via .select()', () => {
    const fs = require('fs');
    const src = fs.readFileSync('app/dashboard/services/page.tsx', 'utf-8');
    // Services insert should use .select('id').single() to capture the ID
    expect(src).toContain(".insert(payload).select('id').single()");
  });
});

// ── Existing observability relied on (order/booking/refund/payout) ──

describe('existing observability for unwired events', () => {
  it('payment initialization has observe() wrapper', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/bot/flows/shared/payment.ts', 'utf-8');
    expect(src).toContain("observe('payment.init'");
    expect(src).toContain('businessId');
    expect(src).toContain('amount');
    expect(src).toContain('currency');
    expect(src).toContain('gateway');
  });

  it('order creation uses create_order_atomic RPC with error logging', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/bot/flows/ordering.flow.ts', 'utf-8');
    expect(src).toContain('create_order_atomic');
    // Error path has logging
    expect(src).toContain('[ORDERING] order_created rule error');
  });

  it('booking creation uses book_slot_atomic RPC with error logging', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/bot/flows/scheduling.flow.ts', 'utf-8');
    expect(src).toContain('book_slot_atomic');
    expect(src).toContain('scheduling.create-booking');
  });

  it('payout cron has structured logging with businessId', () => {
    const fs = require('fs');
    const src = fs.readFileSync('app/api/cron/auto-payout/route.ts', 'utf-8');
    expect(src).toContain('auto-payout');
    expect(src).toContain('businessId');
  });
});

// ── Capability matrix accuracy ──

describe('capability matrix accuracy', () => {
  it('every capability has correct ID, label, and tier on same row', () => {
    const fs = require('fs');
    const capSrc = fs.readFileSync('shared/capabilities.ts', 'utf-8');
    const matrix = fs.readFileSync('docs/acceptance/capability-matrix.md', 'utf-8');

    // Extract tiers
    const tierMap: Record<string, string> = {};
    const tierSection = capSrc.substring(capSrc.indexOf('CAPABILITY_TIER_REQUIREMENTS'));
    for (const m of tierSection.matchAll(/(\w+):\s*'(\w+)'/g)) {
      tierMap[m[1]] = m[2] === 'free' ? 'Free' : m[2] === 'growth' ? 'Pro' : 'Premium';
    }

    // Extract capabilities with id AND label
    const capMatches = [...capSrc.matchAll(/id:\s*'([^']+)',\s*label:\s*'([^']+)'/g)];
    expect(capMatches.length).toBeGreaterThanOrEqual(32);

    // Verify each row has ID + label + tier on the SAME row
    for (const [, id, label] of capMatches) {
      const tier = tierMap[id];
      expect(tier, `tier missing for ${id}`).toBeTruthy();
      // Find the matrix row containing this capability ID and verify label + tier on same row
      const rowRegex = new RegExp(`\\|[^\\n]*\`${id}\`[^\\n]*\\|[^\\n]*${escapeRegex(label)}[^\\n]*\\|[^\\n]*${tier}[^\\n]*\\|`);
      const rowMatch = matrix.match(rowRegex);
      expect(rowMatch, `Matrix row for ${id} should contain label="${label}" and tier="${tier}"`).toBeTruthy();
    }
  });
});

function escapeRegex(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

describe('PostHog privacy', () => {
  it('does not identify users with email', () => {
    const fs = require('fs');
    const src = fs.readFileSync('components/PostHogProvider.tsx', 'utf-8');
    expect(src).toContain('posthog.identify(user.id)');
    expect(src).not.toContain('email: user.email');
  });

  it('test_run_id interceptor initialized from PostHogProvider', () => {
    const fs = require('fs');
    const src = fs.readFileSync('components/PostHogProvider.tsx', 'utf-8');
    expect(src).toContain('installTestRunFetchInterceptor');
  });
});

describe('finance acceptance spec', () => {
  it('exists with invariant', () => {
    const fs = require('fs');
    const spec = fs.readFileSync('docs/acceptance/finance-acceptance.md', 'utf-8');
    expect(spec).toContain('no unexplained money');
    expect(spec).toContain('gross_amount');
    expect(spec).toContain('platform_fee');
  });
});
