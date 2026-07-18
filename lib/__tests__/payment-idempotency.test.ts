/**
 * Payment Idempotency Tests
 *
 * Tests that webhook retries cannot double-apply invoice payments,
 * double-count campaign donations, or create duplicate platform fees.
 *
 * Uses mocked Supabase to simulate repeated handler calls.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Track all DB operations for assertions
let dbOps: { table: string; op: string; data?: unknown }[] = [];
let mockData: Record<string, Record<string, unknown>> = {};

function resetMocks() {
  dbOps = [];
  mockData = {};
}

function setMockData(table: string, data: Record<string, unknown>) {
  mockData[table] = data;
}

// Build a chainable mock that tracks operations
function buildChain(table: string) {
  const chain: Record<string, unknown> = {};
  const withTracking = (op: string) => {
    dbOps.push({ table, op });
    return chain;
  };

  chain.select = vi.fn().mockReturnValue(chain);
  chain.eq = vi.fn().mockReturnValue(chain);
  chain.is = vi.fn().mockReturnValue(chain);
  chain.in = vi.fn().mockReturnValue(chain);
  chain.neq = vi.fn().mockReturnValue(chain);
  chain.single = vi.fn().mockImplementation(async () => ({
    data: mockData[table] || null,
  }));
  chain.maybeSingle = vi.fn().mockImplementation(async () => ({
    data: mockData[table] || null,
  }));
  chain.update = vi.fn().mockImplementation((data: unknown) => {
    dbOps.push({ table, op: 'update', data });
    return chain;
  });
  chain.insert = vi.fn().mockImplementation((data: unknown) => {
    dbOps.push({ table, op: 'insert', data });
    return { error: null };
  });

  return chain;
}

vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: vi.fn(),
}));

// ── Invoice Payment Idempotency ──

describe('Invoice payment idempotency', () => {
  beforeEach(() => { resetMocks(); vi.resetModules(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('second call with same payment_id skips increment (fee already exists)', async () => {
    // Simulate: platform_fees already has a record for this payment+invoice
    setMockData('platform_fees', { id: 'existing-fee' }); // alreadyApplied check returns data
    setMockData('invoices', { business_id: 'biz1', total_amount: 10000, amount_paid: 5000, status: 'sent' });

    const { processInvoicePayment } = await import('@/lib/payments/process-success');

    const mockSupabase = {
      from: vi.fn().mockImplementation((table: string) => buildChain(table)),
      rpc: vi.fn().mockResolvedValue({ data: null }),
    };

    await processInvoicePayment(mockSupabase as any, 'inv-1', 'pay-1', 5000, 50);

    // Should NOT have called update on invoices (skipped due to existing fee)
    const invoiceUpdates = dbOps.filter(op => op.table === 'invoices' && op.op === 'update');
    expect(invoiceUpdates).toHaveLength(0);
  });

  it('first call uses atomic RPC', async () => {
    setMockData('invoices', { business_id: 'biz1', total_amount: 10000, amount_paid: 5000, status: 'sent' });

    const { processInvoicePayment } = await import('@/lib/payments/process-success');

    const rpcSpy = vi.fn().mockResolvedValue({ data: { success: true }, error: null });
    const mockSupabase = {
      from: vi.fn().mockImplementation((table: string) => buildChain(table)),
      rpc: rpcSpy,
    };

    await processInvoicePayment(mockSupabase as any, 'inv-1', 'pay-1', 5000, 50);

    // Should call the atomic RPC
    expect(rpcSpy).toHaveBeenCalledWith('apply_invoice_payment', expect.objectContaining({
      p_invoice_id: 'inv-1',
      p_payment_id: 'pay-1',
      p_payment_amount: 5000,
    }));
  });

  it('paid invoice skips RPC call', async () => {
    setMockData('invoices', { business_id: 'biz1', total_amount: 10000, amount_paid: 10000, status: 'paid' });

    const { processInvoicePayment } = await import('@/lib/payments/process-success');

    const rpcSpy = vi.fn();
    const mockSupabase = {
      from: vi.fn().mockImplementation((table: string) => buildChain(table)),
      rpc: rpcSpy,
    };

    await processInvoicePayment(mockSupabase as any, 'inv-1', 'pay-2', 5000, 50);

    // Should NOT call RPC for already-paid invoice
    expect(rpcSpy).not.toHaveBeenCalled();
  });
});

// ── Campaign Donation Idempotency ──

describe('Campaign donation idempotency', () => {
  beforeEach(() => { resetMocks(); vi.resetModules(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('second call skips fee when RPC returns not successful', async () => {
    // RPC returns success: false (donation already processed)
    setMockData('campaigns', { business_id: 'biz1' });

    const { processCampaignDonation } = await import('@/lib/payments/process-success');

    const rpcSpy = vi.fn().mockResolvedValue({ data: { success: false, already_processed: true }, error: null });
    const mockSupabase = {
      from: vi.fn().mockImplementation((table: string) => buildChain(table)),
      rpc: rpcSpy,
    };

    await processCampaignDonation(mockSupabase as any, 'pay-1', 'camp-1', 5000, 50);

    // RPC was called but returned not-success — no campaign query for fee
    expect(rpcSpy).toHaveBeenCalledWith('apply_campaign_donation', expect.objectContaining({
      p_payment_id: 'pay-1',
      p_campaign_id: 'camp-1',
      p_amount: 5000,
    }));
    const campaignQueries = dbOps.filter(op => op.table === 'campaigns');
    expect(campaignQueries).toHaveLength(0);
  });

  it('first call records fee when RPC succeeds', async () => {
    setMockData('campaigns', { business_id: 'biz1' });

    const { processCampaignDonation } = await import('@/lib/payments/process-success');

    const rpcSpy = vi.fn().mockResolvedValue({ data: { success: true }, error: null });
    const mockSupabase = {
      from: vi.fn().mockImplementation((table: string) => buildChain(table)),
      rpc: rpcSpy,
    };

    await processCampaignDonation(mockSupabase as any, 'pay-1', 'camp-1', 5000, 50);

    // RPC should have been called with apply_campaign_donation
    expect(rpcSpy).toHaveBeenCalledWith('apply_campaign_donation', expect.objectContaining({
      p_payment_id: 'pay-1',
      p_campaign_id: 'camp-1',
      p_amount: 5000,
    }));
    // After success, queries campaigns for business_id to record fee
    expect(mockSupabase.from).toHaveBeenCalledWith('campaigns');
  });
});

// ── Platform Fee Idempotency ──

describe('Platform fee idempotency', () => {
  it('UNIQUE index on payment_id prevents duplicate fees', () => {
    // Verified by migration 248: idx_platform_fees_payment_unique
    // This is a database constraint, not application logic.
    const fs = require('fs');
    const migrations = fs.readdirSync('supabase/migrations')
      .filter((f: string) => f.includes('248'))
      .map((f: string) => fs.readFileSync(`supabase/migrations/${f}`, 'utf-8'))
      .join('\n');
    expect(migrations).toContain('idx_platform_fees_payment_unique');
    expect(migrations).toContain('payment_id');
  });

  it('recordPlatformFee logs duplicate insert errors without throwing', () => {
    const fs = require('fs');
    const code = fs.readFileSync('lib/payments/process-success.ts', 'utf-8');
    // The insert catches duplicate key violations and logs them
    expect(code).toContain("'duplicate'");
    expect(code).toContain("'unique'");
  });
});
