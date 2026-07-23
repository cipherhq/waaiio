/**
 * Observability Foundation Tests
 *
 * Covers:
 * - Logger formatter selection (dev/keyval/json)
 * - JSON output structure
 * - Existing key=value compatibility
 * - Request ID extraction
 * - observe() success/failure/timing
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Logger formatter tests (structural) ──

describe('Logger infrastructure', () => {
  const loggerCode = require('fs').readFileSync('lib/logger.ts', 'utf-8');

  it('supports LOG_FORMAT env var for format selection', () => {
    expect(loggerCode).toContain('LOG_FORMAT');
    expect(loggerCode).toContain("'json'");
    expect(loggerCode).toContain("'keyval'");
    expect(loggerCode).toContain("'dev'");
  });

  it('defaults to json in production, dev in development', () => {
    expect(loggerCode).toContain("!== 'production' ? 'dev' : 'json'");
  });

  it('preserves existing withContext API', () => {
    expect(loggerCode).toContain('withContext(ctx: LogContext): Logger');
  });

  it('preserves generateRequestId export', () => {
    expect(loggerCode).toContain('export function generateRequestId');
  });

  it('exports LogContext type', () => {
    expect(loggerCode).toContain('export type LogContext');
  });

  it('exports Logger interface', () => {
    expect(loggerCode).toContain('export interface Logger');
  });

  it('JSON format includes level, msg, ts, and context fields', () => {
    expect(loggerCode).toContain("level,");
    expect(loggerCode).toContain("msg,");
    expect(loggerCode).toContain("ts:");
    expect(loggerCode).toContain('JSON.stringify(entry)');
  });

  it('extracts stack traces via a formatStack helper', () => {
    expect(loggerCode).toContain('function formatStack(error: Error)');
    expect(loggerCode).toContain('entry.stack = formatStack(a)');
  });

  it('resolves format at log time, not module load time', () => {
    // No cached `const logFormat = ...` at module level
    expect(loggerCode).not.toMatch(/^const logFormat/m);
    // getLogFormat() is called inside formatArgs
    const formatArgsFn = loggerCode.substring(
      loggerCode.indexOf('function formatArgs'),
      loggerCode.indexOf('return {'),
    );
    expect(formatArgsFn).toContain('getLogFormat()');
  });

  it('keyval format uses uppercase level prefix', () => {
    expect(loggerCode).toContain('level.toUpperCase()');
  });
});

// ── Logger behavioral tests ──

describe('Logger JSON output', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('produces valid JSON when LOG_FORMAT=json', async () => {
    vi.resetModules();
    process.env.LOG_FORMAT = 'json';
    process.env.NODE_ENV = 'production';

    const captured: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      captured.push(String(args[0]));
    });

    const { createTestLogger } = await getLoggerFactory();
    const log = createTestLogger({ requestId: 'test-123' });
    log.info('Payment processed');

    expect(captured.length).toBe(1);
    const parsed = JSON.parse(captured[0]);
    expect(parsed.level).toBe('info');
    expect(parsed.msg).toBe('Payment processed');
    expect(parsed.requestId).toBe('test-123');
    expect(parsed.ts).toBeDefined();
  });

  it('produces key=value when LOG_FORMAT=keyval', async () => {
    vi.resetModules();
    process.env.LOG_FORMAT = 'keyval';
    process.env.NODE_ENV = 'production';

    const captured: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      captured.push(String(args[0]));
    });

    const { createTestLogger } = await getLoggerFactory();
    const log = createTestLogger({ gateway: 'paystack' });
    log.info('Charge initiated');

    expect(captured.length).toBe(1);
    expect(captured[0]).toContain('[INFO]');
    expect(captured[0]).toContain('Charge initiated');
    expect(captured[0]).toContain('gateway=paystack');
  });

  it('includes error stack in JSON output', async () => {
    vi.resetModules();
    process.env.LOG_FORMAT = 'json';
    process.env.NODE_ENV = 'production';

    const captured: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      captured.push(String(args[0]));
    });

    const { createTestLogger } = await getLoggerFactory();
    const log = createTestLogger();
    log.error('Something broke', new Error('test error'));

    const parsed = JSON.parse(captured[0]);
    expect(parsed.level).toBe('error');
    expect(parsed.msg).toContain('test error');
    expect(parsed.stack).toBeDefined();
  });

  afterEach(() => {
    delete process.env.LOG_FORMAT;
    delete process.env.NODE_ENV;
  });
});

// ── Observability helper tests ──

describe('Observability helpers', () => {
  const obsCode = require('fs').readFileSync('lib/observability.ts', 'utf-8');

  it('exports getRequestId', () => {
    expect(obsCode).toContain('export function getRequestId');
  });

  it('exports generateRunId', () => {
    expect(obsCode).toContain('export function generateRunId');
  });

  it('exports observe function', () => {
    expect(obsCode).toContain('export async function observe');
  });

  it('exports observeWithTiming function', () => {
    expect(obsCode).toContain('export async function observeWithTiming');
  });

  it('getRequestId reads x-request-id header', () => {
    expect(obsCode).toContain("'x-request-id'");
  });

  it('generateRunId produces a run- prefixed ID', () => {
    expect(obsCode).toContain('`run-');
  });

  it('observe measures duration with performance.now', () => {
    expect(obsCode).toContain('performance.now()');
  });

  it('observe re-throws errors (does not swallow)', () => {
    expect(obsCode).toContain('throw error');
  });
});

describe('getRequestId behavior', () => {
  it('returns x-request-id from headers when present', async () => {
    const { getRequestId } = await import('@/lib/observability');
    const request = new Request('http://localhost/test', {
      headers: { 'x-request-id': 'abc-123' },
    });
    expect(getRequestId(request)).toBe('abc-123');
  });

  it('generates a new ID when header is missing', async () => {
    const { getRequestId } = await import('@/lib/observability');
    const request = new Request('http://localhost/test');
    const id = getRequestId(request);
    expect(id).toBeDefined();
    expect(id.length).toBe(8);
  });
});

describe('generateRunId behavior', () => {
  it('produces a run- prefixed string', async () => {
    const { generateRunId } = await import('@/lib/observability');
    const id = generateRunId();
    expect(id).toMatch(/^run-[a-f0-9]{8}$/);
  });
});

describe('observe() behavior', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it('returns the result of the wrapped function', async () => {
    const { observe } = await import('@/lib/observability');
    const result = await observe('test.op', {}, async () => 42);
    expect(result).toBe(42);
  });

  it('re-throws errors from the wrapped function', async () => {
    const { observe } = await import('@/lib/observability');
    await expect(
      observe('test.fail', {}, async () => { throw new Error('boom'); })
    ).rejects.toThrow('boom');
  });

  it('logs completion with duration', async () => {
    const prevFormat = process.env.LOG_FORMAT;
    process.env.LOG_FORMAT = 'json';
    try {
      const captured: string[] = [];
      vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
        captured.push(String(args[0]));
      });

      const { observe } = await import('@/lib/observability');
      await observe('test.timed', {}, async () => {
        await new Promise(r => setTimeout(r, 10));
        return 'ok';
      });

      const completionRaw = captured.find(l => l.includes('test.timed') && l.includes('completed'));
      expect(completionRaw).toBeDefined();
      const entry = JSON.parse(completionRaw!);
      expect(entry.msg).toContain('test.timed');
      expect(entry.msg).toContain('completed');
      // durationMs is serialized into the msg field as a JSON object fragment
      const durationMatch = entry.msg.match(/"durationMs"\s*:\s*(\d+)/);
      expect(durationMatch).not.toBeNull();
      const durationMs = parseInt(durationMatch![1], 10);
      expect(durationMs).toBeGreaterThanOrEqual(0);
    } finally {
      if (prevFormat === undefined) delete process.env.LOG_FORMAT;
      else process.env.LOG_FORMAT = prevFormat;
    }
  });

  it('logs failure with duration on error', async () => {
    const prevFormat = process.env.LOG_FORMAT;
    process.env.LOG_FORMAT = 'json';
    try {
      const captured: string[] = [];
      vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
        captured.push(String(args[0]));
      });

      const { observe } = await import('@/lib/observability');
      try {
        await observe('test.errored', {}, async () => { throw new Error('fail'); });
      } catch { /* expected */ }

      const failRaw = captured.find(l => l.includes('test.errored') && l.includes('failed'));
      expect(failRaw).toBeDefined();
      const entry = JSON.parse(failRaw!);
      expect(entry.msg).toContain('test.errored');
      expect(entry.msg).toContain('failed');
      const durationMatch = entry.msg.match(/"durationMs"\s*:\s*(\d+)/);
      expect(durationMatch).not.toBeNull();
      const durationMs = parseInt(durationMatch![1], 10);
      expect(durationMs).toBeGreaterThanOrEqual(0);
    } finally {
      if (prevFormat === undefined) delete process.env.LOG_FORMAT;
      else process.env.LOG_FORMAT = prevFormat;
    }
  });
});

describe('observeWithTiming() behavior', () => {
  it('returns result and durationMs', async () => {
    const { observeWithTiming } = await import('@/lib/observability');
    const { result, durationMs } = await observeWithTiming('test.timing', {}, async () => 'hello');
    expect(result).toBe('hello');
    expect(typeof durationMs).toBe('number');
    expect(durationMs).toBeGreaterThanOrEqual(0);
  });
});

describe('Middleware request-id forwarding', () => {
  const middlewareCode = require('fs').readFileSync('middleware.ts', 'utf-8');

  it('forwards x-request-id into request headers', () => {
    expect(middlewareCode).toContain("request.headers.set('x-request-id', requestId)");
  });

  it('sets x-request-id on response headers', () => {
    expect(middlewareCode).toContain("supabaseResponse.headers.set('x-request-id', requestId)");
  });
});

// ── Helper to get logger factory for testing different formats ──

async function getLoggerFactory() {
  // Dynamic import to pick up env var changes
  const mod = await import('@/lib/logger');
  return {
    createTestLogger: (ctx?: Record<string, string | number | boolean>) => {
      return ctx ? mod.logger.withContext(ctx) : mod.logger;
    },
  };
}
