/**
 * Direct-route attempt recording tests (#257)
 *
 * Tests withDirectRouteAttempt for Gate ON/OFF, ambiguity,
 * WAMID persistence, and missing-credentials behavior.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

// Mock attempt-recording module
const mockCreateAttempt = vi.fn();
const mockMarkSending = vi.fn();
const mockMarkAccepted = vi.fn();
const mockMarkFailed = vi.fn();
const mockMarkAmbiguous = vi.fn();
let mockGateOn = false;

vi.mock('@/lib/channels/attempt-recording', () => ({
  createAttempt: (...args: unknown[]) => mockCreateAttempt(...args),
  markSending: (...args: unknown[]) => mockMarkSending(...args),
  markAccepted: (...args: unknown[]) => mockMarkAccepted(...args),
  markFailed: (...args: unknown[]) => mockMarkFailed(...args),
  markAmbiguous: (...args: unknown[]) => mockMarkAmbiguous(...args),
  isAmbiguousTransportError: (err: Error) => /abort|timeout|econnreset/i.test(err.message),
  isSendAttemptGateOn: () => mockGateOn,
}));

import { withDirectRouteAttempt } from '@/lib/channels/direct-route-attempt';

describe('withDirectRouteAttempt (#257)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGateOn = false;
    mockCreateAttempt.mockResolvedValue('attempt-1');
    mockMarkSending.mockResolvedValue(undefined);
    mockMarkAccepted.mockResolvedValue(undefined);
    mockMarkFailed.mockResolvedValue(undefined);
    mockMarkAmbiguous.mockResolvedValue(undefined);
  });

  it('Gate OFF: createAttempt failure => send proceeds', async () => {
    mockCreateAttempt.mockRejectedValue(new Error('DB down'));
    const fetchFn = vi.fn().mockResolvedValue(new Response(JSON.stringify({ messages: [{ id: 'w1' }] }), { status: 200 }));
    const r = await withDirectRouteAttempt({} as any, { businessId: null, attemptScope: 'platform', recipientPhone: '+1' }, fetchFn);
    expect(r.ok).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('Gate ON: createAttempt failure => zero Meta call', async () => {
    mockGateOn = true;
    mockCreateAttempt.mockRejectedValue(new Error('Gate ON: failed'));
    const fetchFn = vi.fn();
    await expect(withDirectRouteAttempt({} as any, { businessId: null, attemptScope: 'platform', recipientPhone: '+1' }, fetchFn))
      .rejects.toThrow('Gate ON');
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('Gate ON: markSending failure => zero Meta call', async () => {
    mockGateOn = true;
    mockMarkSending.mockRejectedValue(new Error('Gate ON: failed'));
    const fetchFn = vi.fn();
    await expect(withDirectRouteAttempt({} as any, { businessId: null, attemptScope: 'platform', recipientPhone: '+1' }, fetchFn))
      .rejects.toThrow('Gate ON');
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('Ambiguous transport => attempt marked ambiguous, result.ambiguous=true', async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error('ECONNRESET'));
    const r = await withDirectRouteAttempt({} as any, { businessId: null, attemptScope: 'platform', recipientPhone: '+1' }, fetchFn);
    expect(r.ok).toBe(false);
    expect(r.ambiguous).toBe(true);
    expect(mockMarkAmbiguous).toHaveBeenCalledWith({}, 'attempt-1');
  });

  it('Provider 4xx => attempt marked failed_send', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response('error', { status: 400 }));
    const r = await withDirectRouteAttempt({} as any, { businessId: null, attemptScope: 'platform', recipientPhone: '+1' }, fetchFn);
    expect(r.ok).toBe(false);
    expect(mockMarkFailed).toHaveBeenCalledWith({}, 'attempt-1');
  });

  it('Success with WAMID => accepted with exact WAMID', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response(JSON.stringify({ messages: [{ id: 'wamid.exact' }] }), { status: 200 }));
    const r = await withDirectRouteAttempt({} as any, { businessId: null, attemptScope: 'platform', recipientPhone: '+1' }, fetchFn);
    expect(r.ok).toBe(true);
    expect(r.wamid).toBe('wamid.exact');
    expect(mockMarkAccepted).toHaveBeenCalledWith({}, 'attempt-1', 'wamid.exact');
  });

  it('Success without WAMID (parse failure) => reconciliation, NOT accepted with empty WAMID', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response('not json', { status: 200 }));
    const r = await withDirectRouteAttempt({} as any, { businessId: null, attemptScope: 'platform', recipientPhone: '+1' }, fetchFn);
    expect(r.ok).toBe(true);
    expect(r.wamid).toBeUndefined();
    // markAccepted should NOT be called with empty WAMID
    expect(mockMarkAccepted).not.toHaveBeenCalled();
  });

  it('WAMID persistence failure => no resend, attempt stays sending+reconciliation', async () => {
    mockMarkAccepted.mockRejectedValue(new Error('DB error'));
    const fetchFn = vi.fn().mockResolvedValue(new Response(JSON.stringify({ messages: [{ id: 'wamid.lost' }] }), { status: 200 }));
    const r = await withDirectRouteAttempt({} as any, { businessId: null, attemptScope: 'platform', recipientPhone: '+1' }, fetchFn);
    expect(r.ok).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});
