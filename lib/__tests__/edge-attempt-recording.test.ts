/**
 * Edge Function attempt recording tests (#257 + #261)
 *
 * Tests the ACTUAL shared withEdgeAttemptRecording from
 * supabase/functions/_shared/attempt-recording.ts.
 * Runtime-neutral — the module avoids Deno-specific imports.
 *
 * #261 additions: financial authorization gate, settlement on failure,
 * unmatched status drain, message category, country resolution.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolve } from 'path';

// Import the actual shared production module
const sharedModule = await import(resolve(__dirname, '../../supabase/functions/_shared/attempt-recording.ts'));
const { withEdgeAttemptRecording, setEdgeAttemptGate } = sharedModule;

interface MockRow { id: string; status: string; needs_reconciliation: boolean; meta_message_id: string | null; financial_disposition: string; recipient_country_code?: string; message_category?: string }

function buildEdgeMock(opts: {
  insertError?: boolean; sendingUpdateError?: boolean; acceptedUpdateError?: boolean;
  rpcResult?: Record<string, unknown>; rpcError?: { message: string } | null;
} = {}) {
  const rows = new Map<string, MockRow>();
  const rpcCalls: Array<{ fn: string; params: Record<string, unknown> }> = [];
  return {
    from: vi.fn().mockImplementation(() => ({
      insert: vi.fn().mockImplementation((data: Record<string, unknown>) => ({
        select: () => ({
          single: () => {
            if (opts.insertError) return { data: null, error: { message: 'Insert failed' } };
            const id = 'edge-' + Math.random().toString(36).slice(2, 8);
            rows.set(id, { id, status: data.status as string, needs_reconciliation: false, meta_message_id: null, financial_disposition: data.financial_disposition as string });
            return { data: { id }, error: null };
          },
        }),
      })),
      update: vi.fn().mockImplementation((data: Record<string, unknown>) => ({
        eq: (col: string, val: string) => {
          if (opts.sendingUpdateError && (data as any).status === 'sending') return { error: { message: 'Sending failed' } };
          if (opts.acceptedUpdateError && (data as any).status === 'accepted') return { error: { message: 'Accept failed' } };
          const row = rows.get(val);
          if (row) Object.assign(row, data);
          return { error: null };
        },
      })),
      select: vi.fn().mockImplementation(() => ({
        eq: () => ({
          maybeSingle: () => ({ data: { messaging_suspended: false }, error: null }),
        }),
      })),
    })),
    rpc: vi.fn().mockImplementation((fn: string, params: Record<string, unknown>) => {
      rpcCalls.push({ fn, params });
      if (fn === 'check_or_authorize_send') {
        if (opts.rpcError) return Promise.resolve({ data: null, error: opts.rpcError });
        return Promise.resolve({ data: opts.rpcResult ?? { enforcement_required: false }, error: null });
      }
      if (fn === 'settle_message_cost') {
        return Promise.resolve({ data: { settled: true }, error: null });
      }
      if (fn === 'drain_unmatched_attempt_statuses') {
        return Promise.resolve({ data: { drained: 0 }, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    }),
    _rows: rows,
    _rpcCalls: rpcCalls,
  };
}

describe('Shared Edge withEdgeAttemptRecording (actual production module)', () => {
  beforeEach(() => setEdgeAttemptGate(false));

  it('Gate OFF: INSERT failure => send proceeds', async () => {
    const mock = buildEdgeMock({ insertError: true });
    const fetchFn = vi.fn().mockResolvedValue(new Response(JSON.stringify({ messages: [{ id: 'w1' }] }), { status: 200 }));
    const r = await withEdgeAttemptRecording(mock as any, { businessId: 'b1', recipientPhone: '+1' }, fetchFn);
    expect(r.ok).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('Gate ON: INSERT failure => zero Meta fetch', async () => {
    setEdgeAttemptGate(true);
    const mock = buildEdgeMock({ insertError: true });
    const fetchFn = vi.fn();
    const r = await withEdgeAttemptRecording(mock as any, { businessId: 'b1', recipientPhone: '+1' }, fetchFn);
    expect(r.ok).toBe(false);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('Gate ON: markSending failure => zero Meta fetch', async () => {
    setEdgeAttemptGate(true);
    const mock = buildEdgeMock({ sendingUpdateError: true });
    const fetchFn = vi.fn();
    const r = await withEdgeAttemptRecording(mock as any, { businessId: 'b1', recipientPhone: '+1' }, fetchFn);
    expect(r.ok).toBe(false);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('Successful send links WAMID', async () => {
    const mock = buildEdgeMock();
    const fetchFn = vi.fn().mockResolvedValue(new Response(JSON.stringify({ messages: [{ id: 'wamid.e1' }] }), { status: 200 }));
    const r = await withEdgeAttemptRecording(mock as any, { businessId: 'b1', recipientPhone: '+1' }, fetchFn);
    expect(r.ok).toBe(true);
    const row = Array.from(mock._rows.values())[0];
    expect(row?.status).toBe('accepted');
    expect(row?.meta_message_id).toBe('wamid.e1');
  });

  it('Ambiguous transport => attempt marked ambiguous', async () => {
    const mock = buildEdgeMock();
    const fetchFn = vi.fn().mockRejectedValue(new Error('AbortError: timeout'));
    try { await withEdgeAttemptRecording(mock as any, { businessId: 'b1', recipientPhone: '+1' }, fetchFn); } catch {}
    const row = Array.from(mock._rows.values())[0];
    expect(row?.status).toBe('ambiguous');
    expect(row?.needs_reconciliation).toBe(true);
  });

  it('Suspension check => attempt exists + zero Meta fetch', async () => {
    const mock = buildEdgeMock();
    const fetchFn = vi.fn();
    const r = await withEdgeAttemptRecording(
      mock as any,
      { businessId: 'b1', recipientPhone: '+1' },
      fetchFn,
      async () => false, // suspended
    );
    expect(r.ok).toBe(false);
    expect(fetchFn).not.toHaveBeenCalled();
    // Attempt was created but stays pending_authorization
    expect(r.attemptId).toBeTruthy();
    const row = mock._rows.get(r.attemptId!);
    expect(row?.status).toBe('pending_authorization');
  });

  it('WAMID persistence failure => needs_reconciliation + no resend', async () => {
    const mock = buildEdgeMock({ acceptedUpdateError: true });
    const fetchFn = vi.fn().mockResolvedValue(new Response(JSON.stringify({ messages: [{ id: 'wamid.lost' }] }), { status: 200 }));
    const r = await withEdgeAttemptRecording(mock as any, { businessId: 'b1', recipientPhone: '+1' }, fetchFn);
    // Returns ok=true (message was sent), must not trigger resend
    expect(r.ok).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    // Reconciliation fallback should have set needs_reconciliation
    const row = Array.from(mock._rows.values())[0];
    expect(row?.needs_reconciliation).toBe(true);
  });

  it('Structural: all 12 Edge functions import withEdgeAttemptRecording', async () => {
    const { readFileSync } = await import('fs');
    const funcsDir = resolve(__dirname, '../../supabase/functions');
    const edgeFuncs = ['abandoned-cart-reminder', 'birthday-campaign', 'booking-reminders', 'chat-timeout',
      'contract-reminders', 'customer-reengagement', 'generate-sign-link', 'low-stock-alerts',
      'noshow-reschedule', 'process-sequences', 'recurring-reminder', 'waitlist-expiration'];
    for (const func of edgeFuncs) {
      const src = readFileSync(resolve(funcsDir, func, 'index.ts'), 'utf-8');
      expect(src, `${func} missing withEdgeAttemptRecording`).toContain('withEdgeAttemptRecording');
    }
  });

  it('Structural: all 4 direct API routes use attempt recording', async () => {
    const { readFileSync } = await import('fs');
    const checks: Array<[string, string]> = [
      ['app/api/cron/payout-nudge/route.ts', 'executePayoutNudgeSend'],
      ['app/api/recurring/verify/route.ts', 'withDirectRouteAttempt'],
      ['app/api/admin/otp/route.ts', 'withDirectRouteAttempt'],
      ['app/api/auth/otp/send/route.ts', 'orchestrateOtpSend'],
    ];
    for (const [route, expected] of checks) {
      const src = readFileSync(resolve(__dirname, '../..', route), 'utf-8');
      expect(src, `${route} missing ${expected}`).toContain(expected);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #261: Financial authorization tests for edge functions
// ─────────────────────────────────────────────────────────────────────────────
describe('Edge #261 financial authorization', () => {
  beforeEach(() => setEdgeAttemptGate(false));

  it('Gate OFF (enforcement_required=false): send proceeds, zero financial encumbrance', async () => {
    const mock = buildEdgeMock({ rpcResult: { enforcement_required: false } });
    const fetchFn = vi.fn().mockResolvedValue(new Response(JSON.stringify({ messages: [{ id: 'w1' }] }), { status: 200 }));
    const r = await withEdgeAttemptRecording(mock as any, { businessId: 'b1', recipientPhone: '+2348001234567', messageCategory: 'utility' }, fetchFn);
    expect(r.ok).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    // check_or_authorize_send was called
    expect(mock._rpcCalls.some((c: any) => c.fn === 'check_or_authorize_send')).toBe(true);
    // No settle_message_cost called (no reservation)
    expect(mock._rpcCalls.filter((c: any) => c.fn === 'settle_message_cost')).toHaveLength(0);
  });

  it('Gate ON, authorized=true: reservation exists, send proceeds', async () => {
    const mock = buildEdgeMock({ rpcResult: { authorized: true, enforcement_required: true } });
    const fetchFn = vi.fn().mockResolvedValue(new Response(JSON.stringify({ messages: [{ id: 'w2' }] }), { status: 200 }));
    const r = await withEdgeAttemptRecording(mock as any, { businessId: 'b1', recipientPhone: '+2348001234567', messageCategory: 'utility' }, fetchFn);
    expect(r.ok).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    // drain_unmatched_attempt_statuses called after WAMID linkage
    expect(mock._rpcCalls.some((c: any) => c.fn === 'drain_unmatched_attempt_statuses')).toBe(true);
  });

  it('Gate ON, authorized=false: zero Meta calls', async () => {
    const mock = buildEdgeMock({ rpcResult: { authorized: false, reason: 'insufficient_balance', enforcement_required: true } });
    const fetchFn = vi.fn();
    const r = await withEdgeAttemptRecording(mock as any, { businessId: 'b1', recipientPhone: '+2348001234567', messageCategory: 'utility' }, fetchFn);
    expect(r.ok).toBe(false);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('RPC error: fail closed, zero Meta calls', async () => {
    const mock = buildEdgeMock({ rpcError: { message: 'connection refused' } });
    const fetchFn = vi.fn();
    const r = await withEdgeAttemptRecording(mock as any, { businessId: 'b1', recipientPhone: '+2348001234567' }, fetchFn);
    expect(r.ok).toBe(false);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('RPC returns null: fail closed, zero Meta calls', async () => {
    const mock = buildEdgeMock();
    // Override rpc to return null data
    mock.rpc.mockImplementation((fn: string) => {
      if (fn === 'check_or_authorize_send') return Promise.resolve({ data: null, error: null });
      return Promise.resolve({ data: null, error: null });
    });
    const fetchFn = vi.fn();
    const r = await withEdgeAttemptRecording(mock as any, { businessId: 'b1', recipientPhone: '+2348001234567' }, fetchFn);
    expect(r.ok).toBe(false);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('Unexpected response shape: fail closed, zero Meta calls', async () => {
    const mock = buildEdgeMock({ rpcResult: { something_unexpected: true } });
    const fetchFn = vi.fn();
    const r = await withEdgeAttemptRecording(mock as any, { businessId: 'b1', recipientPhone: '+2348001234567' }, fetchFn);
    expect(r.ok).toBe(false);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('Reserved + deterministic provider failure => immediate release', async () => {
    const mock = buildEdgeMock({ rpcResult: { authorized: true, enforcement_required: true } });
    // Provider returns 400 (non-ok, deterministic failure)
    const fetchFn = vi.fn().mockResolvedValue(new Response('{"error":"bad request"}', { status: 400 }));
    const r = await withEdgeAttemptRecording(mock as any, { businessId: 'b1', recipientPhone: '+2348001234567', messageCategory: 'utility' }, fetchFn);
    expect(r.ok).toBe(false);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    // settle_message_cost('released') was called
    const settleCalls = mock._rpcCalls.filter((c: any) => c.fn === 'settle_message_cost');
    expect(settleCalls).toHaveLength(1);
    expect(settleCalls[0].params.p_outcome).toBe('released');
  });

  it('Reserved + transport exception (non-ambiguous) => release', async () => {
    const mock = buildEdgeMock({ rpcResult: { authorized: true, enforcement_required: true } });
    const fetchFn = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    try {
      await withEdgeAttemptRecording(mock as any, { businessId: 'b1', recipientPhone: '+2348001234567', messageCategory: 'utility' }, fetchFn);
    } catch { /* expected */ }
    const settleCalls = mock._rpcCalls.filter((c: any) => c.fn === 'settle_message_cost');
    expect(settleCalls).toHaveLength(1);
    expect(settleCalls[0].params.p_outcome).toBe('released');
  });

  it('Reserved + ambiguous transport => remains reserved (no release)', async () => {
    const mock = buildEdgeMock({ rpcResult: { authorized: true, enforcement_required: true } });
    const fetchFn = vi.fn().mockRejectedValue(new Error('AbortError: timeout'));
    try {
      await withEdgeAttemptRecording(mock as any, { businessId: 'b1', recipientPhone: '+2348001234567', messageCategory: 'utility' }, fetchFn);
    } catch { /* expected */ }
    // No settle_message_cost called — remains reserved for reconciliation
    const settleCalls = mock._rpcCalls.filter((c: any) => c.fn === 'settle_message_cost');
    expect(settleCalls).toHaveLength(0);
    // Attempt marked ambiguous
    const row = Array.from(mock._rows.values())[0];
    expect(row?.status).toBe('ambiguous');
    expect(row?.needs_reconciliation).toBe(true);
  });

  it('Not reserved + provider failure => no settle call', async () => {
    const mock = buildEdgeMock({ rpcResult: { enforcement_required: false } });
    const fetchFn = vi.fn().mockResolvedValue(new Response('error', { status: 500 }));
    const r = await withEdgeAttemptRecording(mock as any, { businessId: 'b1', recipientPhone: '+2348001234567' }, fetchFn);
    expect(r.ok).toBe(false);
    // No settle_message_cost called (no reservation existed)
    expect(mock._rpcCalls.filter((c: any) => c.fn === 'settle_message_cost')).toHaveLength(0);
  });

  it('WAMID linkage triggers drain_unmatched_attempt_statuses', async () => {
    const mock = buildEdgeMock({ rpcResult: { enforcement_required: false } });
    const fetchFn = vi.fn().mockResolvedValue(new Response(JSON.stringify({ messages: [{ id: 'wamid.drain-test' }] }), { status: 200 }));
    const r = await withEdgeAttemptRecording(mock as any, { businessId: 'b1', recipientPhone: '+2348001234567' }, fetchFn);
    expect(r.ok).toBe(true);
    const drainCalls = mock._rpcCalls.filter((c: any) => c.fn === 'drain_unmatched_attempt_statuses');
    expect(drainCalls).toHaveLength(1);
    expect(drainCalls[0].params.p_meta_message_id).toBe('wamid.drain-test');
  });

  it('Reserved + markSending failure => zero Meta emission (cross-state protection)', async () => {
    const mock = buildEdgeMock({ sendingUpdateError: true, rpcResult: { authorized: true, enforcement_required: true } });
    const fetchFn = vi.fn();
    const r = await withEdgeAttemptRecording(mock as any, { businessId: 'b1', recipientPhone: '+2348001234567' }, fetchFn);
    expect(r.ok).toBe(false);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('Structural: all 12 Edge functions pass messageCategory', async () => {
    const { readFileSync } = await import('fs');
    const funcsDir = resolve(__dirname, '../../supabase/functions');
    const edgeFuncs = ['abandoned-cart-reminder', 'birthday-campaign', 'booking-reminders', 'chat-timeout',
      'contract-reminders', 'customer-reengagement', 'generate-sign-link', 'low-stock-alerts',
      'noshow-reschedule', 'process-sequences', 'recurring-reminder', 'waitlist-expiration'];
    for (const func of edgeFuncs) {
      const src = readFileSync(resolve(funcsDir, func, 'index.ts'), 'utf-8');
      expect(src, `${func} missing messageCategory`).toContain('messageCategory');
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #261: Main sender null-Supabase fail-closed test
// ─────────────────────────────────────────────────────────────────────────────
describe('Main sender #261 null-Supabase fail-closed', () => {
  it('Gate ON + business-scoped send without Supabase client => throws before Meta emission', async () => {
    // Import the actual modules
    const { MetaCloudSender } = await import(resolve(__dirname, '../channels/message-sender.ts'));
    const { setSendAttemptGate } = await import(resolve(__dirname, '../channels/attempt-recording.ts'));
    const providerFn = vi.fn().mockResolvedValue({ messageId: 'test' });
    const mockCloud = { sendText: providerFn } as any;
    // Enable the attempt gate (production mode)
    setSendAttemptGate(true);
    try {
      // Construct WITHOUT Supabase client — null means no attempt authority
      const sender = new MetaCloudSender(mockCloud, null);
      // Bind a business — this makes it a business-scoped sender
      sender.bindBusiness('business-123');
      await expect(
        sender.sendText('+2348001234567', 'test message'),
      ).rejects.toThrow('Business send requires attempt authority');
      expect(providerFn).not.toHaveBeenCalled();
    } finally {
      // Restore gate to OFF for other tests
      setSendAttemptGate(false);
    }
  });
});
