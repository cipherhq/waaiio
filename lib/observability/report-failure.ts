/**
 * reportFailure() — one safe way to tell Sentry (and the logs) that something
 * failed, so swallowed or console-only failures become findable (#1092).
 *
 * Tracking only: it never throws, never awaits, and returns nothing, so a
 * caller's control flow is identical with or without it.
 *
 * Privacy rules (enforced here, proven in lib/__tests__/report-failure.test.ts):
 * - Only the allowlisted fields of FailureContext leave this function. Every
 *   string must be a UUID or pass isSafeIdentifier(); anything else is dropped.
 * - The error's free-form message is never sent: provider messages (#718),
 *   database errors with values and customer text can all hide in it. Sentry
 *   gets the error's class name and stack frames (code locations) only.
 * - No phone numbers, emails, message bodies, card data, tokens or keys are
 *   accepted, and events from here are stripped of breadcrumbs, request data,
 *   user and extra in beforeSend (lib/sentry-redact.ts).
 */

import * as Sentry from '@sentry/nextjs';
import { logger, type LogContext } from '@/lib/logger';
import { safeLogErrorContext } from '@/lib/errors';
import { isSafeIdentifier } from '@/lib/redact';

export type FailureArea =
  | 'bot'
  | 'flow'
  | 'custom_flow'
  | 'whatsapp_send'
  | 'whatsapp_webhook'
  | 'payment_webhook'
  | 'payment_success'
  | 'saved_card'
  | 'followup'
  | 'cron'
  | 'dashboard_api';

const AREAS: ReadonlySet<string> = new Set<FailureArea>([
  'bot', 'flow', 'custom_flow', 'whatsapp_send', 'whatsapp_webhook', 'payment_webhook',
  'payment_success', 'saved_card', 'followup', 'cron', 'dashboard_api',
]);

export interface FailureContext {
  area: FailureArea;
  /** Stable operation name, e.g. 'handle_message', 'paystack.invoice_rpc'. */
  op: string;
  businessId?: string | null;
  paymentId?: string | null;
  sessionId?: string | null;
  flowId?: string | null;
  flowType?: string | null;
  stepId?: string | null;
  capability?: string | null;
  gateway?: string | null;
  job?: string | null;
  /** Provider/DB error code when the error object does not carry one. */
  errorCode?: string | number | null;
  httpStatus?: number | null;
  requestId?: string | null;
  runId?: string | null;
  level?: 'error' | 'warning';
}

/** Marks events built here so beforeSend strips everything but our fields. */
export const FAILURE_REPORT_TAG = 'failure_report';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ID_FIELDS = ['businessId', 'paymentId', 'sessionId', 'flowId'] as const;
const LABEL_FIELDS = ['flowType', 'stepId', 'capability', 'gateway', 'job', 'requestId', 'runId'] as const;

const THROTTLE_WINDOW_MS = 60_000;
const THROTTLE_MAX_PER_WINDOW = 20;
const THROTTLE_MAX_KEYS = 500;
const throttle = new Map<string, { start: number; count: number }>();

const MAX_FRAMES = 30;
const MAX_FRAME_LENGTH = 300;
// V8 frame line: "    at fn (file:line:col)" or "    at file:line:col".
const FRAME_RE = /^\s+at .+:\d+:\d+\)?$/;

function safeLabel(value: unknown): string | undefined {
  return typeof value === 'string' && isSafeIdentifier(value) ? value : undefined;
}

function safeCode(value: unknown): string | undefined {
  if (typeof value === 'number') return Number.isInteger(value) && Math.abs(value) < 1e7 ? String(value) : undefined;
  return safeLabel(value);
}

function safeHttpStatus(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599 ? value : undefined;
}

function commitSha(): string | undefined {
  const sha = process.env.VERCEL_GIT_COMMIT_SHA;
  return sha && /^[0-9a-f]{7,40}$/i.test(sha) ? sha.slice(0, 12) : undefined;
}

