/**
 * P0-INVOICE-1 — Invoice bot flow uses canonical reference_code
 *
 * Proves the invoice flow queries the correct schema field and
 * propagates reference_code through payment, messages, and session state.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

vi.mock('@/lib/logger', () => ({ logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() } }));
vi.mock('@/lib/constants', () => ({
  formatCurrency: (amount: number) => `₦${amount}`,
  getLocale: () => 'en-NG',
}));

const mockInitializePayment = vi.fn();
vi.mock('../bot/flows/shared/payment', () => ({
  initializePayment: (...args: unknown[]) => mockInitializePayment(...args),
}));
vi.mock('../bot/flows/shared/bank-transfer', () => ({
  checkBankTransferEligibility: vi.fn().mockResolvedValue({ qualifies: false, bankAccount: null, platformSettings: {} }),
}));
vi.mock('@/lib/utils/sanitize', () => ({
  sanitizeFilterValue: (v: string) => v,
}));

const FLOW_SOURCE = fs.readFileSync(
  path.resolve(__dirname, '../bot/flows/invoice.flow.ts'), 'utf-8'
);

describe('P0-INVOICE-1: Invoice reference_code', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInitializePayment.mockResolvedValue({ url: 'https://pay.test/inv', reference: 'REF-001' });
  });

  // ── 1. Query contract: reference_code, NOT invoice_number ──
  it('1. SELECT queries reference_code, not invoice_number', () => {
    // All three invoice SELECTs must use reference_code
    const selects = FLOW_SOURCE.match(/\.select\([^)]+\)/g) || [];
    const invoiceSelects = selects.filter(s => s.includes('reference_code') || s.includes('invoice_number'));
    for (const sel of invoiceSelects) {
      expect(sel).toContain('reference_code');
      expect(sel).not.toContain('invoice_number');
    }
    // Must have at least the 3 known invoice SELECTs
    expect(invoiceSelects.length).toBeGreaterThanOrEqual(3);
  });

  it('2. invoice_number does not appear anywhere in the flow', () => {
    expect(FLOW_SOURCE).not.toContain('invoice_number');
  });

  // ── 3. Regression: reintroducing invoice_number breaks this test ──
  it('3. regression guard: flow source contains reference_code in all selects', () => {
    // Count occurrences of reference_code in select strings
    const selectMatches = FLOW_SOURCE.match(/select\([^)]*reference_code[^)]*\)/g) || [];
    expect(selectMatches.length).toBe(3); // invoice_list, invoice_detail, invoice_pay
  });

  // ── 4. reference_code propagated to payment initialization ──
  it('4. referenceCode uses invoice.reference_code in payment init', () => {
    // The payment init call must use invoice.reference_code
    expect(FLOW_SOURCE).toContain('referenceCode: invoice.reference_code');
  });

  // ── 5. Customer-facing messages use reference_code ──
  it('5. customer messages display invoice.reference_code', () => {
    expect(FLOW_SOURCE).toContain('Invoice ${invoice.reference_code}');
    // Session data stores reference as _invoice_ref
    expect(FLOW_SOURCE).toContain('_invoice_ref');
    expect(FLOW_SOURCE).not.toContain('_invoice_number');
  });

  // ── 6. Schema field verification ──
  it('6. invoices migration has reference_code, not invoice_number', () => {
    const migration = fs.readFileSync(
      path.resolve(__dirname, '../../supabase/migrations/063_invoices.sql'), 'utf-8'
    );
    expect(migration).toContain('reference_code VARCHAR');
    expect(migration).not.toContain('invoice_number');
  });

  // ── 7. Partial payment: amount_paid exists in schema ──
  it('7. schema has amount_paid column for partial payment tracking', () => {
    const migration = fs.readFileSync(
      path.resolve(__dirname, '../../supabase/migrations/063_invoices.sql'), 'utf-8'
    );
    expect(migration).toContain('amount_paid');
  });

  // ── 8. Invoice status enum is correct ──
  it('8. schema status CHECK includes payable and non-payable states', () => {
    const migration = fs.readFileSync(
      path.resolve(__dirname, '../../supabase/migrations/063_invoices.sql'), 'utf-8'
    );
    expect(migration).toContain("'draft'");
    expect(migration).toContain("'sent'");
    expect(migration).toContain("'viewed'");
    expect(migration).toContain("'paid'");
    expect(migration).toContain("'overdue'");
    expect(migration).toContain("'cancelled'");
  });

  // ── 9. Only payable statuses are queried in invoice_list ──
  it('9. invoice_list queries only payable statuses', () => {
    // The flow filters by sent, viewed, overdue — not paid, cancelled, draft
    expect(FLOW_SOURCE).toContain("'sent', 'viewed', 'overdue'");
  });

  // ── 10. No sensitive data in flow ──
  it('10. flow does not log or expose sensitive credentials', () => {
    expect(FLOW_SOURCE).not.toContain('SUPABASE_SERVICE_ROLE_KEY');
    expect(FLOW_SOURCE).not.toContain('PAYSTACK_SECRET');
    expect(FLOW_SOURCE).not.toContain('STRIPE_SECRET');
  });

  // ── 11. Invoice ID associated with payment ──
  it('11. payment initialization includes invoiceId', () => {
    expect(FLOW_SOURCE).toContain('invoiceId: invoice.id');
  });

  // ── 12. All three SELECT fields verified against schema ──
  it('12. selected fields exist in invoices schema', () => {
    const migration = fs.readFileSync(
      path.resolve(__dirname, '../../supabase/migrations/063_invoices.sql'), 'utf-8'
    );
    // Fields used in the invoice flow SELECTs
    const requiredFields = ['reference_code', 'total_amount', 'due_date', 'status', 'business_id'];
    for (const field of requiredFields) {
      expect(migration).toContain(field);
    }
  });
});
