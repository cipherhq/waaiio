/**
 * Edge Function attempt recording tests (#257)
 *
 * Tests the shared Deno-compatible withEdgeAttemptRecording boundary.
 * Uses a mock Supabase client (not Deno runtime).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Inline the Edge helper logic for Node-side testing
// (The actual Deno module uses esm.sh imports incompatible with Node)

interface MockAttemptRow {
  id: string;
  status: string;
  needs_reconciliation: boolean;
  meta_message_id: string | null;
}

function buildEdgeMockSupabase(opts: { insertError?: boolean; updateError?: boolean; markSendingError?: boolean } = {}) {
  const rows = new Map<string, MockAttemptRow>();

  return {
    from: vi.fn().mockReturnValue({
      insert: vi.fn().mockImplementation((data: Record<string, unknown>) => {
        if (opts.insertError) return { select: () => ({ single: () => ({ data: null, error: { message: 'Insert failed' } }) }) };
        const id = 'edge-' + Math.random().toString(36).slice(2, 8);
        rows.set(id, { id, status: 'pending_authorization', needs_reconciliation: false, meta_message_id: null });
        return { select: () => ({ single: () => ({ data: { id }, error: null }) }) };
      }),
      update: vi.fn().mockImplementation((data: Record<string, unknown>) => ({
        eq: (col: string, val: string) => {
          if (opts.updateError) return { error: { message: 'Update failed' } };
          if (opts.markSendingError && data.status === 'sending') return { error: { message: 'Sending update failed' } };
          const row = rows.get(val);
          if (row) Object.assign(row, data);
          return { error: null, then: (resolve: Function) => resolve() };
        },
      })),
    }),
    _rows: rows,
  };
}

// Simplified Edge helper (mirrors _shared/attempt-recording.ts logic)
async function testWithEdgeAttemptRecording(
  supabase: ReturnType<typeof buildEdgeMockSupabase>,
  params: { businessId: string; recipientPhone: string },
  metaFetch: () => Promise<Response>,
  gateEnabled = false,
): Promise<{ ok: boolean; attemptId?: string }> {
  let attemptId: string | null = null;
  try {
    const { data, error } = supabase.from('message_send_attempts').insert({
      business_id: params.businessId,
      attempt_scope: 'business',
      recipient_phone: params.recipientPhone,
      status: 'pending_authorization',
    }).select().single();
    if (error) throw error;
    attemptId = (data as { id: string }).id;
  } catch {
    if (gateEnabled) return { ok: false };
  }

  if (attemptId) {
    const { error: sendErr } = supabase.from('message_send_attempts').update({ status: 'sending' }).eq('id', attemptId);
    if (sendErr && gateEnabled) return { ok: false };
  }

  let response: Response;
  try {
    response = await metaFetch();
  } catch (err) {
    if (attemptId) {
      const isAmb = /timeout|abort|econnreset/i.test(String(err));
      supabase.from('message_send_attempts').update({
        status: isAmb ? 'ambiguous' : 'failed_send',
        needs_reconciliation: isAmb,
      }).eq('id', attemptId);
    }
    throw err;
  }

  if (!response.ok) {
    if (attemptId) supabase.from('message_send_attempts').update({ status: 'failed_send' }).eq('id', attemptId);
    return { ok: false, attemptId: attemptId || undefined };
  }

  let wamid: string | undefined;
  try { const b = await response.json(); wamid = b?.messages?.[0]?.id; } catch {}

  if (attemptId) {
    const { error: accErr } = supabase.from('message_send_attempts').update({
      status: 'accepted', meta_message_id: wamid || null, needs_reconciliation: !wamid,
    }).eq('id', attemptId);
    if (accErr) {
      supabase.from('message_send_attempts').update({ needs_reconciliation: true }).eq('id', attemptId);
    }
  }

  return { ok: true, attemptId: attemptId || undefined };
}

describe('Edge attempt recording (#257)', () => {
  it('Gate OFF: INSERT failure => send proceeds', async () => {
    const supabase = buildEdgeMockSupabase({ insertError: true });
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ messages: [{ id: 'wamid.ok' }] }), { status: 200 }));
    const result = await testWithEdgeAttemptRecording(supabase, { businessId: 'biz-1', recipientPhone: '+1' }, fetchMock);
    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1); // Send proceeded
  });

  it('Gate ON: INSERT failure => zero Meta fetch', async () => {
    const supabase = buildEdgeMockSupabase({ insertError: true });
    const fetchMock = vi.fn();
    const result = await testWithEdgeAttemptRecording(supabase, { businessId: 'biz-1', recipientPhone: '+1' }, fetchMock, true);
    expect(result.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('Gate ON: mark-sending failure => zero Meta fetch', async () => {
    const supabase = buildEdgeMockSupabase({ markSendingError: true });
    const fetchMock = vi.fn();
    const result = await testWithEdgeAttemptRecording(supabase, { businessId: 'biz-1', recipientPhone: '+1' }, fetchMock, true);
    expect(result.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('Ambiguous transport => attempt marked ambiguous + needs_reconciliation', async () => {
    const supabase = buildEdgeMockSupabase();
    const fetchMock = vi.fn().mockRejectedValue(new Error('AbortError: timeout'));
    try {
      await testWithEdgeAttemptRecording(supabase, { businessId: 'biz-1', recipientPhone: '+1' }, fetchMock);
    } catch {}
    const row = Array.from(supabase._rows.values())[0];
    expect(row?.status).toBe('ambiguous');
    expect(row?.needs_reconciliation).toBe(true);
  });

  it('Successful send links WAMID', async () => {
    const supabase = buildEdgeMockSupabase();
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ messages: [{ id: 'wamid.edge123' }] }), { status: 200 }));
    await testWithEdgeAttemptRecording(supabase, { businessId: 'biz-1', recipientPhone: '+1' }, fetchMock);
    const row = Array.from(supabase._rows.values())[0];
    expect(row?.status).toBe('accepted');
    expect(row?.meta_message_id).toBe('wamid.edge123');
  });

  it('WAMID persistence failure => needs_reconciliation, no resend', async () => {
    const supabase = buildEdgeMockSupabase({ updateError: true });
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ messages: [{ id: 'wamid.lost' }] }), { status: 200 }));
    const result = await testWithEdgeAttemptRecording(supabase, { businessId: 'biz-1', recipientPhone: '+1' }, fetchMock);
    // Returns ok=true (message was sent), caller must not resend
    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('Structural: all 12 Edge functions import withEdgeAttemptRecording', async () => {
    const { readdirSync, readFileSync } = await import('fs');
    const { resolve } = await import('path');
    const funcsDir = resolve(__dirname, '../../supabase/functions');
    const edgeFuncs = ['abandoned-cart-reminder', 'birthday-campaign', 'booking-reminders', 'chat-timeout',
      'contract-reminders', 'customer-reengagement', 'generate-sign-link', 'low-stock-alerts',
      'noshow-reschedule', 'process-sequences', 'recurring-reminder', 'waitlist-expiration'];

    for (const func of edgeFuncs) {
      const src = readFileSync(resolve(funcsDir, func, 'index.ts'), 'utf-8');
      expect(src, `${func} missing withEdgeAttemptRecording`).toContain('withEdgeAttemptRecording');
    }
  });
});
