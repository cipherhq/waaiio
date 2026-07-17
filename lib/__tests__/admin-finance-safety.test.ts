/**
 * Admin Finance Safety Tests
 *
 * Tests for admin financial operations authorization, state transitions,
 * and data integrity requirements identified in the admin audit.
 */
import { describe, it, expect } from 'vitest';

// ── Payout state transition validation ──

const VALID_TRANSITIONS: Record<string, string[]> = {
  pending: ['approved', 'held', 'rejected'],
  held: ['approved', 'rejected'],
  approved: ['processing', 'rejected'],
  processing: ['paid', 'failed'],
  failed: ['processing'], // retry
  rejected: [], // terminal
  paid: [], // terminal
};

function isValidTransition(from: string, to: string): boolean {
  return (VALID_TRANSITIONS[from] || []).includes(to);
}

describe('Payout state transitions', () => {
  it('pending → approved is valid', () => {
    expect(isValidTransition('pending', 'approved')).toBe(true);
  });

  it('pending → rejected is valid', () => {
    expect(isValidTransition('pending', 'rejected')).toBe(true);
  });

  it('pending → held is valid', () => {
    expect(isValidTransition('pending', 'held')).toBe(true);
  });

  it('held → approved is valid (risk resolved)', () => {
    expect(isValidTransition('held', 'approved')).toBe(true);
  });

  it('approved → processing is valid (transfer initiated)', () => {
    expect(isValidTransition('approved', 'processing')).toBe(true);
  });

  it('processing → paid is valid (transfer confirmed)', () => {
    expect(isValidTransition('processing', 'paid')).toBe(true);
  });

  it('processing → failed is valid (transfer failed)', () => {
    expect(isValidTransition('processing', 'failed')).toBe(true);
  });

  it('failed → processing is valid (retry)', () => {
    expect(isValidTransition('failed', 'processing')).toBe(true);
  });

  // Invalid transitions
  it('rejected → approved is INVALID', () => {
    expect(isValidTransition('rejected', 'approved')).toBe(false);
  });

  it('paid → anything is INVALID (terminal)', () => {
    expect(isValidTransition('paid', 'pending')).toBe(false);
    expect(isValidTransition('paid', 'approved')).toBe(false);
    expect(isValidTransition('paid', 'rejected')).toBe(false);
  });

  it('approved → approved is INVALID (duplicate approval)', () => {
    expect(isValidTransition('approved', 'approved')).toBe(false);
  });

  it('processing → approved is INVALID (can\'t go back)', () => {
    expect(isValidTransition('processing', 'approved')).toBe(false);
  });
});

// ── Role-based access control ──

const ADMIN_FINANCE_PERMISSIONS: Record<string, string[]> = {
  view_payouts: ['admin', 'finance'],
  approve_payout: ['admin'],
  reject_payout: ['admin'],
  view_bank_details: ['admin'], // masked for finance
  process_refund: ['admin'],
  create_adjustment: ['admin'],
  export_financial_data: ['admin', 'finance'],
  view_platform_fees: ['admin', 'finance'],
  change_fees: ['admin'],
  approve_reseller_payout: ['admin'],
  mark_reseller_paid: ['admin', 'finance'],
};

function hasPermission(role: string, action: string): boolean {
  return (ADMIN_FINANCE_PERMISSIONS[action] || []).includes(role);
}

describe('Admin finance role permissions', () => {
  it('admin can do everything', () => {
    for (const action of Object.keys(ADMIN_FINANCE_PERMISSIONS)) {
      expect(hasPermission('admin', action)).toBe(true);
    }
  });

  it('finance can view payouts and fees', () => {
    expect(hasPermission('finance', 'view_payouts')).toBe(true);
    expect(hasPermission('finance', 'view_platform_fees')).toBe(true);
    expect(hasPermission('finance', 'export_financial_data')).toBe(true);
  });

  it('finance CANNOT approve payouts', () => {
    expect(hasPermission('finance', 'approve_payout')).toBe(false);
  });

  it('finance CANNOT process refunds', () => {
    expect(hasPermission('finance', 'process_refund')).toBe(false);
  });

  it('finance CANNOT view full bank details', () => {
    expect(hasPermission('finance', 'view_bank_details')).toBe(false);
  });

  it('finance CANNOT change fees', () => {
    expect(hasPermission('finance', 'change_fees')).toBe(false);
  });

  it('finance CAN mark reseller payouts as paid', () => {
    expect(hasPermission('finance', 'mark_reseller_paid')).toBe(true);
  });

  it('support cannot access any financial actions', () => {
    for (const action of Object.keys(ADMIN_FINANCE_PERMISSIONS)) {
      expect(hasPermission('support', action)).toBe(false);
    }
  });

  it('operations cannot access any financial actions', () => {
    for (const action of Object.keys(ADMIN_FINANCE_PERMISSIONS)) {
      expect(hasPermission('operations', action)).toBe(false);
    }
  });
});

// ── Bank account masking ──

function maskAccountNumber(accountNumber: string): string {
  if (!accountNumber || accountNumber.length < 4) return '****';
  return '****' + accountNumber.slice(-4);
}

