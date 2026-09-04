/**
 * Edge Function attempt recording tests (#257)
 *
 * Tests the ACTUAL shared withEdgeAttemptRecording from
 * supabase/functions/_shared/attempt-recording.ts.
 * Runtime-neutral — the module avoids Deno-specific imports.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolve } from 'path';

// Import the actual shared production module
const sharedModule = await import(resolve(__dirname, '../../supabase/functions/_shared/attempt-recording.ts'));
const { withEdgeAttemptRecording, setEdgeAttemptGate } = sharedModule;

interface MockRow { id: string; status: string; needs_reconciliation: boolean; meta_message_id: string | null }

function buildEdgeMock(opts: { insertError?: boolean; sendingUpdateError?: boolean; acceptedUpdateError?: boolean } = {}) {
  const rows = new Map<string, MockRow>();
  return {
    from: vi.fn().mockImplementation(() => ({
      insert: vi.fn().mockImplementation((data: Record<string, unknown>) => ({
        select: () => ({
          single: () => {
            if (opts.insertError) return { data: null, error: { message: 'Insert failed' } };
            const id = 'edge-' + Math.random().toString(36).slice(2, 8);
            rows.set(id, { id, status: data.status as string, needs_reconciliation: false, meta_message_id: null });
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
    _rows: rows,
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

  it('Structural: all 4 direct API routes import attempt recording', async () => {
    const { readFileSync } = await import('fs');
    const routes = [
      'app/api/cron/payout-nudge/route.ts',
      'app/api/recurring/verify/route.ts',
      'app/api/admin/otp/route.ts',
      'app/api/auth/otp/send/route.ts',
    ];
    for (const route of routes) {
      const src = readFileSync(resolve(__dirname, '../..', route), 'utf-8');
      expect(src, `${route} missing attempt recording`).toContain('createAttempt');
    }
  });
});
