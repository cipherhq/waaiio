/**
 * reportFailure() privacy and safety tests (#1092).
 *
 * Proves that secrets, card data, phone numbers, emails and customer message
 * bodies never reach Sentry or the log line, that the helper never throws, and
 * that Sentry volume is throttled per fingerprint.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const captureException = vi.fn();
vi.mock('@sentry/nextjs', () => ({ captureException: (...args: unknown[]) => captureException(...args) }));

import { reportFailure, buildFailureFields, resetFailureThrottle, FAILURE_REPORT_TAG } from '@/lib/observability/report-failure';
import { scrubFailureReport, privateLinkScrubbers } from '@/lib/sentry-redact';
import { MetaApiError } from '@/lib/channels/meta-api-error';

const BIZ = '3f2c9a1e-8b7d-4c6e-9a5f-1d2e3c4b5a69';

// Values that must never leave reportFailure.
// Fake keys are assembled at runtime so secret scanners do not flag this file.
const FAKE_LIVE_KEY = ['sk', 'live', '51HxAbCdEfGhIjKlMnOpQrStUv'].join('_');
const FAKE_TEST_KEY = ['sk', 'test', '4eC39HqLyjWDarjtT1zdp7dc'].join('_');

const SECRETS = [
  FAKE_LIVE_KEY,
  FAKE_TEST_KEY,
  'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
  '4111111111111111',
  '4084 0840 8408 4081',
  'cvv=123',
  'pin 1234',
  '+2348012345678',
  'jane.doe@example.com',
  'I want 2 jollof rice to 12 Allen Avenue',
  'Insufficient Funds on card ending 4081',
];

function allOutput(): string {
  return JSON.stringify(captureException.mock.calls, (_k, v) =>
    v instanceof Error ? { name: v.name, message: v.message, stack: v.stack } : v);
}

describe('reportFailure — privacy', () => {
  let errSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  const oldFormat = process.env.LOG_FORMAT;

  beforeEach(() => {
    captureException.mockReset();
    resetFailureThrottle();
    process.env.LOG_FORMAT = 'json';
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    errSpy.mockRestore();
    warnSpy.mockRestore();
    process.env.LOG_FORMAT = oldFormat;
  });

  function logOutput(): string {
    return JSON.stringify([...errSpy.mock.calls, ...warnSpy.mock.calls]);
  }

  it('never sends the error message (secrets, card data, phone, email, message body)', () => {
    for (const secret of SECRETS) {
      reportFailure(new Error(`Provider said: ${secret}`), { area: 'payment_webhook', op: 'paystack.charge' });
    }
    const out = allOutput() + logOutput();
    for (const secret of SECRETS) expect(out).not.toContain(secret);
    expect(out).not.toContain('Provider said');
  });

  it('drops unsafe values passed as context fields', () => {
    for (const secret of SECRETS) {
      reportFailure(new Error('x'), {
        area: 'bot',
        op: secret,
        businessId: secret,
        paymentId: secret,
        sessionId: secret,
        flowId: secret,
        flowType: secret,
        stepId: secret,
        capability: secret,
        gateway: secret,
        job: secret,
        requestId: secret,
        runId: secret,
        errorCode: secret,
      });
    }
    const out = allOutput() + logOutput();
    for (const secret of SECRETS) expect(out).not.toContain(secret);
  });

  it('ignores keys outside the allowlist', () => {
    reportFailure(new Error('x'), {
      area: 'bot',
      op: 'handle_message',
      // @ts-expect-error — not a FailureContext field
      from: '+2348012345678',
      text: 'my card is 4111111111111111',
    });
    const out = allOutput() + logOutput();
    expect(out).not.toContain('2348012345678');
    expect(out).not.toContain('4111111111111111');
  });

  it('does not forward error properties, cause or provider payloads', () => {
    const err = new Error('boom') as Error & Record<string, unknown>;
    err.response = { gateway_response: 'Insufficient Funds', card: '4111111111111111' };
    err.cause = new Error(`authorization: Bearer ${FAKE_LIVE_KEY}`);
    err.code = 'card_declined';
    reportFailure(err, { area: 'saved_card', op: 'charge' });
    const [sent] = captureException.mock.calls[0];
    expect(sent).not.toBe(err);
    expect((sent as Error).cause).toBeUndefined();
    expect(Object.keys(sent as object)).toEqual(['name']); // only the validated class name is an own property
    const out = allOutput() + logOutput();
    expect(out).not.toContain('Insufficient Funds');
    expect(out).not.toContain('4111111111111111');
    expect(out).not.toContain('sk_live');
    expect(out).toContain('card_declined');
  });

  it('drops message lines that look like stack frames', () => {
    const err = new Error('first\n    at secret+2348012345678 (file.ts:1:1)');
    reportFailure(err, { area: 'bot', op: 'handle_message' });
    expect(allOutput()).not.toContain('2348012345678');
  });

  it('handles non-Error throwables (strings, Postgrest-style objects)', () => {
    reportFailure('jane.doe@example.com said hi', { area: 'flow', op: 'execute' });
    reportFailure({ message: 'duplicate key (phone)=(+2348012345678)', code: '23505', details: 'x' }, { area: 'followup', op: 'insert' });
    const out = allOutput() + logOutput();
    expect(out).not.toContain('jane.doe');
    expect(out).not.toContain('2348012345678');
    expect(out).toContain('23505');
  });
});

describe('reportFailure — useful, safe fields', () => {
  beforeEach(() => {
    captureException.mockReset();
    resetFailureThrottle();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('keeps class name, stack frames, validated ids, labels and codes', () => {
    const err = new MetaApiError('(#131047) Re-engagement message to +2348012345678', 400, 131047);
    reportFailure(err, {
      area: 'whatsapp_send', op: 'provider_send', businessId: BIZ.toUpperCase(),
      flowType: 'ordering', stepId: 'confirm_order', capability: 'ordering', gateway: 'paystack',
    });
    expect(captureException).toHaveBeenCalledTimes(1);
    const [sent, hint] = captureException.mock.calls[0] as [Error, { tags: Record<string, string>; fingerprint: string[]; level: string }];
    expect(sent.name).toBe('MetaApiError');
    expect(sent.message).toBe('whatsapp_send.provider_send failed');
    expect(sent.stack?.split('\n')[0]).toBe('MetaApiError: whatsapp_send.provider_send failed');
    expect(sent.stack).toMatch(/\n\s+at /);
    expect(sent.stack).not.toContain('2348012345678');
    expect(hint.tags).toMatchObject({
      area: 'whatsapp_send', op: 'provider_send', businessId: BIZ, flowType: 'ordering',
      stepId: 'confirm_order', capability: 'ordering', gateway: 'paystack',
      errorName: 'MetaApiError', errorCode: '131047', httpStatus: '400', [FAILURE_REPORT_TAG]: '1',
    });
    expect(hint.fingerprint).toEqual(['whatsapp_send', 'provider_send', 'MetaApiError', '131047']);
    expect(hint.level).toBe('error');
  });

  it('adds the short commit SHA when Vercel provides one', () => {
    const old = process.env.VERCEL_GIT_COMMIT_SHA;
    process.env.VERCEL_GIT_COMMIT_SHA = 'a801d52e9bcdef0123456789abcdef0123456789';
    expect(buildFailureFields(new Error('x'), { area: 'cron', op: 'run' }).sha).toBe('a801d52e9bcd');
    process.env.VERCEL_GIT_COMMIT_SHA = 'not a sha; rm -rf';
    expect(buildFailureFields(new Error('x'), { area: 'cron', op: 'run' }).sha).toBeUndefined();
    process.env.VERCEL_GIT_COMMIT_SHA = old;
  });

  it('rejects unknown areas and out-of-range HTTP statuses', () => {
    const fields = buildFailureFields(new Error('x'), {
      // @ts-expect-error — not a FailureArea
      area: 'whatever', op: 'x', httpStatus: 99999,
    });
    expect(fields.area).toBe('unknown');
    expect(fields.httpStatus).toBeUndefined();
  });

  it('honours level warning', () => {
    reportFailure(new Error('x'), { area: 'custom_flow', op: 'log_insert', level: 'warning' });
    expect((captureException.mock.calls[0][1] as { level: string }).level).toBe('warning');
  });
});

describe('reportFailure — never breaks the caller', () => {
  beforeEach(() => {
    captureException.mockReset();
    resetFailureThrottle();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('returns undefined synchronously and swallows a throwing Sentry', () => {
    captureException.mockImplementation(() => { throw new Error('sentry down'); });
    expect(reportFailure(new Error('x'), { area: 'bot', op: 'handle_message' })).toBeUndefined();
  });

  it('survives hostile inputs', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const getterBomb = Object.defineProperty({}, 'message', { get() { throw new Error('nope'); } });
    for (const input of [null, undefined, 42, Symbol('s'), cyclic, getterBomb]) {
      expect(() => reportFailure(input, { area: 'bot', op: 'x' })).not.toThrow();
    }
    // @ts-expect-error — hostile context
    expect(() => reportFailure(new Error('x'), null)).not.toThrow();
  });

  it('throttles Sentry to 20 events per fingerprint per minute, other fingerprints unaffected', () => {
    for (let i = 0; i < 50; i++) reportFailure(new Error('x'), { area: 'bot', op: 'handle_message' });
    expect(captureException).toHaveBeenCalledTimes(20);
    reportFailure(new Error('x'), { area: 'cron', op: 'backup' });
    expect(captureException).toHaveBeenCalledTimes(21);
  });
});

describe('scrubFailureReport (beforeSend)', () => {
  const event = {
    tags: { [FAILURE_REPORT_TAG]: '1', area: 'bot' },
    breadcrumbs: [{ message: 'console: +2348012345678 said "my pin is 1234"' }],
    extra: { body: 'secret' },
    user: { ip_address: '1.2.3.4' },
    request: { url: 'https://waaiio.com/api/x?phone=2348012345678#frag', method: 'POST', data: '{"card":"4111"}', cookies: { sb: 'x' }, query_string: 'phone=2348012345678' },
    exception: { values: [{ type: 'Error' }] },
  };

  it('strips breadcrumbs, extra, user and request data from failure reports', () => {
    const out = scrubFailureReport(event) as Record<string, unknown>;
    expect(out.breadcrumbs).toEqual([]);
    expect(out.extra).toBeUndefined();
    expect(out.user).toBeUndefined();
    expect(out.request).toEqual({ url: 'https://waaiio.com/api/x', method: 'POST' });
    expect(out.exception).toEqual(event.exception);
    expect(JSON.stringify(out)).not.toContain('2348012345678');
    expect(event.breadcrumbs).toHaveLength(1); // input not mutated
  });

  it('leaves other events unchanged', () => {
    const other = { ...event, tags: { area: 'bot' } };
    expect(scrubFailureReport(other)).toBe(other);
    expect(scrubFailureReport(null)).toBeNull();
  });

  it('runs inside the shared beforeSend after private-link scrubbing', () => {
    const token = 'A'.repeat(40);
    const out = privateLinkScrubbers.beforeSend({ ...event, request: { url: `https://w.com/intake/${token}?x=1` } }) as Record<string, unknown>;
    expect(out.request).toEqual({ url: 'https://w.com/intake/[token]' });
    expect(out.breadcrumbs).toEqual([]);
  });
});

describe('reportFailure — logging and Sentry are independent', () => {
  it('still reaches Sentry when the logger throws', async () => {
    captureException.mockReset();
    resetFailureThrottle();
    const { logger } = await import('@/lib/logger');
    const spy = vi.spyOn(logger, 'withContext').mockImplementation(() => { throw new Error('logger broken'); });
    reportFailure(new Error('x'), { area: 'bot', op: 'handle_message' });
    expect(captureException).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});
