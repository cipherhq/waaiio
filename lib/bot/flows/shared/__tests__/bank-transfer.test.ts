import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  checkBankTransferEligibility,
  createPendingTransfer,
  formatBankTransferBlock,
  BANK_ONLY_BUTTONS,
  DUAL_OPTION_BUTTONS,
} from '../bank-transfer';

// Mock loadPlatformSettings
vi.mock('@/lib/platformSettings', () => ({
  loadPlatformSettings: vi.fn().mockResolvedValue({
    minimum_bank_transfer: { NG: 5000, GH: 5000, US: 50000 },
  }),
}));

// Mock logger
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

function createMockSupabase(bankAccount: Record<string, string> | null = null) {
  const chain: Record<string, any> = {};
  chain.select = vi.fn().mockReturnValue(chain);
  chain.eq = vi.fn().mockReturnValue(chain);
  chain.maybeSingle = vi.fn().mockResolvedValue({ data: bankAccount, error: null });

  const insertChain: Record<string, any> = {};
  insertChain.then = undefined;
  const insertFn = vi.fn().mockResolvedValue({ error: null });

  return {
    from: vi.fn((table: string) => {
      if (table === 'business_bank_accounts') return chain;
      if (table === 'pending_transfers') return { insert: insertFn };
      return chain;
    }),
    _insertFn: insertFn,
  };
}

describe('bank-transfer — checkBankTransferEligibility', () => {
  it('returns qualifies=false for US country', async () => {
    const supabase = createMockSupabase();
    const result = await checkBankTransferEligibility(supabase as any, {
      businessId: 'biz-001',
      countryCode: 'US',
      subscriptionTier: 'growth',
      amount: 100000,
    });
    expect(result.qualifies).toBe(false);
    expect(result.bankAccount).toBeNull();
  });

  it('returns qualifies=false for free tier', async () => {
    const supabase = createMockSupabase();
    const result = await checkBankTransferEligibility(supabase as any, {
      businessId: 'biz-001',
      countryCode: 'NG',
      subscriptionTier: 'free',
      amount: 100000,
    });
    expect(result.qualifies).toBe(false);
    expect(result.bankAccount).toBeNull();
  });

  it('returns qualifies=false for amount below minimum', async () => {
    const supabase = createMockSupabase();
    const result = await checkBankTransferEligibility(supabase as any, {
      businessId: 'biz-001',
      countryCode: 'NG',
      subscriptionTier: 'growth',
      amount: 1000, // Below 5000 minimum
    });
    expect(result.qualifies).toBe(false);
    expect(result.bankAccount).toBeNull();
  });

  it('returns qualifies=true for NG, growth tier, amount above minimum with bank account', async () => {
    const bankAccount = {
      bank_name: 'Access Bank',
      account_number: '0123456789',
      account_name: 'Test Business',
    };
    const supabase = createMockSupabase(bankAccount);
    const result = await checkBankTransferEligibility(supabase as any, {
      businessId: 'biz-001',
      countryCode: 'NG',
      subscriptionTier: 'growth',
      amount: 10000,
    });
    expect(result.qualifies).toBe(true);
    expect(result.bankAccount).toEqual(bankAccount);
  });

  it('returns qualifies=false for NG, growth, above minimum but no bank account on file', async () => {
    const supabase = createMockSupabase(null);
    const result = await checkBankTransferEligibility(supabase as any, {
      businessId: 'biz-001',
      countryCode: 'NG',
      subscriptionTier: 'growth',
      amount: 10000,
    });
    // qualifies is false because bankAccount is null (!!null === false)
    expect(result.qualifies).toBe(false);
  });
});

describe('bank-transfer — createPendingTransfer', () => {
  it('returns a transfer ref starting with WA-', async () => {
    const supabase = createMockSupabase();
    const ref = await createPendingTransfer(supabase as any, {
      businessId: 'biz-001',
      entityId: { booking_id: 'bk-001' },
      customerPhone: '+2348012345678',
      customerName: 'John',
      amount: 5000,
      countryCode: 'NG',
      transferExpiryHours: 24,
    });
    expect(ref).toMatch(/^WA-[A-F0-9]{4}$/);
  });
});

describe('bank-transfer — formatBankTransferBlock', () => {
  it('returns string containing bank name, account number, account name, and ref', () => {
    const bankAccount = {
      bank_name: 'Access Bank',
      account_number: '0123456789',
      account_name: 'Test Business Ltd',
    };
    const result = formatBankTransferBlock(bankAccount, '₦5,000', 'WA-AB12');
    expect(result).toContain('Access Bank');
    expect(result).toContain('0123456789');
    expect(result).toContain('Test Business Ltd');
    expect(result).toContain('WA-AB12');
  });
});

describe('bank-transfer — button constants', () => {
  it('BANK_ONLY_BUTTONS has 2 buttons', () => {
    expect(BANK_ONLY_BUTTONS).toHaveLength(2);
  });

  it('DUAL_OPTION_BUTTONS has 3 buttons', () => {
    expect(DUAL_OPTION_BUTTONS).toHaveLength(3);
  });
});
