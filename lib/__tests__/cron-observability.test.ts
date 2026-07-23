/**
 * Cron Observability Tests
 *
 * Verifies that payment cron jobs emit structured lifecycle events
 * without changing scheduling, retry, or charge behavior.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';

const retryCronCode = readFileSync('app/api/cron/retry-failed-charges/route.ts', 'utf-8');
const reconciliationCode = readFileSync('app/api/cron/payment-reconciliation/route.ts', 'utf-8');
const autoPayoutCode = readFileSync('app/api/cron/auto-payout/route.ts', 'utf-8');
const cronHelperCode = readFileSync('lib/observability/cron.ts', 'utf-8');

// ── Cron helper ──

describe('createCronLogger helper', () => {
  it('exists in lib/observability/cron.ts', () => {
    expect(cronHelperCode).toContain('export function createCronLogger');
  });

  it('generates a run ID per invocation', () => {
    expect(cronHelperCode).toContain('generateRunId()');
    expect(cronHelperCode).toContain('runId');
  });

  it('emits cron.started', () => {
    expect(cronHelperCode).toContain("op: 'cron.started'");
  });

  it('emits cron.completed with totals and duration', () => {
    expect(cronHelperCode).toContain("op: 'cron.completed'");
    expect(cronHelperCode).toContain('durationMs');
  });

  it('emits cron.failed with normalized error', () => {
    expect(cronHelperCode).toContain("op: 'cron.failed'");
    expect(cronHelperCode).toContain('normalizeError(error)');
  });

  it('emits cron.skipped', () => {
    expect(cronHelperCode).toContain("op: 'cron.skipped'");
  });

  it('emits cron.item.completed', () => {
    expect(cronHelperCode).toContain("op: 'cron.item.completed'");
  });

  it('emits cron.item.failed with normalized error', () => {
    expect(cronHelperCode).toContain("op: 'cron.item.failed'");
    expect(cronHelperCode).toContain('normalizeError(error)');
  });

  it('emits cron.item.skipped', () => {
    expect(cronHelperCode).toContain("op: 'cron.item.skipped'");
  });

  it('tracks start time for duration calculation', () => {
    expect(cronHelperCode).toContain('performance.now()');
  });
});

// ── Behavioral: run ID consistency ──

describe('createCronLogger run ID', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it('shares the same run ID across all events', async () => {
    const prevFormat = process.env.LOG_FORMAT;
    process.env.LOG_FORMAT = 'json';
    const captured: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      captured.push(String(args[0]));
    });

    const { createCronLogger } = await import('@/lib/observability/cron');
    const cron = createCronLogger('test-job');
    const runId = cron.runId;

    cron.started();
    cron.itemCompleted({ gateway: 'paystack', subscriptionId: 'sub-1' });
    cron.completed({ processedCount: 1, successCount: 1 });

    // All emitted logs should contain the same run ID
    for (const line of captured) {
      expect(line).toContain(runId);
    }
    expect(captured.length).toBeGreaterThanOrEqual(3);
    if (prevFormat === undefined) delete process.env.LOG_FORMAT;
    else process.env.LOG_FORMAT = prevFormat;
  });

  it('run ID starts with "run-"', async () => {
    const { createCronLogger } = await import('@/lib/observability/cron');
    const cron = createCronLogger('test-job');
    expect(cron.runId).toMatch(/^run-/);
  });
});

// ── retry-failed-charges instrumentation ──

describe('retry-failed-charges cron observability', () => {
  it('creates a cron logger', () => {
    expect(retryCronCode).toContain("createCronLogger('retry-failed-charges')");
  });

  it('emits cron.started at the beginning', () => {
    expect(retryCronCode).toContain('cron.started()');
  });

  it('emits cron.completed with totals on success', () => {
    expect(retryCronCode).toContain('cron.completed(');
    expect(retryCronCode).toContain('successCount: retried');
  });

  it('emits cron.failed on error', () => {
    expect(retryCronCode).toContain('cron.failed(error');
  });

  it('emits item.completed for successful Paystack retries', () => {
    expect(retryCronCode).toContain("cron.itemCompleted({ gateway: 'paystack'");
  });

  it('emits item.completed for successful Flutterwave retries', () => {
    expect(retryCronCode).toContain("cron.itemCompleted({ gateway: 'flutterwave'");
  });

  it('emits item.failed for failed retries', () => {
    expect(retryCronCode).toContain('cron.itemFailed(');
  });

  it('emits item.skipped for missing Paystack split config', () => {
    expect(retryCronCode).toContain("cron.itemSkipped({ gateway: 'paystack'");
    expect(retryCronCode).toContain('splitRequired: true');
    expect(retryCronCode).toContain('splitResolved: false');
  });

  it('emits item.skipped for unverified Flutterwave split', () => {
    expect(retryCronCode).toContain("cron.itemSkipped({ gateway: 'flutterwave'");
    expect(retryCronCode).toContain('not yet verified');
  });

  it('does not include runId in HTTP response body', () => {
    // runId is in logs only, not in the API response
    expect(retryCronCode).not.toContain('runId: cron.runId');
  });
});

// ── payment-reconciliation instrumentation ──

describe('payment-reconciliation cron observability', () => {
  it('creates a cron logger', () => {
    expect(reconciliationCode).toContain("createCronLogger('payment-reconciliation')");
  });

  it('emits cron.started', () => {
    expect(reconciliationCode).toContain('cron.started()');
  });

  it('emits cron.completed with totals', () => {
    expect(reconciliationCode).toContain('cron.completed(');
    expect(reconciliationCode).toContain('processedCount');
    expect(reconciliationCode).toContain('successCount: reconciled');
  });

  it('does not include runId in HTTP response body', () => {
    expect(reconciliationCode).not.toContain('runId: cron.runId');
  });

  it('emits cron.failed on query error', () => {
    expect(reconciliationCode).toContain('cron.failed(queryError)');
  });

  it('emits cron.failed on unexpected throw and re-throws', () => {
    expect(reconciliationCode).toContain('cron.failed(error)');
    expect(reconciliationCode).toContain('throw error');
  });

  it('emits cron.completed for empty result set', () => {
    // Early return when no stale payments
    const emptySection = reconciliationCode.substring(
      reconciliationCode.indexOf('stalePayments.length === 0'),
      reconciliationCode.indexOf('let reconciled'),
    );
    expect(emptySection).toContain('cron.completed(');
  });
});

// ── No sensitive data ──

describe('No sensitive data in cron observability', () => {
  it('cron helper does not accept secret or token fields', () => {
    expect(cronHelperCode).not.toContain('secret');
    expect(cronHelperCode).not.toContain('token');
    expect(cronHelperCode).not.toContain('authorization');
  });

  it('retry cron does not log authorization codes via cron logger', () => {
    const cronCalls = retryCronCode.match(/cron\.\w+\(\{[^}]*\}/g) || [];
    for (const call of cronCalls) {
      expect(call).not.toContain('authorization_code');
      expect(call).not.toContain('secret');
      expect(call).not.toContain('email');
      expect(call).not.toContain('phone');
    }
  });
});

// ── Behavior preservation ──

describe('Cron behavior unchanged', () => {
  it('retry cron preserves Sentry.captureException', () => {
    expect(retryCronCode).toContain('Sentry.captureException');
  });

  it('retry cron preserves fail-closed split behavior', () => {
    expect(retryCronCode).toContain("splitResult.mode === 'split_required_but_missing'");
    expect(retryCronCode).toContain('continue');
  });

  it('retry cron preserves FLUTTERWAVE_RECURRING_SPLIT_VERIFIED gate', () => {
    expect(retryCronCode).toContain('FLUTTERWAVE_RECURRING_SPLIT_VERIFIED');
  });

  it('retry cron preserves 3-failure cancellation', () => {
    expect(retryCronCode).toContain("status: 'cancelled'");
    expect(retryCronCode).toContain('cancelled_at');
  });

  it('payment-reconciliation preserves Sentry.captureException', () => {
    expect(reconciliationCode).toContain('Sentry.captureException');
  });

  it('retry cron still returns HTTP 500 on fatal error', () => {
    const catchSection = retryCronCode.substring(retryCronCode.lastIndexOf('catch (error)'));
    expect(catchSection).toContain("{ status: 500 }");
  });

  it('auto-payout preserves Sentry.captureException', () => {
    expect(autoPayoutCode).toContain('Sentry.captureException');
  });

  it('auto-payout still returns HTTP 500 on fatal error', () => {
    const catchSection = autoPayoutCode.substring(autoPayoutCode.lastIndexOf('catch (error)'));
    expect(catchSection).toContain("{ status: 500 }");
  });
});

// ── auto-payout instrumentation ──

describe('auto-payout cron observability', () => {
  it('creates a cron logger', () => {
    expect(autoPayoutCode).toContain("createCronLogger('auto-payout')");
  });

  it('emits cron.started', () => {
    expect(autoPayoutCode).toContain('cron.started()');
  });

  it('emits cron.completed with totals on success', () => {
    expect(autoPayoutCode).toContain('cron.completed(');
    expect(autoPayoutCode).toContain('processedCount');
  });

  it('emits cron.completed on early return (no businesses)', () => {
    const earlySection = autoPayoutCode.substring(
      autoPayoutCode.indexOf('businesses?.length'),
      autoPayoutCode.indexOf('businesses?.length') + 200,
    );
    expect(earlySection).toContain('cron.completed(');
  });

  it('emits cron.failed on error', () => {
    expect(autoPayoutCode).toContain('cron.failed(error');
  });

  it('does not include runId in response body', () => {
    expect(autoPayoutCode).not.toContain('runId: cron.runId');
  });
});

// ── Terminal event correctness ──

describe('Every started invocation has exactly one terminal event', () => {
  it('retry-failed-charges: 1 started, 1 completed, 1 failed (mutually exclusive paths)', () => {
    const started = (retryCronCode.match(/cron\.started\(\)/g) || []).length;
    const completed = (retryCronCode.match(/cron\.completed\(/g) || []).length;
    const failed = (retryCronCode.match(/cron\.failed\(/g) || []).length;
    expect(started).toBe(1);
    expect(completed).toBe(1);
    expect(failed).toBe(1);
    // completed is in try block, failed is in catch — mutually exclusive
  });

  it('payment-reconciliation: 1 started, all exit paths covered by try/catch', () => {
    const started = (reconciliationCode.match(/cron\.started\(\)/g) || []).length;
    const completed = (reconciliationCode.match(/cron\.completed\(/g) || []).length;
    const failed = (reconciliationCode.match(/cron\.failed\(/g) || []).length;
    expect(started).toBe(1);
    expect(completed).toBeGreaterThanOrEqual(2); // normal + empty result early return
    expect(failed).toBeGreaterThanOrEqual(2); // query error + unexpected throw
  });

  it('auto-payout: 1 started, terminal events cover all exit paths', () => {
    const started = (autoPayoutCode.match(/cron\.started\(\)/g) || []).length;
    const completed = (autoPayoutCode.match(/cron\.completed\(/g) || []).length;
    const failed = (autoPayoutCode.match(/cron\.failed\(/g) || []).length;
    expect(started).toBe(1);
    expect(completed).toBe(2); // normal + early "no businesses"
    expect(failed).toBe(1); // catch block
  });

  it('auto-payout uses coherent totals (processedCount = businesses.length)', () => {
    expect(autoPayoutCode).toContain('processedCount: businesses.length');
    expect(autoPayoutCode).toContain('successCount: generated');
    expect(autoPayoutCode).toContain('skippedCount: businesses.length - generated');
  });

  it('payment-reconciliation uses coherent totals with mutually exclusive outcomes', () => {
    expect(reconciliationCode).toContain('processedCount: stalePayments.length');
    expect(reconciliationCode).toContain('successCount: reconciled');
    expect(reconciliationCode).toContain('failureCount: markedFailed + errors');
    expect(reconciliationCode).toContain('skippedCount: stalePayments.length - reconciled - markedFailed - errors');
  });
});

// ── Response body preservation ──

describe('HTTP response bodies unchanged', () => {
  it('retry-failed-charges returns { success, retried, cancelled, skipped }', () => {
    expect(retryCronCode).toContain('{ success: true, retried, cancelled, skipped }');
  });

  it('payment-reconciliation returns { ok, total, reconciled, markedFailed, errors }', () => {
    expect(reconciliationCode).toContain('total: stalePayments.length');
    expect(reconciliationCode).toContain('reconciled,');
    expect(reconciliationCode).toContain('markedFailed,');
  });

  it('auto-payout returns { message, period, generated, autoApproved, transferred, held, released }', () => {
    expect(autoPayoutCode).toContain("message: 'Auto-payout complete'");
    expect(autoPayoutCode).toContain('generated,');
    expect(autoPayoutCode).toContain('autoApproved,');
    expect(autoPayoutCode).toContain('transferred,');
  });
});

// ── Behavioral tests ──

describe('Behavioral: createCronLogger lifecycle', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it('completed event shares the same runId as started', async () => {
    const prevFormat = process.env.LOG_FORMAT;
    process.env.LOG_FORMAT = 'json';
    const captured: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      captured.push(String(args[0]));
    });

    const { createCronLogger } = await import('@/lib/observability/cron');
    const cron = createCronLogger('test-job');
    cron.started();
    cron.completed({ processedCount: 5, successCount: 3, skippedCount: 2 });

    expect(captured.length).toBe(2);
    const startEntry = JSON.parse(captured[0]);
    const completeEntry = JSON.parse(captured[1]);
    expect(startEntry.runId).toBe(cron.runId);
    expect(completeEntry.runId).toBe(cron.runId);
    expect(startEntry.msg).toBe('cron.started');
    expect(completeEntry.msg).toBe('cron.completed');

    if (prevFormat === undefined) delete process.env.LOG_FORMAT;
    else process.env.LOG_FORMAT = prevFormat;
  });

  it('failed event shares the same runId and includes normalized error', async () => {
    const prevFormat = process.env.LOG_FORMAT;
    process.env.LOG_FORMAT = 'json';
    const captured: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      captured.push(String(args[0]));
    });
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      captured.push(String(args[0]));
    });

    const { createCronLogger } = await import('@/lib/observability/cron');
    const cron = createCronLogger('test-fail-job');
    cron.started();
    cron.failed(new Error('db connection lost'));

    expect(captured.length).toBe(2);
    const failEntry = JSON.parse(captured[1]);
    expect(failEntry.runId).toBe(cron.runId);
    expect(failEntry.msg).toBe('cron.failed');
    expect(failEntry.errorMessage).toBe('db connection lost');

    if (prevFormat === undefined) delete process.env.LOG_FORMAT;
    else process.env.LOG_FORMAT = prevFormat;
  });

  it('item events share the same runId', async () => {
    const prevFormat = process.env.LOG_FORMAT;
    process.env.LOG_FORMAT = 'json';
    const captured: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      captured.push(String(args[0]));
    });

    const { createCronLogger } = await import('@/lib/observability/cron');
    const cron = createCronLogger('test-items');
    cron.started();
    cron.itemCompleted({ gateway: 'paystack', subscriptionId: 'sub-1' });
    cron.itemSkipped({ reason: 'split missing', gateway: 'flutterwave' });
    cron.completed({ processedCount: 2, successCount: 1, skippedCount: 1 });

    for (const line of captured) {
      const entry = JSON.parse(line);
      expect(entry.runId).toBe(cron.runId);
    }
    expect(captured.length).toBe(4);

    if (prevFormat === undefined) delete process.env.LOG_FORMAT;
    else process.env.LOG_FORMAT = prevFormat;
  });
});

describe('Behavioral: unexpected error propagation', () => {
  it('payment-reconciliation re-throws unexpected errors after logging cron.failed', () => {
    // The catch block has: cron.failed(error); throw error;
    const catchSection = reconciliationCode.substring(
      reconciliationCode.lastIndexOf('catch (error)'),
    );
    expect(catchSection).toContain('cron.failed(error)');
    expect(catchSection).toContain('throw error');
    // Does not return a response — lets the error propagate
    expect(catchSection).not.toContain('NextResponse');
  });

  it('retry-failed-charges returns 500 after logging cron.failed (does not re-throw)', () => {
    const catchSection = retryCronCode.substring(
      retryCronCode.lastIndexOf('catch (error)'),
    );
    expect(catchSection).toContain('cron.failed(error');
    expect(catchSection).toContain("{ status: 500 }");
  });

  it('auto-payout returns 500 after logging cron.failed (does not re-throw)', () => {
    const catchSection = autoPayoutCode.substring(
      autoPayoutCode.lastIndexOf('catch (error)'),
    );
    expect(catchSection).toContain('cron.failed(error');
    expect(catchSection).toContain("{ status: 500 }");
  });
});