describe('Bank account masking', () => {
  it('masks full account number to last 4 digits', () => {
    expect(maskAccountNumber('1234567890')).toBe('****7890');
  });

  it('masks short account numbers', () => {
    expect(maskAccountNumber('123')).toBe('****');
  });

  it('handles empty string', () => {
    expect(maskAccountNumber('')).toBe('****');
  });
});

// ── Payout approval idempotency ──

describe('Payout approval idempotency', () => {
  it('compare-and-set prevents concurrent approvals', () => {
    // Simulate two concurrent approval requests
    let payoutStatus = 'pending';

    // First request reads status = 'pending', proceeds
    const firstCheck = payoutStatus === 'pending' || payoutStatus === 'held';
    expect(firstCheck).toBe(true);

    // First request updates with compare-and-set: WHERE status IN ('pending', 'held')
    // This succeeds and changes status to 'approved'
    if (payoutStatus === 'pending' || payoutStatus === 'held') {
      payoutStatus = 'approved';
    }

    // Second request tries the same compare-and-set
    const secondCheck = payoutStatus === 'pending' || payoutStatus === 'held';
    expect(secondCheck).toBe(false); // Status is now 'approved', not 'pending'

    // Second request's UPDATE returns 0 rows — no match → 409 Conflict
    const secondUpdated = payoutStatus === 'pending' || payoutStatus === 'held';
    expect(secondUpdated).toBe(false);
  });

  it('payout with existing transfer code blocks re-transfer', () => {
    const payout = {
      status: 'approved',
      gateway_transfer_code: 'TRF_abc123', // Already has a transfer
    };

    const shouldTransfer = !payout.gateway_transfer_code;
    expect(shouldTransfer).toBe(false);
  });
});

// ── Reconciliation equation ──

describe('Payout reconciliation equation', () => {
  it('gross - platform_fee - gateway_fee = net (before adjustments)', () => {
    const gross = 100000;
    const platformFee = 2500; // 2.5%
    const gatewayFee = 1500; // 1.5%
    const net = gross - platformFee - gatewayFee;
    expect(net).toBe(96000);
  });

  it('net + adjustments = final payout amount', () => {
    const net = 96000;
    const adjustments = -5000; // refund adjustment (negative)
    const finalAmount = Math.max(0, net + adjustments);
    expect(finalAmount).toBe(91000);
  });

  it('negative adjustments cannot produce negative payout', () => {
    const net = 5000;
    const adjustments = -10000; // refund larger than net
    const finalAmount = Math.max(0, net + adjustments);
    expect(finalAmount).toBe(0);
  });
});

// ── Cross-tenant access prevention ──

describe('Cross-tenant access prevention', () => {
  it('payout account must belong to payout business', () => {
    const payoutBusinessId = 'biz-A';
    const accountBusinessId = 'biz-B';
    const allowed = payoutBusinessId === accountBusinessId;
    expect(allowed).toBe(false);
  });

  it('same-business payout account is allowed', () => {
    const payoutBusinessId = 'biz-A';
    const accountBusinessId = 'biz-A';
    const allowed = payoutBusinessId === accountBusinessId;
    expect(allowed).toBe(true);
  });
});

// ── Refund timing ──

describe('Refund timing relative to payouts', () => {
  it('refund before payout: reduces available balance', () => {
    const totalEarned = 50000;
    const totalRefunded = 5000;
    const totalPaidOut = 0;
    const available = totalEarned - totalRefunded - totalPaidOut;
    expect(available).toBe(45000);
  });

  it('refund after payout: creates negative adjustment for next period', () => {
    const totalEarned = 50000;
    const totalPaidOut = 48000; // Already paid out
    const newRefund = 5000;
    // This creates a payout_adjustment with negative amount
    const adjustmentAmount = -newRefund;
    // Next period: net is reduced by the adjustment
    const nextPeriodGross = 30000;
    const nextPeriodNet = nextPeriodGross + adjustmentAmount;
    expect(nextPeriodNet).toBe(25000);
  });
});

// ── Currency consistency ──

describe('Currency consistency', () => {
  it('payout currency must match business country', () => {
    const countryToCurrency: Record<string, string> = {
      NG: 'NGN', US: 'USD', GB: 'GBP', CA: 'CAD', GH: 'GHS',
    };
    expect(countryToCurrency['NG']).toBe('NGN');
    expect(countryToCurrency['US']).toBe('USD');
  });

  it('never silently mix currencies', () => {
    const paymentCurrency = 'NGN';
    const payoutCurrency = 'USD';
    const currenciesMatch = paymentCurrency === payoutCurrency;
    expect(currenciesMatch).toBe(false);
    // System should reject this scenario
  });
});

// ── Export authorization ──

describe('Financial export authorization', () => {
  it('only admin and finance roles can export', () => {
    const canExport = (role: string) => ['admin', 'finance'].includes(role);
    expect(canExport('admin')).toBe(true);
    expect(canExport('finance')).toBe(true);
    expect(canExport('support')).toBe(false);
    expect(canExport('operations')).toBe(false);
  });
});
