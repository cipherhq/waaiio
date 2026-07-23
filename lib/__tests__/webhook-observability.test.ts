/**
 * Webhook Observability Tests
 *
 * Verifies that payment webhook handlers emit structured lifecycle events
 * without changing webhook behavior.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';

const paystackWebhook = readFileSync('app/api/payments/webhook/route.ts', 'utf-8');
const flutterwaveWebhook = readFileSync('app/api/webhooks/flutterwave/route.ts', 'utf-8');
const observabilityCode = readFileSync('lib/observability/webhooks.ts', 'utf-8');

// ── Webhook logger helper ──

describe('createWebhookLogger helper', () => {
  it('exists in observability.ts', () => {
    expect(observabilityCode).toContain('export function createWebhookLogger');
  });

  it('emits webhook.received event', () => {
    expect(observabilityCode).toContain("op: 'webhook.received'");
  });

  it('emits webhook.verified event', () => {
    expect(observabilityCode).toContain("op: 'webhook.verified'");
  });

  it('emits webhook.rejected event', () => {
    expect(observabilityCode).toContain("op: 'webhook.rejected'");
  });

  it('emits webhook.ignored event', () => {
    expect(observabilityCode).toContain("op: 'webhook.ignored'");
  });

  it('emits webhook.duplicate event', () => {
    expect(observabilityCode).toContain("op: 'webhook.duplicate'");
  });

  it('emits webhook.processed event', () => {
    expect(observabilityCode).toContain("op: 'webhook.processed'");
  });

  it('emits webhook.failed event with safeLogErrorContext', () => {
    expect(observabilityCode).toContain("op: 'webhook.failed'");
    expect(observabilityCode).toContain('safeLogErrorContext(error)');
  });

  it('accepts gateway and requestId in constructor', () => {
    expect(observabilityCode).toContain('function createWebhookLogger(gateway: string, requestId: string)');
  });
});

// ── Paystack webhook instrumentation ──

describe('Paystack webhook observability', () => {
  it('creates a webhook logger with gateway and requestId', () => {
    expect(paystackWebhook).toContain("createWebhookLogger('paystack', getRequestId(request))");
  });

  it('emits webhook.rejected on missing secret', () => {
    expect(paystackWebhook).toContain("wh.rejected('Webhook secret not configured')");
  });

  it('emits webhook.rejected on invalid signature', () => {
    expect(paystackWebhook).toContain("wh.rejected('Invalid signature')");
  });

  it('emits webhook.verified after signature passes', () => {
    expect(paystackWebhook).toContain('wh.verified()');
  });

  it('emits webhook.received with event type and reference', () => {
    expect(paystackWebhook).toContain('wh.received(');
    expect(paystackWebhook).toContain('eventType: event');
    expect(paystackWebhook).toContain('providerRef: reference');
  });

  it('emits webhook.ignored on missing reference', () => {
    expect(paystackWebhook).toContain("wh.ignored('Missing reference')");
  });

  it('emits webhook.duplicate for already-processed events', () => {
    expect(paystackWebhook).toContain('wh.duplicate(');
    expect(paystackWebhook).toContain('webhookEventId:');
  });

  it('emits webhook.processed with duration on success', () => {
    expect(paystackWebhook).toContain('wh.processed(');
    expect(paystackWebhook).toContain('durationMs:');
  });

  it('emits webhook.failed with duration on error', () => {
    expect(paystackWebhook).toContain('wh.failed(error');
    expect(paystackWebhook).toContain('durationMs:');
  });

  it('tracks start time for duration measurement', () => {
    expect(paystackWebhook).toContain('performance.now()');
  });
});

// ── Flutterwave webhook instrumentation ──

describe('Flutterwave webhook observability', () => {
  it('creates a webhook logger with gateway and requestId', () => {
    expect(flutterwaveWebhook).toContain("createWebhookLogger('flutterwave', getRequestId(request))");
  });

  it('emits webhook.rejected on missing secret', () => {
    expect(flutterwaveWebhook).toContain("wh.rejected('Webhook secret not configured')");
  });

  it('emits webhook.rejected on invalid hash', () => {
    expect(flutterwaveWebhook).toContain("wh.rejected('Invalid hash')");
  });

  it('emits webhook.verified after hash passes', () => {
    expect(flutterwaveWebhook).toContain('wh.verified()');
  });

  it('emits webhook.received with event type', () => {
    expect(flutterwaveWebhook).toContain('wh.received(');
  });

  it('emits webhook.ignored for non-charge events', () => {
    expect(flutterwaveWebhook).toContain('wh.ignored(');
  });

  it('emits webhook.duplicate for already-processed events', () => {
    expect(flutterwaveWebhook).toContain('wh.duplicate(');
  });

  it('emits webhook.processed with duration on success', () => {
    expect(flutterwaveWebhook).toContain('wh.processed(');
    expect(flutterwaveWebhook).toContain('durationMs:');
  });

  it('emits webhook.failed with duration on error', () => {
    expect(flutterwaveWebhook).toContain('wh.failed(error');
  });
});

// ── No sensitive data ──

describe('No sensitive data in webhook observability', () => {
  it('Paystack handler does not pass raw body to webhook logger', () => {
    expect(paystackWebhook).not.toMatch(/wh\.\w+\([^)]*rawBody/);
  });

  it('Paystack handler does not pass signature variable to webhook logger', () => {
    // The word "signature" appears in rejection reason strings, but the actual
    // signature variable value must never be passed as context
    const whCalls = paystackWebhook.match(/wh\.\w+\(\{[^}]*\}/g) || [];
    for (const call of whCalls) {
      expect(call).not.toContain('signature:');
      expect(call).not.toContain('hash:');
    }
  });

  it('Flutterwave handler does not pass hash to webhook logger', () => {
    expect(flutterwaveWebhook).not.toMatch(/wh\.\w+\([^)]*verifHash/);
  });

  it('webhook logger helper does not accept secret or body fields', () => {
    const loggerSection = observabilityCode.substring(
      observabilityCode.indexOf('function createWebhookLogger'),
      observabilityCode.indexOf('Observe variant'),
    );
    expect(loggerSection).not.toContain('secret');
    expect(loggerSection).not.toContain('rawBody');
    expect(loggerSection).not.toContain('signature');
  });
});

// ── Behavior preservation ──

describe('Webhook behavior unchanged', () => {
  it('Paystack returns 400 on invalid signature (not changed)', () => {
    expect(paystackWebhook).toContain("{ status: 400 }");
    expect(paystackWebhook).toContain("'Invalid signature'");
  });

  it('Paystack returns 500 on processing failure (not changed)', () => {
    expect(paystackWebhook).toContain("{ status: 500 }");
    expect(paystackWebhook).toContain("'Processing failed'");
  });

  it('Flutterwave returns 401 on invalid hash (not changed)', () => {
    expect(flutterwaveWebhook).toContain("{ status: 401 }");
    expect(flutterwaveWebhook).toContain("'Invalid hash'");
  });

  it('Flutterwave acknowledges with 200 on error (not changed)', () => {
    // Flutterwave webhook acknowledges even on error to prevent infinite retries
    const catchSection = flutterwaveWebhook.substring(
      flutterwaveWebhook.lastIndexOf('catch (error)'),
    );
    expect(catchSection).toContain("{ status: 200 }");
  });

  it('Paystack preserves Sentry.captureException in catch', () => {
    expect(paystackWebhook).toContain('Sentry.captureException(error)');
  });

  it('Flutterwave preserves Sentry.captureException in catch', () => {
    expect(flutterwaveWebhook).toContain('Sentry.captureException(error)');
  });

  it('Paystack preserves idempotency state machine', () => {
    expect(paystackWebhook).toContain('processed_webhook_events');
    expect(paystackWebhook).toContain("status: 'processing'");
    expect(paystackWebhook).toContain("status: 'completed'");
  });
});