/** Builds the validated field set. Exported for tests. */
export function buildFailureFields(error: unknown, ctx: FailureContext): Record<string, string> {
  const fields: Record<string, string> = {};
  fields.area = AREAS.has(ctx.area) ? ctx.area : 'unknown';
  fields.op = safeLabel(ctx.op) ?? 'unknown';

  for (const key of ID_FIELDS) {
    const value = ctx[key];
    if (typeof value === 'string' && UUID_RE.test(value)) fields[key] = value.toLowerCase();
  }
  for (const key of LABEL_FIELDS) {
    const value = safeLabel(ctx[key]);
    if (value) fields[key] = value;
  }

  const errCtx = safeLogErrorContext(error);
  fields.errorName = typeof errCtx.errorName === 'string' ? errCtx.errorName : 'Error';
  const errObj = error && typeof error === 'object' ? (error as Record<string, unknown>) : {};
  // Meta send errors carry a numeric code and HTTP status (lib/channels/meta-api-error.ts).
  const code = safeCode(ctx.errorCode) ?? (typeof errCtx.errorCode === 'string' ? errCtx.errorCode : undefined)
    ?? safeCode(errObj.metaErrorCode);
  if (code) fields.errorCode = code;
  const status = safeHttpStatus(ctx.httpStatus) ?? safeHttpStatus(errObj.httpStatus);
  if (status !== undefined) fields.httpStatus = String(status);

  const sha = commitSha();
  if (sha) fields.sha = sha;
  return fields;
}

/**
 * An Error with the original class name and stack frames, and a fixed message.
 * The original message (and any message lines that look like frames) is dropped.
 */
function scrubbedError(error: unknown, fields: Record<string, string>): Error {
  const message = `${fields.area}.${fields.op} failed`;
  const out = new Error(message);
  out.name = fields.errorName;
  if (error instanceof Error && typeof error.stack === 'string') {
    const messageLines = `${error.name}: ${error.message}`.split('\n').length;
    const frames = error.stack.split('\n').slice(messageLines)
      .filter(line => line.length <= MAX_FRAME_LENGTH && FRAME_RE.test(line))
      .slice(0, MAX_FRAMES);
    out.stack = [`${out.name}: ${message}`, ...frames].join('\n');
  }
  return out;
}

function allowSentry(key: string, now: number): boolean {
  const entry = throttle.get(key);
  if (!entry || now - entry.start >= THROTTLE_WINDOW_MS) {
    if (!entry && throttle.size >= THROTTLE_MAX_KEYS) throttle.clear();
    throttle.set(key, { start: now, count: 1 });
    return true;
  }
  entry.count += 1;
  return entry.count <= THROTTLE_MAX_PER_WINDOW;
}

/** Test-only: reset the per-instance throttle. */
export function resetFailureThrottle(): void {
  throttle.clear();
}

/**
 * Record a failure for diagnosis. Never throws and never changes what the
 * caller does next — call it beside the existing log line.
 */
export function reportFailure(error: unknown, ctx: FailureContext): void {
  try {
    const fields = buildFailureFields(error, ctx);
    const level = ctx.level === 'warning' ? 'warning' : 'error';

    // Logging and Sentry are independent: a logging failure must not stop the event.
    try {
      const log = logger.withContext({ op: 'failure.reported', ...fields } as LogContext);
      if (level === 'warning') log.warn('failure.reported');
      else log.error('failure.reported');
    } catch {
      // Fall through to Sentry.
    }

    const fingerprint = [fields.area, fields.op, fields.errorName, fields.errorCode ?? '-'];
    if (!allowSentry(fingerprint.join('|'), Date.now())) return;

    Sentry.captureException(scrubbedError(error, fields), {
      level,
      fingerprint,
      tags: { ...fields, [FAILURE_REPORT_TAG]: '1' },
    });
  } catch {
    // Tracking must never break the caller.
  }
}
