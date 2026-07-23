/**
 * Payment Observability Instrumentation Tests
 *
 * Verifies that payment flows emit structured observability events
 * without changing payment behavior.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';

const paystackCode = readFileSync('lib/payments/paystack.ts', 'utf-8');
const flutterwaveCode = readFileSync('lib/payments/flutterwave.ts', 'utf-8');
const stripeCode = readFileSync('lib/payments/stripe.ts', 'utf-8');
const chargeSavedCode = readFileSync('lib/payments/charge-saved.ts', 'utf-8');
const orchestratorCode = readFileSync('lib/bot/flows/shared/payment.ts', 'utf-8');

// ── Event names ──

describe('Stable event names', () => {
  it('uses payment.init at orchestration level', () => {
    expect(orchestratorCode).toContain("'payment.init'");
  });

  it('uses observeProvider at provider boundary', () => {
    expect(paystackCode).toContain('observeProvider(');
    expect(flutterwaveCode).toContain('observeProvider(');
    expect(stripeCode).toContain('observeProvider(');
  });

  it('observeProvider emits provider.request and provider.response events', () => {
    const obsCode = readFileSync('lib/observability.ts', 'utf-8');
    expect(obsCode).toContain("op: 'provider.request'");
    expect(obsCode).toContain("op: 'provider.response'");
  });

  it('uses logSplitResolved for successful split resolution', () => {
    expect(chargeSavedCode).toContain('logSplitResolved(');
  });

  it('uses logSplitMissing for failed split resolution', () => {
    expect(chargeSavedCode).toContain('logSplitMissing(');
  });

  it('split helpers emit split.resolved and split.missing events via observability', () => {
    const obsCode = readFileSync('lib/observability.ts', 'utf-8');
    expect(obsCode).toContain("op: 'split.resolved'");
    expect(obsCode).toContain("op: 'split.missing'");
  });
});

// ── Context fields ──

describe('Safe context fields', () => {
  it('includes gateway identifier in provider requests', () => {
    expect(paystackCode).toContain("gateway: 'paystack'");
    expect(flutterwaveCode).toContain("gateway: 'flutterwave'");
    expect(stripeCode).toContain("gateway: 'stripe'");
  });

  it('includes businessId in orchestrator', () => {
    expect(orchestratorCode).toContain('businessId: opts.businessId');
  });

  it('includes amount and currency in init calls', () => {
    expect(paystackCode).toContain('amount: opts.amount');
    expect(paystackCode).toContain('currency: opts.currency');
    expect(flutterwaveCode).toContain('amount: opts.amount');
    expect(stripeCode).toContain('amount: opts.amount');
  });

  it('includes providerRef in verify calls', () => {
    expect(paystackCode).toContain('providerRef: reference');
    expect(flutterwaveCode).toContain('providerRef: reference');
    expect(stripeCode).toContain('providerRef: reference');
  });

  it('includes split context in orchestrator', () => {
    expect(orchestratorCode).toContain('splitRequired');
    expect(orchestratorCode).toContain('splitResolved');
  });
});

// ── Sensitive data exclusion ──

describe('No sensitive data in observe() context', () => {
  const allProviderCode = paystackCode + flutterwaveCode + stripeCode + chargeSavedCode;

  it('does not pass authorization_code to observe()', () => {
    // Find observe() calls and check their context objects
    const observeCalls = allProviderCode.match(/observe\([^)]*\{[^}]*\}/g) || [];
    for (const call of observeCalls) {
      expect(call).not.toContain('authorization_code');
      expect(call).not.toContain('secret');
      expect(call).not.toContain('Bearer');
    }
  });

  it('does not pass email to observe()', () => {
    const observeCalls = allProviderCode.match(/observe\([^)]*\{[^}]*\}/g) || [];
    for (const call of observeCalls) {
      expect(call).not.toContain('email');
      expect(call).not.toContain('phone');
    }
  });
});

// ── Import structure ──

describe('Observe imports', () => {
  it('provider files import observeProvider from observability', () => {
    expect(paystackCode).toContain("import { observeProvider } from '@/lib/observability'");
    expect(flutterwaveCode).toContain("import { observeProvider } from '@/lib/observability'");
    expect(stripeCode).toContain("import { observeProvider } from '@/lib/observability'");
  });

  it('charge-saved imports split helpers from observability', () => {
    expect(chargeSavedCode).toContain("logSplitResolved");
    expect(chargeSavedCode).toContain("logSplitMissing");
  });

  it('orchestrator imports observe from observability', () => {
    expect(orchestratorCode).toContain("import { observe } from '@/lib/observability'");
  });
});

// ── Behavior preservation ──

describe('Payment behavior unchanged', () => {
  it('Paystack init still returns url and reference', () => {
    expect(paystackCode).toContain('return { url: data.data.authorization_url');
  });

  it('Flutterwave init still returns url and reference', () => {
    expect(flutterwaveCode).toContain('return { url: data.data.link');
  });

  it('Stripe init still returns url and reference', () => {
    expect(stripeCode).toContain("return { url: sessionData.url as string");
  });

  it('split.resolved does not alter split return value', () => {
    // logSplitResolved is called before the return, not wrapping it
    const resolvedIdx = chargeSavedCode.indexOf('logSplitResolved(');
    const returnIdx = chargeSavedCode.indexOf("mode: 'split',", resolvedIdx);
    expect(resolvedIdx).toBeGreaterThan(-1);
    expect(returnIdx).toBeGreaterThan(resolvedIdx);
  });

  it('split.missing does not alter split return value', () => {
    const missingIdx = chargeSavedCode.indexOf('logSplitMissing(');
    const returnIdx = chargeSavedCode.indexOf("mode: 'split_required_but_missing'", missingIdx);
    expect(missingIdx).toBeGreaterThan(-1);
    expect(returnIdx).toBeGreaterThan(missingIdx);
  });
});

// ── No duplicate events ──

describe('No duplicate logging at multiple layers', () => {
  it('orchestrator uses observe(payment.init), providers use observeProvider (different helpers)', () => {
    expect(orchestratorCode).toContain("observe('payment.init'");
    // Providers use observeProvider, not observe
    expect(paystackCode).toContain('observeProvider(');
    expect(paystackCode).not.toContain("observe('provider.request'");
  });
});
