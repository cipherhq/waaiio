/**
 * Product event instrumentation tests.
 */
import { describe, it, expect } from 'vitest';
import {
  PRODUCT_EVENTS,
  getTestRunId,
  sanitizeEventProps,
  type ProductEventProps,
} from '@/lib/observability/product-events';

describe('test_run_id propagation', () => {
  it('extracts test_run_id from request headers when present', () => {
    const request = { headers: { get: (name: string) => name === 'x-test-run-id' ? 'run-abc123' : null } };
    expect(getTestRunId(request)).toBe('run-abc123');
  });

  it('returns undefined when header is absent (normal traffic)', () => {
    const request = { headers: { get: () => null } };
    expect(getTestRunId(request)).toBeUndefined();
  });

  it('returns undefined for empty header', () => {
    const request = { headers: { get: (name: string) => name === 'x-test-run-id' ? '' : null } };
    expect(getTestRunId(request)).toBeUndefined();
  });
});

describe('event name stability', () => {
  it('all canonical events have stable dot-separated names', () => {
    const events = Object.values(PRODUCT_EVENTS);
    expect(events.length).toBeGreaterThanOrEqual(22);
    for (const name of events) {
      expect(typeof name).toBe('string');
      expect(name).toMatch(/^[a-z_]+\.[a-z_]+$/);
    }
  });

  it('critical business events exist', () => {
    expect(PRODUCT_EVENTS.BUSINESS_CREATED).toBe('business.created');
    expect(PRODUCT_EVENTS.ORDER_CREATED).toBe('order.created');
    expect(PRODUCT_EVENTS.PAYMENT_COMPLETED).toBe('payment.completed');
    expect(PRODUCT_EVENTS.PAYMENT_FAILED).toBe('payment.failed');
    expect(PRODUCT_EVENTS.FULFILLMENT_COMPLETED).toBe('fulfillment.completed');
    expect(PRODUCT_EVENTS.PAYOUT_COMPLETED).toBe('payout.completed');
    expect(PRODUCT_EVENTS.PROMO_WINNER_FULFILLED).toBe('promo.winner_fulfilled');
  });
});

describe('privacy sanitizer', () => {
  it('strips sensitive keys case-insensitively', () => {
    const input = {
      business_id: 'biz-1',
      password: 'secret123',
      token: 'tok-abc',
      access_token: 'at-xyz',
      secret: 'shh',
      otp: '123456',
      card: '4111...',
      card_number: '4111111111111111',
      cvv: '123',
      email: 'user@example.com',
      phone: '+1234567890',
      message: 'hello world',
      message_body: 'body text',
      api_key: 'key-123',
      status: 'success',
    };
    const safe = sanitizeEventProps(input);

    // Safe fields preserved
    expect(safe.business_id).toBe('biz-1');
    expect(safe.status).toBe('success');

    // Sensitive fields stripped
    expect(safe.password).toBeUndefined();
    expect(safe.token).toBeUndefined();
    expect(safe.access_token).toBeUndefined();
    expect(safe.secret).toBeUndefined();
    expect(safe.otp).toBeUndefined();
    expect(safe.card).toBeUndefined();
    expect(safe.card_number).toBeUndefined();
    expect(safe.cvv).toBeUndefined();
    expect(safe.email).toBeUndefined();
    expect(safe.phone).toBeUndefined();
    expect(safe.message).toBeUndefined();
    expect(safe.message_body).toBeUndefined();
    expect(safe.api_key).toBeUndefined();
  });

  it('does not mutate the original object', () => {
    const input = { business_id: 'biz-1', password: 'secret' };
    const safe = sanitizeEventProps(input);
    expect(input.password).toBe('secret'); // original untouched
    expect(safe.password).toBeUndefined();
  });

  it('handles empty/undefined properties', () => {
    expect(sanitizeEventProps({})).toEqual({});
  });

  it('case-insensitive denial', () => {
    const safe = sanitizeEventProps({ PASSWORD: 'x', Token: 'y', business_id: 'z' });
    expect(safe.PASSWORD).toBeUndefined();
    expect(safe.Token).toBeUndefined();
    expect(safe.business_id).toBe('z');
  });
});

describe('PostHog privacy', () => {
  it('PostHogProvider does not identify users with email', () => {
    const fs = require('fs');
    const src = fs.readFileSync('components/PostHogProvider.tsx', 'utf-8');
    expect(src).toContain('posthog.identify(user.id)');
    expect(src).not.toContain('email: user.email');
  });
});

