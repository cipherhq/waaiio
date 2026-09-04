/**
 * Attempt Recording Unit Tests (#257)
 *
 * Tests gate ON/OFF behavior, ambiguous transport classification,
 * retry with fresh attempt IDs, and WAMID linking.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createAttempt,
  markSending,
  markAccepted,
  markFailed,
  markAmbiguous,
  isAmbiguousTransportError,
  is4xxError,
  setSendAttemptGate,
  AmbiguousSendError,
} from '@/lib/channels/attempt-recording';

// Mock logger
vi.mock('@/lib/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

function buildMockSupabase(options: { insertError?: boolean; updateError?: boolean; acceptedUpdateError?: boolean } = {}) {
  const insertedRows: Record<string, unknown>[] = [];
  const updatedRows: Array<{ id: string; data: Record<string, unknown> }> = [];

  const makeUpdateChain = (data: Record<string, unknown>) => ({
    eq: (col: string, val: string) => {
      if (options.updateError) return { error: { message: 'Update failed' } };
      if (options.acceptedUpdateError && (data as any).status === 'accepted') return { error: { message: 'Accepted update failed' } };
      updatedRows.push({ id: val, data });
      return { error: null };
    },
  });

  return {
    from: vi.fn().mockImplementation(() => ({
      insert: vi.fn().mockImplementation((data: Record<string, unknown>) => {
        if (options.insertError) return { select: () => ({ single: () => ({ data: null, error: { message: 'Insert failed' } }) }) };
        const id = 'attempt-' + Math.random().toString(36).slice(2, 8);
        insertedRows.push({ ...data, id });
        return { select: () => ({ single: () => ({ data: { id }, error: null }) }) };
      }),
      update: vi.fn().mockImplementation((data: Record<string, unknown>) => makeUpdateChain(data)),
    })),
    _insertedRows: insertedRows,
    _updatedRows: updatedRows,
  };
}

describe('Attempt recording (#257)', () => {
  beforeEach(() => {
    setSendAttemptGate(false); // default: gate OFF
  });

  // ── Gate OFF behavior ──

  it('Gate OFF: INSERT failure returns null (send proceeds)', async () => {
    const supabase = buildMockSupabase({ insertError: true });
    const result = await createAttempt(supabase as any, {
      businessId: 'biz-1',
      attemptScope: 'business',
      recipientPhone: '+1234',
    });
    expect(result).toBeNull();
  });

  it('Gate OFF: successful INSERT returns attempt ID', async () => {
    const supabase = buildMockSupabase();
    const result = await createAttempt(supabase as any, {
      businessId: 'biz-1',
      attemptScope: 'business',
      recipientPhone: '+1234',
    });
    expect(result).toBeTruthy();
    expect(result).toContain('attempt-');
  });

  // ── Gate ON behavior ──

  it('Gate ON: INSERT failure throws (zero Meta emission)', async () => {
    setSendAttemptGate(true);
    const supabase = buildMockSupabase({ insertError: true });
    await expect(createAttempt(supabase as any, {
      businessId: 'biz-1',
      attemptScope: 'business',
      recipientPhone: '+1234',
    })).rejects.toThrow('Gate ON');
  });

  // ── Ambiguous transport classification ──

  it('AbortSignal timeout is ambiguous', () => {
    expect(isAmbiguousTransportError(new Error('AbortError: The operation was aborted'))).toBe(true);
  });

  it('Connection reset is ambiguous', () => {
    expect(isAmbiguousTransportError(new Error('ECONNRESET'))).toBe(true);
  });

  it('Socket hang up is ambiguous', () => {
    expect(isAmbiguousTransportError(new Error('socket hang up'))).toBe(true);
  });

  it('DNS resolution failure is NOT ambiguous (never sent)', () => {
    expect(isAmbiguousTransportError(new Error('fetch failed: ENOTFOUND graph.facebook.com'))).toBe(false);
  });

  it('Normal server error is NOT ambiguous', () => {
    expect(isAmbiguousTransportError(new Error('Cloud API error: 500'))).toBe(false);
  });

  // ── 4xx classification ──

  it('4xx errors detected', () => {
    expect(is4xxError(new Error('Cloud API error: 400'))).toBe(true);
    expect(is4xxError(new Error('Cloud API error: 403'))).toBe(true);
    expect(is4xxError(new Error('Cloud API error: 500'))).toBe(false);
  });

  // ── Attempt state updates ──

  it('markSending updates status and sent_at', async () => {
    const supabase = buildMockSupabase();
    await markSending(supabase as any, 'test-id');
    expect(supabase._updatedRows).toHaveLength(1);
    expect(supabase._updatedRows[0].data.status).toBe('sending');
    expect(supabase._updatedRows[0].data.sent_at).toBeTruthy();
  });

  it('markAccepted links WAMID', async () => {
    const supabase = buildMockSupabase();
    await markAccepted(supabase as any, 'test-id', 'wamid.abc123');
    expect(supabase._updatedRows[0].data.status).toBe('accepted');
    expect(supabase._updatedRows[0].data.meta_message_id).toBe('wamid.abc123');
  });

  it('markAccepted: DB failure throws WamidPersistenceError (not failed_send)', async () => {
    const supabase = buildMockSupabase({ acceptedUpdateError: true });
    await expect(markAccepted(supabase as any, 'test-id', 'wamid.lost'))
      .rejects.toThrow('WAMID persistence failed');
    try {
      await markAccepted(supabase as any, 'test-id', 'wamid.lost');
    } catch (err) {
      expect((err as any).attemptId).toBe('test-id');
      expect((err as any).wamid).toBe('wamid.lost');
    }
  });

  it('markSending: Gate ON failure throws (zero Meta emission)', async () => {
    setSendAttemptGate(true);
    const supabase = buildMockSupabase({ updateError: true });
    await expect(markSending(supabase as any, 'test-id')).rejects.toThrow('Gate ON');
  });

  it('markSending: Gate OFF failure logs and returns (best-effort)', async () => {
    setSendAttemptGate(false);
    const supabase = buildMockSupabase({ updateError: true });
    // Should not throw
    await markSending(supabase as any, 'test-id');
  });

  it('markFailed sets failed_send', async () => {
    const supabase = buildMockSupabase();
    await markFailed(supabase as any, 'test-id');
    expect(supabase._updatedRows[0].data.status).toBe('failed_send');
  });

  it('markAmbiguous sets ambiguous + needs_reconciliation', async () => {
    const supabase = buildMockSupabase();
    await markAmbiguous(supabase as any, 'test-id');
    expect(supabase._updatedRows[0].data.status).toBe('ambiguous');
    expect(supabase._updatedRows[0].data.needs_reconciliation).toBe(true);
  });

  // ── AmbiguousSendError ──

  it('AmbiguousSendError carries attemptId', () => {
    const err = new AmbiguousSendError('timeout', 'attempt-123');
    expect(err.isAmbiguous).toBe(true);
    expect(err.attemptId).toBe('attempt-123');
    expect(err instanceof Error).toBe(true);
  });

  // ── Platform scope ──

  it('Platform scope attempt has null business_id', async () => {
    const supabase = buildMockSupabase();
    await createAttempt(supabase as any, {
      businessId: null,
      attemptScope: 'platform',
      recipientPhone: '+1234',
    });
    expect(supabase._insertedRows[0].business_id).toBeNull();
    expect(supabase._insertedRows[0].attempt_scope).toBe('platform');
  });
});
