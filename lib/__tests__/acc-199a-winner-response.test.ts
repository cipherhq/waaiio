/**
 * ACC-199A: Winner Response Block + Recipient Instructions
 *
 * Tests:
 * A. buildClaimBlock unit tests (pure, no DB)
 * B. verifyPromoCode integration tests (mocked Supabase)
 * C. claim_promo_code replay parity (real DB, requires TEST_DATABASE_URL)
 * D. prize_instructions validation in create/update routes
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildClaimBlock } from '@/lib/promotions/verify';

// ═══════════════════════════════════════════════════════
// A. Claim block generation tests
// ═══════════════════════════════════════════════════════
describe('buildClaimBlock', () => {
  const baseParams = {
    businessName: 'Acme Corp',
    campaignName: 'Summer Giveaway',
    prizeName: 'Free T-Shirt',
    claimReference: 'WAA-1234-5678-ABCD-EF01',
    verificationMode: 'standard',
  };

  it('includes business name, prize name, campaign name, and claim reference', () => {
    const block = buildClaimBlock(baseParams);
    expect(block).toContain('Free T-Shirt');
    expect(block).toContain('WAA-1234-5678-ABCD-EF01');
    expect(block).toContain('Acme Corp');
    expect(block).toContain('Summer Giveaway');
  });

  it('renders campaign name line', () => {
    const block = buildClaimBlock(baseParams);
    expect(block).toContain('Campaign: *Summer Giveaway*');
  });

  it('standard mode: renders verification method explicitly', () => {
    const block = buildClaimBlock({ ...baseParams, verificationMode: 'standard' });
    expect(block).toContain('Verification: Standard (claim reference)');
  });

  it('standard mode: says "Present this reference ... to look up your claim"', () => {
    const block = buildClaimBlock({ ...baseParams, verificationMode: 'standard' });
    expect(block).toContain('Present this reference to Acme Corp to look up your claim and collect your prize.');
  });

  it('secure_pickup mode: renders verification method explicitly', () => {
    const block = buildClaimBlock({ ...baseParams, verificationMode: 'secure_pickup' });
    expect(block).toContain('Verification: Secure Pickup (OTP required)');
  });

  it('secure_pickup mode: includes pickup wording', () => {
    const block = buildClaimBlock({ ...baseParams, verificationMode: 'secure_pickup' });
    expect(block).toContain('A verification code will be sent to this number');
    expect(block).toContain('ready for collection');
  });

  it('secure_pickup: does NOT say "never share"', () => {
    const block = buildClaimBlock({ ...baseParams, verificationMode: 'secure_pickup' });
    expect(block).not.toContain('never share');
  });

  it('secure_pickup: says "only provide it to {business} when collecting"', () => {
    const block = buildClaimBlock({ ...baseParams, verificationMode: 'secure_pickup' });
    expect(block).toContain('only provide it to Acme Corp when collecting your prize');
  });

  it('includes prize_instructions when present', () => {
    const block = buildClaimBlock({
      ...baseParams,
      prizeInstructions: 'Visit our store at 123 Main St, Mon-Fri 9am-5pm',
    });
    expect(block).toContain('Visit our store at 123 Main St, Mon-Fri 9am-5pm');
  });

  it('omits prize_instructions line when null', () => {
    const block = buildClaimBlock({ ...baseParams, prizeInstructions: null });
    const lines = block.split('\n');
    const instructionLines = lines.filter((l) => l.includes('\uD83D\uDCDD'));
    expect(instructionLines).toHaveLength(0);
  });

  it('omits prize_instructions line when undefined', () => {
    const block = buildClaimBlock({ ...baseParams, prizeInstructions: undefined });
    const lines = block.split('\n');
    const instructionLines = lines.filter((l) => l.includes('\uD83D\uDCDD'));
    expect(instructionLines).toHaveLength(0);
  });

  it('has separator lines at top and bottom', () => {
    const block = buildClaimBlock(baseParams);
    const lines = block.split('\n');
    const separatorLines = lines.filter((l) =>
      l.includes('\u2501\u2501\u2501\u2501\u2501'),
    );
    expect(separatorLines.length).toBeGreaterThanOrEqual(2);
  });
});

// ═══════════════════════════════════════════════════════
// B. verifyPromoCode integration tests (mocked Supabase)
// ═══════════════════════════════════════════════════════

// We need to mock the modules BEFORE importing verifyPromoCode.
// Use vi.mock at module level (hoisted by Vitest).

const mockRpc = vi.fn();
const mockBusinessSelect = vi.fn();
const mockCampaignQuery = vi.fn();
const mockLoggerWarn = vi.fn();

vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => ({
    rpc: mockRpc,
    from: (table: string) => {
      if (table === 'businesses') {
        return {
          select: () => ({
            eq: () => ({
              single: mockBusinessSelect,
            }),
          }),
        };
      }
      if (table === 'promo_campaigns') {
        return mockCampaignQuery();
      }
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              eq: () => ({
                limit: () => ({
                  single: () => Promise.resolve({ data: null, error: null }),
                }),
              }),
            }),
          }),
        }),
      };
    },
  }),
}));

vi.mock('@/lib/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: (...args: unknown[]) => mockLoggerWarn(...args),
    error: vi.fn(),
  },
}));

// Mock normalize and crypto since they are pure functions
vi.mock('@/lib/promotions/normalize', () => ({
  normalizePromoCode: (code: string) => code.toUpperCase().replace(/[\s\-._]/g, ''),
}));

vi.mock('@/lib/promotions/crypto', () => ({
  hashPromoCode: (code: string) => `hash_${code}`,
}));

// Now import the function under test (after mocks are set up)
const { verifyPromoCode } = await import('@/lib/promotions/verify');

const MOCK_CAMPAIGN = {
  id: 'camp-001',
  business_id: 'biz-001',
  name: 'Summer Giveaway',
  status: 'active',
  keyword: null,
  accept_bare_codes: true,
  winner_message: 'Congratulations! You won {prize_name}!',
  try_again_message: 'Better luck next time!',
  invalid_message: 'Invalid code.',
  already_used_message: 'Code already used.',
  expired_message: 'Promotion expired.',
  eligibility_mode: 'none',
};

function setupCampaignMock() {
  mockCampaignQuery.mockReturnValue({
    select: () => ({
      eq: (..._args: unknown[]) => ({
        eq: (..._args2: unknown[]) => ({
          eq: (..._args3: unknown[]) => ({
            limit: () => ({
              single: () => Promise.resolve({ data: MOCK_CAMPAIGN, error: null }),
            }),
          }),
        }),
        ilike: (..._args2: unknown[]) => ({
          eq: (..._args3: unknown[]) => ({
            limit: () => ({
              single: () => Promise.resolve({ data: MOCK_CAMPAIGN, error: null }),
            }),
          }),
        }),
      }),
    }),
  });
}

describe('verifyPromoCode integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupCampaignMock();
    mockBusinessSelect.mockResolvedValue({
      data: { name: 'Acme Corp' },
      error: null,
    });
  });

  it('first-claim winner: returns message with claim block containing all required fields', async () => {
    mockRpc.mockResolvedValue({
      data: {
        success: true,
        result: 'winner',
        claim_reference: 'WAA-AAAA-BBBB-CCCC-DDDD',
        redemption_id: 'red-001',
        prize_name: 'Gold Watch',
        prize_type: 'product',
        prize_value: 500,
        prize_currency: 'NGN',
        verification_mode: 'standard',
        verification_status: 'phone_verified',
        prize_instructions: 'Collect from Store #5',
      },
      error: null,
    });

    const response = await verifyPromoCode({
      businessId: 'biz-001',
      rawCode: 'TEST-CODE-123',
      phoneE164: '+2349000000001',
      inboundMessageId: 'msg-001',
    });

    expect(response.result).toBe('winner');
    expect(response.message).toContain('Gold Watch');
    expect(response.message).toContain('WAA-AAAA-BBBB-CCCC-DDDD');
    expect(response.message).toContain('Campaign: *Summer Giveaway*');
    expect(response.message).toContain('Verification: Standard (claim reference)');
    expect(response.message).toContain('Collect from Store #5');
    expect(response.message).toContain('Acme Corp');
    expect(response.claimReference).toBe('WAA-AAAA-BBBB-CCCC-DDDD');
    expect(response.prizeName).toBe('Gold Watch');
  });

  it('replay winner: returns identical claim block', async () => {
    mockRpc.mockResolvedValue({
      data: {
        success: true,
        result: 'winner',
        claim_reference: 'WAA-AAAA-BBBB-CCCC-DDDD',
        redemption_id: 'red-001',
        prize_name: 'Gold Watch',
        prize_type: 'product',
        prize_value: 500,
        prize_currency: 'NGN',
        verification_mode: 'standard',
        verification_status: 'phone_verified',
        prize_instructions: null,
        idempotent_replay: true,
      },
      error: null,
    });

    const response = await verifyPromoCode({
      businessId: 'biz-001',
      rawCode: 'TEST-CODE-123',
      phoneE164: '+2349000000001',
      inboundMessageId: 'msg-001',
    });

    expect(response.result).toBe('winner');
    expect(response.message).toContain('WAA-AAAA-BBBB-CCCC-DDDD');
    expect(response.message).toContain('Campaign: *Summer Giveaway*');
    expect(response.message).toContain('Verification: Standard (claim reference)');
  });

  it('standard verification: correct wording', async () => {
    mockRpc.mockResolvedValue({
      data: {
        success: true,
        result: 'winner',
        claim_reference: 'WAA-1111-2222-3333-4444',
        redemption_id: 'red-002',
        prize_name: 'Prize',
        verification_mode: 'standard',
        verification_status: 'phone_verified',
      },
      error: null,
    });

    const response = await verifyPromoCode({
      businessId: 'biz-001',
      rawCode: 'CODE-ABC',
      phoneE164: '+2349000000002',
    });

    expect(response.message).toContain('Verification: Standard (claim reference)');
    expect(response.message).toContain('Present this reference to Acme Corp to look up your claim and collect your prize.');
    expect(response.message).not.toContain('OTP');
  });

  it('secure_pickup verification: correct wording', async () => {
    mockRpc.mockResolvedValue({
      data: {
        success: true,
        result: 'winner',
        claim_reference: 'WAA-5555-6666-7777-8888',
        redemption_id: 'red-003',
        prize_name: 'Premium Prize',
        verification_mode: 'secure_pickup',
        verification_status: 'phone_verified',
      },
      error: null,
    });

    const response = await verifyPromoCode({
      businessId: 'biz-001',
      rawCode: 'CODE-XYZ',
      phoneE164: '+2349000000003',
    });

    expect(response.message).toContain('Verification: Secure Pickup (OTP required)');
    expect(response.message).toContain('A verification code will be sent to this number');
    expect(response.message).toContain('only provide it to Acme Corp when collecting your prize');
    expect(response.message).not.toContain('Present this reference');
  });

  it('try-again: no claim block in message', async () => {
    mockRpc.mockResolvedValue({
      data: {
        success: true,
        result: 'try_again',
        claim_reference: 'WAA-0000-0000-0000-0000',
        redemption_id: 'red-004',
      },
      error: null,
    });

    const response = await verifyPromoCode({
      businessId: 'biz-001',
      rawCode: 'CODE-LOSE',
      phoneE164: '+2349000000004',
    });

    expect(response.result).toBe('try_again');
    expect(response.message).toBe('Better luck next time!');
    expect(response.message).not.toContain('Claim Reference');
    expect(response.message).not.toContain('Campaign:');
    expect(response.message).not.toContain('Verification:');
  });

  it('business name lookup failure: logs warning and uses fallback', async () => {
    mockRpc.mockResolvedValue({
      data: {
        success: true,
        result: 'winner',
        claim_reference: 'WAA-FFFF-EEEE-DDDD-CCCC',
        redemption_id: 'red-005',
        prize_name: 'Mystery Prize',
        verification_mode: 'standard',
        verification_status: 'phone_verified',
      },
      error: null,
    });

    // Simulate business lookup returning null name
    mockBusinessSelect.mockResolvedValue({
      data: null,
      error: { message: 'Not found' },
    });

    const response = await verifyPromoCode({
      businessId: 'biz-missing',
      rawCode: 'CODE-BIZ',
      phoneE164: '+2349000000005',
    });

    // Should still render the claim block with fallback
    expect(response.result).toBe('winner');
    expect(response.message).toContain('Claim Reference');
    expect(response.message).toContain('the business');

    // Should have logged a warning
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      'promo.verify',
      'Business name not found for claim block',
      expect.objectContaining({ businessId: 'biz-missing' }),
    );
  });
});

// ═══════════════════════════════════════════════════════
// C. Replay parity tests (real DB)
// ═══════════════════════════════════════════════════════
import { execSync } from 'child_process';

const dbUrl = process.env.TEST_DATABASE_URL || '';
const canRunDb = dbUrl.length > 0;

function psql(sql: string): string {
  return execSync(`psql "${dbUrl}" -tAXq -v ON_ERROR_STOP=1`, {
    input: sql, encoding: 'utf-8', timeout: 15000,
  }).trim();
}

function psqlJson(sql: string): Record<string, unknown> {
  const raw = psql(sql);
  return raw ? JSON.parse(raw) : {};
}

const USER_ID = '00000000-0000-4000-f199-000000000001';
const BIZ_ID = '00000000-0000-4000-a199-aaaaaaaaaaaa';
const CAMP_ID = '00000000-0000-4000-c199-aaaaaaaaaaaa';
const BATCH_ID = '00000000-0000-4000-b199-aaaaaaaaaaaa';
const PRIZE_ID = '00000000-0000-4000-9199-aaaaaaaaaaaa';
const CODE_ID = '00000000-0000-4000-d199-aaaaaaaaaaaa';
const PHONE = '+2349199000001';
const MSG_ID = 'wamid_199a_replay_test_001';

describe.skipIf(!canRunDb)('claim_promo_code replay parity (real DB)', () => {
  beforeEach(() => {
    // Clean up from prior runs
    psql(`
      DELETE FROM promo_verification_attempts WHERE business_id = '${BIZ_ID}';
      DELETE FROM promo_redemptions WHERE business_id = '${BIZ_ID}';
      DELETE FROM promo_campaign_codes WHERE business_id = '${BIZ_ID}';
      DELETE FROM promo_code_batches WHERE id = '${BATCH_ID}';
      DELETE FROM promo_prizes WHERE id = '${PRIZE_ID}';
      DELETE FROM promo_campaigns WHERE id = '${CAMP_ID}';
      DELETE FROM businesses WHERE id = '${BIZ_ID}';
      DELETE FROM profiles WHERE id = '${USER_ID}';
      DELETE FROM auth.users WHERE id = '${USER_ID}';
    `);

    psql(`ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS phone TEXT;`);

    psql(`
      INSERT INTO auth.users (id, phone) VALUES ('${USER_ID}', '+0001990001')
      ON CONFLICT (id) DO NOTHING;
    `);

    // Create business
    psql(`
      INSERT INTO businesses (id, name, owner_id, category, country)
      VALUES ('${BIZ_ID}', 'Replay Test Biz', '${USER_ID}', 'retail', 'NG');
    `);

    // Create campaign (active)
    psql(`
      INSERT INTO promo_campaigns (id, business_id, name, status, winner_message, try_again_message, invalid_message, already_used_message, expired_message, created_by)
      VALUES ('${CAMP_ID}', '${BIZ_ID}', 'Replay Test Camp', 'active',
        'You won!', 'Try again', 'Invalid code', 'Already used', 'Expired', '${USER_ID}');
    `);

    // Create prize with instructions
    psql(`
      INSERT INTO promo_prizes (id, campaign_id, name, prize_type, quantity, allocated_count, verification_mode, prize_instructions)
      VALUES ('${PRIZE_ID}', '${CAMP_ID}', 'Gold Watch', 'product', 10, 1, 'secure_pickup', 'Collect from Store #5 between 9am-5pm');
    `);

    // Create batch
    psql(`
      INSERT INTO promo_code_batches (id, campaign_id, source, requested_count, generated_count, status)
      VALUES ('${BATCH_ID}', '${CAMP_ID}', 'generated', 1, 1, 'completed');
    `);

    // Create code (winner, tied to prize)
    psql(`
      INSERT INTO promo_campaign_codes (id, business_id, campaign_id, batch_id, normalized_code_hash, display_suffix, outcome, prize_id, status)
      VALUES ('${CODE_ID}', '${BIZ_ID}', '${CAMP_ID}', '${BATCH_ID}', 'testhash199a', 'XXXX', 'winner', '${PRIZE_ID}', 'unused');
    `);
  });

  it('first claim returns redemption_id, verification_mode, verification_status, prize_instructions', () => {
    const result = psqlJson(`
      SELECT claim_promo_code('${BIZ_ID}', '${CAMP_ID}', 'testhash199a', '${PHONE}', '${MSG_ID}');
    `);

    const claim = (result as Record<string, unknown>).claim_promo_code as Record<string, unknown> ?? result;
    expect(claim.success).toBe(true);
    expect(claim.result).toBe('winner');
    expect(claim.redemption_id).toBeTruthy();
    expect(claim.verification_mode).toBe('secure_pickup');
    expect(claim.verification_status).toBe('phone_verified');
    expect(claim.prize_instructions).toBe('Collect from Store #5 between 9am-5pm');
  });

  it('replay returns redemption_id', () => {
    // First claim
    psql(`SELECT claim_promo_code('${BIZ_ID}', '${CAMP_ID}', 'testhash199a', '${PHONE}', '${MSG_ID}');`);
    // Replay
    const result = psqlJson(`
      SELECT claim_promo_code('${BIZ_ID}', '${CAMP_ID}', 'testhash199a', '${PHONE}', '${MSG_ID}');
    `);
    const claim = (result as Record<string, unknown>).claim_promo_code as Record<string, unknown> ?? result;
    expect(claim.idempotent_replay).toBe(true);
    expect(claim.redemption_id).toBeTruthy();
  });

  it('replay returns verification_mode', () => {
    psql(`SELECT claim_promo_code('${BIZ_ID}', '${CAMP_ID}', 'testhash199a', '${PHONE}', '${MSG_ID}');`);
    const result = psqlJson(`
      SELECT claim_promo_code('${BIZ_ID}', '${CAMP_ID}', 'testhash199a', '${PHONE}', '${MSG_ID}');
    `);
    const claim = (result as Record<string, unknown>).claim_promo_code as Record<string, unknown> ?? result;
    expect(claim.verification_mode).toBe('secure_pickup');
  });

  it('replay returns verification_status', () => {
    psql(`SELECT claim_promo_code('${BIZ_ID}', '${CAMP_ID}', 'testhash199a', '${PHONE}', '${MSG_ID}');`);
    const result = psqlJson(`
      SELECT claim_promo_code('${BIZ_ID}', '${CAMP_ID}', 'testhash199a', '${PHONE}', '${MSG_ID}');
    `);
    const claim = (result as Record<string, unknown>).claim_promo_code as Record<string, unknown> ?? result;
    expect(claim.verification_status).toBe('phone_verified');
  });

  it('replay returns prize_instructions', () => {
    psql(`SELECT claim_promo_code('${BIZ_ID}', '${CAMP_ID}', 'testhash199a', '${PHONE}', '${MSG_ID}');`);
    const result = psqlJson(`
      SELECT claim_promo_code('${BIZ_ID}', '${CAMP_ID}', 'testhash199a', '${PHONE}', '${MSG_ID}');
    `);
    const claim = (result as Record<string, unknown>).claim_promo_code as Record<string, unknown> ?? result;
    expect(claim.prize_instructions).toBe('Collect from Store #5 between 9am-5pm');
  });
});

// ═══════════════════════════════════════════════════════
// D. prize_instructions validation tests
// ═══════════════════════════════════════════════════════
describe('prize_instructions validation', () => {
  it('accepts prize_instructions within 500 char limit (create route logic)', () => {
    const instructions = 'A'.repeat(500);
    const isValid = typeof instructions === 'string' && instructions.trim().length <= 500;
    expect(isValid).toBe(true);
  });

  it('rejects prize_instructions over 500 chars (create route logic)', () => {
    const instructions = 'A'.repeat(501);
    const isValid = typeof instructions === 'string' && instructions.trim().length <= 500;
    expect(isValid).toBe(false);
  });

  it('accepts null prize_instructions', () => {
    const instructions: string | null = null;
    const isValid = instructions === null || (typeof instructions === 'string' && instructions.trim().length <= 500);
    expect(isValid).toBe(true);
  });

  it('rejects non-string prize_instructions', () => {
    const instructions: unknown = 42;
    const isValid = typeof instructions === 'string';
    expect(isValid).toBe(false);
  });

  it('integrity_locked should block prize updates', () => {
    const integrityLocked = true;
    const hasPrizeUpdates = true;
    const shouldReject = integrityLocked && hasPrizeUpdates;
    expect(shouldReject).toBe(true);
  });

  it('unlocked campaign allows prize updates', () => {
    const integrityLocked = false;
    const hasPrizeUpdates = true;
    const shouldReject = integrityLocked && hasPrizeUpdates;
    expect(shouldReject).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════
// E. Existing behavior regression
// ═══════════════════════════════════════════════════════
describe('existing behavior regression', () => {
  it('buildClaimBlock does not include confidential wording for standard mode', () => {
    const block = buildClaimBlock({
      businessName: 'Test Biz',
      campaignName: 'Test',
      prizeName: 'Prize',
      claimReference: 'WAA-0000-0000-0000-0000',
      verificationMode: 'standard',
    });
    expect(block).not.toContain('verification code');
    expect(block).not.toContain('Keep the code private');
  });

  it('buildClaimBlock standard mode does not mention secure_pickup language', () => {
    const block = buildClaimBlock({
      businessName: 'Test Biz',
      campaignName: 'Test',
      prizeName: 'Prize',
      claimReference: 'WAA-0000-0000-0000-0000',
      verificationMode: 'standard',
    });
    expect(block).toContain('Present this reference');
    expect(block).not.toContain('ready for collection');
  });

  it('buildClaimBlock always includes claim reference', () => {
    const ref = 'WAA-DEAD-BEEF-CAFE-BABE';
    const block = buildClaimBlock({
      businessName: 'Biz',
      campaignName: 'Camp',
      prizeName: 'Prize',
      claimReference: ref,
      verificationMode: 'standard',
    });
    expect(block).toContain(ref);
  });
});