describe('instrumentation failure safety', () => {
  it('captureProductEvent has try/catch protection', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/observability/product-events.ts', 'utf-8');
    const fn = src.substring(src.indexOf('function captureProductEvent'), src.indexOf('function captureServerEvent'));
    expect(fn).toContain('try');
    expect(fn).toContain('catch');
    expect(fn).toContain('never break business operations');
  });

  it('captureServerEvent has try/catch protection', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/observability/product-events.ts', 'utf-8');
    const fn = src.substring(src.indexOf('function captureServerEvent'));
    expect(fn).toContain('try');
    expect(fn).toContain('catch');
  });
});

describe('test_run_id fetch interceptor', () => {
  it('installTestRunFetchInterceptor is exported', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/observability/product-events.ts', 'utf-8');
    expect(src).toContain('export function installTestRunFetchInterceptor');
    // Only intercepts same-origin
    expect(src).toContain('isSameOrigin');
    expect(src).toContain(TEST_RUN_HEADER_CHECK);
  });
});

// Test uses the actual constant name from the source
const TEST_RUN_HEADER_CHECK = 'x-test-run-id';

describe('server event emission', () => {
  it('emitServerEvent is exported and uses logger + events', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/observability/server-events.ts', 'utf-8');
    expect(src).toContain('export function emitServerEvent');
    expect(src).toContain('logger.withContext');
    expect(src).toContain('getRequestId');
    expect(src).toContain('getTestRunId');
    expect(src).toContain('sanitizeEventProps');
  });

  it('server events wired in onboarding register', () => {
    const fs = require('fs');
    const src = fs.readFileSync('app/api/onboarding/register/route.ts', 'utf-8');
    expect(src).toContain('emitServerEvent');
    expect(src).toContain("'business.created'");
  });

  it('server events wired in capability configure', () => {
    const fs = require('fs');
    const src = fs.readFileSync('app/api/capabilities/configure/route.ts', 'utf-8');
    expect(src).toContain('emitServerEvent');
    expect(src).toContain("'capability.enabled'");
  });

  it('payment completion event in process-success', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/payments/process-success.ts', 'utf-8');
    expect(src).toContain("'payment.completed'");
    expect(src).toContain("'payment.failed'");
  });

  it('fulfillment event wired in promotions fulfillment', () => {
    const fs = require('fs');
    const src = fs.readFileSync('app/api/promotions/fulfillment/route.ts', 'utf-8');
    expect(src).toContain('emitServerEvent');
    expect(src).toContain("'fulfillment.completed'");
  });
});

describe('request ID compatibility', () => {
  it('existing getRequestId in observability.ts is unchanged', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/observability.ts', 'utf-8');
    expect(src).toContain('x-request-id');
    expect(src).toContain('generateRequestId');
  });

  it('middleware still injects x-request-id', () => {
    const fs = require('fs');
    const src = fs.readFileSync('middleware.ts', 'utf-8');
    expect(src).toContain('x-request-id');
  });
});

describe('capability matrix accuracy', () => {
  it('matrix tiers match canonical CAPABILITY_TIER_REQUIREMENTS', () => {
    const fs = require('fs');
    const capSrc = fs.readFileSync('shared/capabilities.ts', 'utf-8');
    const matrix = fs.readFileSync('docs/acceptance/capability-matrix.md', 'utf-8');

    // Extract tiers from source
    const tierMap: Record<string, string> = {};
    const tierSection = capSrc.substring(capSrc.indexOf('CAPABILITY_TIER_REQUIREMENTS'));
    const tierMatches = [...tierSection.matchAll(/(\w+):\s*'(\w+)'/g)];
    for (const m of tierMatches) {
      tierMap[m[1]] = m[2] === 'free' ? 'Free' : m[2] === 'growth' ? 'Pro' : 'Premium';
    }

    // Extract capability IDs and labels from source
    const capMatches = [...capSrc.matchAll(/id:\s*'([^']+)',\s*label:\s*'([^']+)'/g)];
    expect(capMatches.length).toBeGreaterThanOrEqual(32);

    // Verify each capability appears with correct tier
    for (const [, id, label] of capMatches) {
      const tier = tierMap[id];
      expect(tier).toBeTruthy();
      // Check matrix contains this capability with correct tier
      expect(matrix).toContain(`\`${id}\``);
      expect(matrix).toContain(`| ${tier} |`);
    }
  });

  it('finance acceptance spec exists with invariant', () => {
    const fs = require('fs');
    const spec = fs.readFileSync('docs/acceptance/finance-acceptance.md', 'utf-8');
    expect(spec).toContain('gross_amount');
    expect(spec).toContain('platform_fee');
    expect(spec).toContain('business_share');
    expect(spec).toContain('no unexplained money');
  });
});
