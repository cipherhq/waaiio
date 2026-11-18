/**
 * reportFailure() wiring tests (#1092): the tracking call is added beside
 * existing handling and changes nothing the caller returns, throws or sends.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const reportFailure = vi.fn();
vi.mock('@/lib/observability/report-failure', () => ({ reportFailure: (...a: unknown[]) => reportFailure(...a) }));

const resumeFollowup = vi.fn();
vi.mock('@/lib/bot/transaction-followups', () => ({
  resumeTransactionFollowupForPayment: (...a: unknown[]) => resumeFollowup(...a),
  claimTransactionCardStep: vi.fn(),
}));
vi.mock('@/lib/payments/saved-card-offer', () => ({
  checkAndOfferSavedCard: vi.fn(), checkSavedCardOfferEligibility: vi.fn(),
  checkStripeConsentAndOffer: vi.fn(), retryPendingSavedCardOffer: vi.fn(),
}));

import { createCronLogger } from '@/lib/observability/cron';
import { resumePaidTransactionFollowup } from '@/lib/payments/transaction-followup';
import { MetaCloudSender } from '@/lib/channels/message-sender';
import { MetaApiError } from '@/lib/channels/meta-api-error';
import { CustomFlowEngine } from '@/lib/bot/custom-flow/engine';

const BIZ = '3f2c9a1e-8b7d-4c6e-9a5f-1d2e3c4b5a69';
const PAY = '7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';

beforeEach(() => {
  reportFailure.mockReset();
  resumeFollowup.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

describe('createCronLogger', () => {
  it('failed() and itemFailed() still log and now report, returning nothing', () => {
    const cron = createCronLogger('payment-reconciliation');
    const err = new Error('db down');
    expect(cron.failed(err, { processedCount: 3 })).toBeUndefined();
    expect(cron.itemFailed(err, { businessId: BIZ, paymentId: PAY, gateway: 'paystack' })).toBeUndefined();
    expect(console.error).toHaveBeenCalledTimes(2);
    expect(reportFailure).toHaveBeenNthCalledWith(1, err, { area: 'cron', op: 'cron.failed', job: 'payment-reconciliation', runId: cron.runId });
    expect(reportFailure).toHaveBeenNthCalledWith(2, err, {
      area: 'cron', op: 'cron.item_failed', job: 'payment-reconciliation', runId: cron.runId,
      businessId: BIZ, paymentId: PAY, gateway: 'paystack',
    });
  });
});

/** Supabase stub: each from(table) resolves maybeSingle() with the queued result for that table. */
function stubDb(results: Record<string, { data: unknown; error: unknown }>) {
  const calls: string[] = [];
  const builder = (table: string) => {
    const q: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'in', 'limit']) q[m] = () => q;
    q.maybeSingle = () => Promise.resolve(results[table]);
    q.then = (r: (v: unknown) => void) => r(results[table]);
    return q;
  };
  return { calls, db: { from: (t: string) => { calls.push(t); return builder(t); } } };
}

describe('resumePaidTransactionFollowup', () => {
  it('follow-up read error: same early return, no resume, failure reported', async () => {
    const dbErr = { message: 'permission denied for +2348012345678', code: '42501' };
    const { db, calls } = stubDb({ transaction_followups: { data: null, error: dbErr } });
    await expect(resumePaidTransactionFollowup(db as never, PAY)).resolves.toBeUndefined();
    expect(calls).toEqual(['transaction_followups']);
    expect(resumeFollowup).not.toHaveBeenCalled();
    expect(reportFailure).toHaveBeenCalledWith(dbErr, { area: 'followup', op: 'resume_paid.followup_read', paymentId: PAY });
  });

  it('no follow-up row (no error): same early return, nothing reported', async () => {
    const { db } = stubDb({ transaction_followups: { data: null, error: null } });
    await resumePaidTransactionFollowup(db as never, PAY);
    expect(reportFailure).not.toHaveBeenCalled();
  });

  it('payment read error: same early return, failure reported with business', async () => {
    const payErr = { message: 'timeout', code: '57014' };
    const { db, calls } = stubDb({
      transaction_followups: { data: { business_id: BIZ, phone: '+2348012345678', channel_id: 'c', state: 'waiting_card' }, error: null },
      customer_suspensions: { data: null, error: null },
      payments: { data: null, error: payErr },
    });
    await resumePaidTransactionFollowup(db as never, PAY);
    // #1103: the suspension status is read before the payment (no row = clear).
    expect(calls).toEqual(['transaction_followups', 'customer_suspensions', 'payments']);
    expect(resumeFollowup).not.toHaveBeenCalled();
    expect(reportFailure).toHaveBeenCalledWith(payErr, { area: 'followup', op: 'resume_paid.payment_read', paymentId: PAY, businessId: BIZ });
  });
});

describe('MetaCloudSender provider failure', () => {
  it('rethrows the identical error and reports it', async () => {
    const providerErr = new MetaApiError('Cloud API error: 400 re-engagement', 400, 131047);
    const cloud = { sendText: vi.fn().mockRejectedValue(providerErr) };
    const sender = new MetaCloudSender(cloud as never, null);
    await expect(sender.sendPlatformText({ to: '+2348012345678', text: 'hi' })).rejects.toBe(providerErr);
    expect(cloud.sendText).toHaveBeenCalledTimes(1);
    expect(reportFailure).toHaveBeenCalledWith(providerErr, { area: 'whatsapp_send', op: 'provider_send', businessId: '' });
  });
});

describe('CustomFlowEngine log insert', () => {
  it('a rejected custom_flow_logs insert is reported and never thrown', async () => {
    const insertErr = { message: 'new row violates row-level security', code: '42501' };
    const supabase = { from: () => ({ insert: () => Promise.resolve({ data: null, error: insertErr }) }) };
    const engine = new CustomFlowEngine({ supabase, sender: {} } as never);
    const session = { id: '11111111-2222-4333-8444-555555555555', business_id: BIZ, flow_id: PAY, current_node_id: 'n1' };
    await expect((engine as unknown as { log: (...a: unknown[]) => Promise<void> })
      .log(session, 'n1', 'in', 'customer text', null)).resolves.toBeUndefined();
    expect(reportFailure).toHaveBeenCalledWith(insertErr, {
      area: 'custom_flow', op: 'log_insert', businessId: BIZ, flowId: PAY, sessionId: session.id, level: 'warning',
    });
  });

  it('a successful insert reports nothing', async () => {
    const supabase = { from: () => ({ insert: () => Promise.resolve({ data: null, error: null }) }) };
    const engine = new CustomFlowEngine({ supabase, sender: {} } as never);
    await (engine as unknown as { log: (...a: unknown[]) => Promise<void> })
      .log({ id: 's', business_id: BIZ, flow_id: PAY }, 'n1', 'out', null, 'x');
    expect(reportFailure).not.toHaveBeenCalled();
  });
});
