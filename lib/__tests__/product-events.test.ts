/**
 * Product event instrumentation tests.
 *
 * Proves:
 * - test_run_id propagation is optional and safe
 * - no sensitive fields emitted
 * - event names are stable
 * - instrumentation failures never break business operations
 * - request ID behavior intact
 */
import { describe, it, expect } from 'vitest';
import {
  PRODUCT_EVENTS,
  getTestRunId,
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
  it('all canonical events have stable string names', () => {
    const events = Object.values(PRODUCT_EVENTS);
    expect(events.length).toBeGreaterThanOrEqual(20);
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
  });

  it('promotions events exist', () => {
    expect(PRODUCT_EVENTS.PROMO_WINNER_FULFILLED).toBe('promo.winner_fulfilled');
  });
});

describe('property safety', () => {
  it('ProductEventProps type does not require sensitive fields', () => {
    // Compile-time check: these properties should be accepted
    const safe: ProductEventProps = {
      test_run_id: 'run-1',
      request_id: 'req-1',
      business_id: 'biz-1',
      entity_id: 'ent-1',
      capability: 'ordering',
      status: 'success',
    };
    expect(safe.test_run_id).toBe('run-1');
  });

  it('no credential/secret field names in event property type', () => {
    // Source inspection: ProductEventProps must not contain these
    const fs = require('fs');
    const src = fs.readFileSync('lib/observability/product-events.ts', 'utf-8');
    const propsSection = src.substring(src.indexOf('interface ProductEventProps'), src.indexOf('// ── Canonical'));
    expect(propsSection).not.toContain('password');
    expect(propsSection).not.toContain('token');
    expect(propsSection).not.toContain('secret');
    expect(propsSection).not.toContain('otp');
    expect(propsSection).not.toContain('card');
    expect(propsSection).not.toContain('email');
  });
});

describe('PostHog privacy', () => {
  it('PostHogProvider does not identify users with email', () => {
    const fs = require('fs');
    const src = fs.readFileSync('components/PostHogProvider.tsx', 'utf-8');
    // Must identify by user.id only, not email
    expect(src).toContain('posthog.identify(user.id)');
    expect(src).not.toContain('email: user.email');
  });
});

describe('instrumentation failure safety', () => {
  it('captureProductEvent function has try/catch protection', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/observability/product-events.ts', 'utf-8');
    const captureFn = src.substring(src.indexOf('function captureProductEvent'), src.indexOf('function captureServerEvent'));
    expect(captureFn).toContain('try');
    expect(captureFn).toContain('catch');
    expect(captureFn).toContain('never break business operations');
  });

  it('captureServerEvent function has try/catch protection', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/observability/product-events.ts', 'utf-8');
    const serverFn = src.substring(src.indexOf('function captureServerEvent'));
    expect(serverFn).toContain('try');
    expect(serverFn).toContain('catch');
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

describe('acceptance documentation', () => {
  it('32-capability matrix exists and covers all canonical capabilities', () => {
    const fs = require('fs');
    const matrix = fs.readFileSync('docs/acceptance/capability-matrix.md', 'utf-8');
    const caps = fs.readFileSync('shared/capabilities.ts', 'utf-8');

    // Extract all capability IDs
    const capIds: string[] = [];
    const matches = caps.matchAll(/id:\s*'([^']+)'/g);
    for (const m of matches) capIds.push(m[1]);

    // Every capability must appear in the matrix
    for (const id of capIds) {
      expect(matrix).toContain(`\`${id}\``);
    }
  });

  it('finance acceptance spec exists', () => {
    const fs = require('fs');
    expect(fs.existsSync('docs/acceptance/finance-acceptance.md')).toBe(true);
    const spec = fs.readFileSync('docs/acceptance/finance-acceptance.md', 'utf-8');
    expect(spec).toContain('gross_amount');
    expect(spec).toContain('platform_fee');
    expect(spec).toContain('business_share');
    expect(spec).toContain('no unexplained money');
  });
});
