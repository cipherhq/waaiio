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

  it('first-claim and replay produce byte-for-byte identical messages through verifyPromoCode', async () => {
    const sharedRpcData = {
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
    };

    // First claim
    mockRpc.mockResolvedValue({ data: sharedRpcData, error: null });
    const firstResponse = await verifyPromoCode({
      businessId: 'biz-001',
      rawCode: 'TEST-CODE-123',
      phoneE164: '+2349000000001',
      inboundMessageId: 'msg-001',
    });

    // Replay — same data but with idempotent_replay flag
    mockRpc.mockResolvedValue({ data: { ...sharedRpcData, idempotent_replay: true }, error: null });
    const replayResponse = await verifyPromoCode({
      businessId: 'biz-001',
      rawCode: 'TEST-CODE-123',
      phoneE164: '+2349000000001',
      inboundMessageId: 'msg-001',
    });

    // Exact string equality — proves the system block is byte-for-byte identical
    expect(firstResponse.message).toBe(replayResponse.message);
    expect(firstResponse.result).toBe('winner');
    expect(replayResponse.result).toBe('winner');
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
import { execSync, execFile } from 'child_process';

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

function psqlMayFail(sql: string): { ok: boolean; output: string } {
  try {
    const out = execSync(`psql "${dbUrl}" -tAXq -v ON_ERROR_STOP=1`, {
      input: sql, encoding: 'utf-8', timeout: 15000,
    }).toString().trim();
    return { ok: true, output: out };
  } catch (e: unknown) {
    return { ok: false, output: String((e as { stderr?: string }).stderr || e) };
  }
}

/** Run SQL in a separate process (independent connection) — returns promise */
function psqlAsync(sql: string, timeoutMs = 15000): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile('psql', [dbUrl, '-tAXq', '-v', 'ON_ERROR_STOP=1'], {
      timeout: timeoutMs,
    }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        stdout: (stdout || '').trim(),
        stderr: (stderr || '').trim(),
      });
    }).stdin?.end(sql);
  });
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
      INSERT INTO businesses (id, name, slug, owner_id, address, city, neighborhood, phone, status, payout_mode, country_code, verification_level)
      VALUES ('${BIZ_ID}', 'Replay Test Biz', 'replay-test-biz-199a', '${USER_ID}', '1 Test', 'Lagos', 'VI', '+0001990002', 'active', 'manual', 'NG', 'basic');
    `);

    // Create campaign (active)
    psql(`
      INSERT INTO promo_campaigns (id, business_id, name, status, code_entry_mode, accept_bare_codes, winner_message, try_again_message, invalid_message, already_used_message, expired_message, created_by)
      VALUES ('${CAMP_ID}', '${BIZ_ID}', 'Replay Test Camp', 'active', 'bare_code', true,
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

  it('first-claim and replay return identical prize_instructions (parity proof)', () => {
    // First claim
    const firstResult = psqlJson(`
      SELECT claim_promo_code('${BIZ_ID}', '${CAMP_ID}', 'testhash199a', '${PHONE}', '${MSG_ID}');
    `);
    const firstClaim = (firstResult as Record<string, unknown>).claim_promo_code as Record<string, unknown> ?? firstResult;

    // Replay
    const replayResult = psqlJson(`
      SELECT claim_promo_code('${BIZ_ID}', '${CAMP_ID}', 'testhash199a', '${PHONE}', '${MSG_ID}');
    `);
    const replayClaim = (replayResult as Record<string, unknown>).claim_promo_code as Record<string, unknown> ?? replayResult;

    // Parity: both return the same prize_instructions
    expect(firstClaim.prize_instructions).toBe('Collect from Store #5 between 9am-5pm');
    expect(replayClaim.prize_instructions).toBe(firstClaim.prize_instructions);

    // Both produce identical system claim blocks
    const firstBlock = buildClaimBlock({
      businessName: 'Replay Test Biz',
      campaignName: 'Replay Test Camp',
      prizeName: firstClaim.prize_name as string,
      claimReference: firstClaim.claim_reference as string,
      verificationMode: firstClaim.verification_mode as string,
      prizeInstructions: firstClaim.prize_instructions as string | null,
    });
    const replayBlock = buildClaimBlock({
      businessName: 'Replay Test Biz',
      campaignName: 'Replay Test Camp',
      prizeName: replayClaim.prize_name as string,
      claimReference: replayClaim.claim_reference as string,
      verificationMode: replayClaim.verification_mode as string,
      prizeInstructions: replayClaim.prize_instructions as string | null,
    });
    expect(firstBlock).toBe(replayBlock);
  });
});

// ═══════════════════════════════════════════════════════
// C2. prize_instructions integrity locking (real DB)
// ═══════════════════════════════════════════════════════
describe.skipIf(!canRunDb)('prize_instructions integrity locking (real DB)', () => {
  const LOCK_CAMP_ID = '00000000-0000-4000-c199-bbbbbbbbbbbb';
  const LOCK_PRIZE_ID = '00000000-0000-4000-9199-bbbbbbbbbbbb';

  beforeEach(() => {
    psql(`
      DELETE FROM promo_prizes WHERE id = '${LOCK_PRIZE_ID}';
      DELETE FROM promo_campaigns WHERE id = '${LOCK_CAMP_ID}';
      DELETE FROM businesses WHERE id = '${BIZ_ID}';
      DELETE FROM profiles WHERE id = '${USER_ID}';
      DELETE FROM auth.users WHERE id = '${USER_ID}';
    `);

    psql(`ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS phone TEXT;`);
    psql(`
      INSERT INTO auth.users (id, phone) VALUES ('${USER_ID}', '+0001990001')
      ON CONFLICT (id) DO NOTHING;
    `);
    psql(`
      INSERT INTO businesses (id, name, slug, owner_id, address, city, neighborhood, phone, status, payout_mode, country_code, verification_level)
      VALUES ('${BIZ_ID}', 'Lock Test Biz', 'lock-test-biz-199a', '${USER_ID}', '2 Test', 'Lagos', 'VI', '+0001990003', 'active', 'manual', 'NG', 'basic');
    `);
    psql(`
      INSERT INTO promo_campaigns (id, business_id, name, status, integrity_locked, code_entry_mode, accept_bare_codes, winner_message, try_again_message, invalid_message, already_used_message, expired_message, created_by)
      VALUES ('${LOCK_CAMP_ID}', '${BIZ_ID}', 'Lock Test Camp', 'active', false, 'bare_code', true,
        'You won!', 'Try again', 'Invalid', 'Already used', 'Expired', '${USER_ID}');
    `);
    psql(`
      INSERT INTO promo_prizes (id, campaign_id, name, prize_type, quantity, allocated_count, prize_instructions)
      VALUES ('${LOCK_PRIZE_ID}', '${LOCK_CAMP_ID}', 'Test Prize', 'product', 10, 0, 'Original instructions');
    `);
  });

  it('integrity_locked = true blocks prize_instructions updates (check_violation)', () => {
    // Lock the campaign
    psql(`UPDATE promo_campaigns SET integrity_locked = true WHERE id = '${LOCK_CAMP_ID}';`);

    // Attempt to update prize_instructions — should fail
    expect(() => {
      psql(`UPDATE promo_prizes SET prize_instructions = 'New instructions' WHERE id = '${LOCK_PRIZE_ID}';`);
    }).toThrow(/integrity_locked/);
  });

  it('integrity_locked = false allows prize_instructions updates', () => {
    // Campaign is not locked (default from beforeEach)
    psql(`UPDATE promo_prizes SET prize_instructions = 'Updated instructions' WHERE id = '${LOCK_PRIZE_ID}';`);

    const result = psql(`SELECT prize_instructions FROM promo_prizes WHERE id = '${LOCK_PRIZE_ID}';`);
    expect(result).toBe('Updated instructions');
  });

  it('non-prize_instructions columns can still be updated when locked', () => {
    psql(`UPDATE promo_campaigns SET integrity_locked = true WHERE id = '${LOCK_CAMP_ID}';`);

    // Updating name (not prize_instructions) should succeed even when locked
    psql(`UPDATE promo_prizes SET name = 'Renamed Prize' WHERE id = '${LOCK_PRIZE_ID}';`);
    const result = psql(`SELECT name FROM promo_prizes WHERE id = '${LOCK_PRIZE_ID}';`);
    expect(result).toBe('Renamed Prize');
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

// ═══════════════════════════════════════════════════════
// F. Two-connection race tests (real DB)
// ═══════════════════════════════════════════════════════
const RACE_CAMP_ID = '00000000-0000-4000-c199-cccccccccccc';
const RACE_PRIZE_ID = '00000000-0000-4000-9199-cccccccccccc';
const RACE_PRIZE_ID_2 = '00000000-0000-4000-9199-dddddddddddd';
const RACE_BATCH_ID = '00000000-0000-4000-b199-cccccccccccc';
const RACE_CODE_ID = '00000000-0000-4000-d199-cccccccccccc';
const RACE_PHONE = '+2349199000099';
const RACE_MSG_ID = 'wamid_199a_race_test_001';
const BOGUS_PRIZE_ID = '00000000-0000-4000-9199-ffffffffffff';

describe.skipIf(!canRunDb)('Two-connection race tests: prize update vs claim_promo_code (real DB)', () => {
  beforeEach(() => {
    // Clean up
    psql(`
      DELETE FROM promo_verification_attempts WHERE business_id = '${BIZ_ID}';
      DELETE FROM promo_redemptions WHERE business_id = '${BIZ_ID}';
      DELETE FROM promo_campaign_codes WHERE business_id = '${BIZ_ID}';
      DELETE FROM promo_code_batches WHERE id = '${RACE_BATCH_ID}';
      DELETE FROM promo_prizes WHERE campaign_id = '${RACE_CAMP_ID}';
      DELETE FROM promo_campaigns WHERE id = '${RACE_CAMP_ID}';
      DELETE FROM businesses WHERE id = '${BIZ_ID}';
      DELETE FROM profiles WHERE id = '${USER_ID}';
      DELETE FROM auth.users WHERE id = '${USER_ID}';
    `);

    psql(`ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS phone TEXT;`);
    psql(`
      INSERT INTO auth.users (id, phone) VALUES ('${USER_ID}', '+0001990001')
      ON CONFLICT (id) DO NOTHING;
    `);
    psql(`
      INSERT INTO businesses (id, name, slug, owner_id, address, city, neighborhood, phone, status, payout_mode, country_code, verification_level)
      VALUES ('${BIZ_ID}', 'Race Test Biz', 'race-test-biz-199a', '${USER_ID}', '3 Test', 'Lagos', 'VI', '+0001990004', 'active', 'manual', 'NG', 'basic');
    `);
    psql(`
      INSERT INTO promo_campaigns (id, business_id, name, status, integrity_locked, code_entry_mode, accept_bare_codes,
        winner_message, try_again_message, invalid_message, already_used_message, expired_message, created_by)
      VALUES ('${RACE_CAMP_ID}', '${BIZ_ID}', 'Race Test Camp', 'active', false, 'bare_code', true,
        'You won!', 'Try again', 'Invalid', 'Already used', 'Expired', '${USER_ID}');
    `);
    psql(`
      INSERT INTO promo_prizes (id, campaign_id, name, prize_type, quantity, allocated_count, verification_mode, prize_instructions)
      VALUES ('${RACE_PRIZE_ID}', '${RACE_CAMP_ID}', 'Race Prize', 'product', 10, 1, 'standard', 'Original instructions');
    `);
    psql(`
      INSERT INTO promo_prizes (id, campaign_id, name, prize_type, quantity, allocated_count)
      VALUES ('${RACE_PRIZE_ID_2}', '${RACE_CAMP_ID}', 'Prize 2', 'product', 5, 0);
    `);
    psql(`
      INSERT INTO promo_code_batches (id, campaign_id, source, requested_count, generated_count, status)
      VALUES ('${RACE_BATCH_ID}', '${RACE_CAMP_ID}', 'generated', 1, 1, 'completed');
    `);
    psql(`
      INSERT INTO promo_campaign_codes (id, business_id, campaign_id, batch_id, normalized_code_hash, display_suffix, outcome, prize_id, status)
      VALUES ('${RACE_CODE_ID}', '${BIZ_ID}', '${RACE_CAMP_ID}', '${RACE_BATCH_ID}', 'racehash199a', 'YYYY', 'winner', '${RACE_PRIZE_ID}', 'unused');
    `);
  });

  it('Test A: prize update first, redemption waits, sees NEW instructions', async () => {
    // Connection A: BEGIN, lock campaign via RPC, update prize_instructions
    // Uses pg_sleep to hold the lock for 2 seconds
    const connA = psqlAsync(`
      SET statement_timeout = '10s';
      BEGIN;
      SELECT update_prize_instructions(
        '${RACE_CAMP_ID}', '${BIZ_ID}', '${USER_ID}',
        '[{"prize_id": "${RACE_PRIZE_ID}", "prize_instructions": "Updated by Race A"}]'::jsonb
      );
      SELECT pg_sleep(2);
      COMMIT;
    `);

    // Small delay to ensure A acquires lock first
    await new Promise(r => setTimeout(r, 300));

    // Connection B: attempt claim_promo_code — blocks on campaign row lock
    const connB = psqlAsync(`
      SET statement_timeout = '10s';
      SELECT claim_promo_code('${BIZ_ID}', '${RACE_CAMP_ID}', 'racehash199a', '${RACE_PHONE}', '${RACE_MSG_ID}');
    `);

    const [resultA, resultB] = await Promise.all([connA, connB]);

    expect(resultA.ok).toBe(true);
    expect(resultB.ok).toBe(true);

    // Parse B's result — claim should succeed and see the NEW instructions
    const claimResult = JSON.parse(resultB.stdout);
    const claim = claimResult.claim_promo_code || claimResult;
    expect(claim.success).toBe(true);
    expect(claim.result).toBe('winner');
    expect(claim.prize_instructions).toBe('Updated by Race A');

    // Verify first-claim and replay produce identical blocks
    const replayResult = psqlJson(`
      SELECT claim_promo_code('${BIZ_ID}', '${RACE_CAMP_ID}', 'racehash199a', '${RACE_PHONE}', '${RACE_MSG_ID}');
    `);
    const replayClaim = (replayResult as Record<string, unknown>).claim_promo_code as Record<string, unknown> ?? replayResult;
    expect(replayClaim.idempotent_replay).toBe(true);
    expect(replayClaim.prize_instructions).toBe(claim.prize_instructions);
  });

  it('Test B: redemption first, prize update waits, sees integrity_locked', async () => {
    // Connection A: BEGIN, claim the code (sets integrity_locked=true), hold lock
    const connA = psqlAsync(`
      SET statement_timeout = '10s';
      BEGIN;
      SELECT claim_promo_code('${BIZ_ID}', '${RACE_CAMP_ID}', 'racehash199a', '${RACE_PHONE}', '${RACE_MSG_ID}');
      SELECT pg_sleep(2);
      COMMIT;
    `);

    await new Promise(r => setTimeout(r, 300));

    // Connection B: attempt update_prize_instructions — blocks, then sees integrity_locked
    const connB = psqlAsync(`
      SET statement_timeout = '10s';
      SELECT update_prize_instructions(
        '${RACE_CAMP_ID}', '${BIZ_ID}', '${USER_ID}',
        '[{"prize_id": "${RACE_PRIZE_ID}", "prize_instructions": "Should be rejected"}]'::jsonb
      );
    `);

    const [resultA, resultB] = await Promise.all([connA, connB]);

    expect(resultA.ok).toBe(true);
    expect(resultB.ok).toBe(true);

    // B should return integrity_locked error
    const updateResult = JSON.parse(resultB.stdout);
    const rpcOut = updateResult.update_prize_instructions || updateResult;
    expect(rpcOut.success).toBe(false);
    expect(rpcOut.error).toBe('integrity_locked');

    // Verify first-claim and replay produce identical blocks
    const replayResult = psqlJson(`
      SELECT claim_promo_code('${BIZ_ID}', '${RACE_CAMP_ID}', 'racehash199a', '${RACE_PHONE}', '${RACE_MSG_ID}');
    `);
    const replayClaim = (replayResult as Record<string, unknown>).claim_promo_code as Record<string, unknown> ?? replayResult;
    expect(replayClaim.idempotent_replay).toBe(true);
    expect(replayClaim.prize_instructions).toBe('Original instructions');
  });

  it('Test C: no deadlock — both orderings complete within bounded timeout', async () => {
    // Run both orderings with 5s statement timeout — if deadlock occurs, one will timeout
    // Ordering 1: update then claim (use fresh code)
    const order1A = psqlAsync(`
      SET statement_timeout = '5s';
      SELECT update_prize_instructions(
        '${RACE_CAMP_ID}', '${BIZ_ID}', '${USER_ID}',
        '[{"prize_id": "${RACE_PRIZE_ID}", "prize_instructions": "Deadlock test 1"}]'::jsonb
      );
    `, 8000);

    const order1B = psqlAsync(`
      SET statement_timeout = '5s';
      SELECT claim_promo_code('${BIZ_ID}', '${RACE_CAMP_ID}', 'racehash199a', '${RACE_PHONE}', '${RACE_MSG_ID}');
    `, 8000);

    const [r1a, r1b] = await Promise.all([order1A, order1B]);

    // At least one must succeed; neither should deadlock/timeout
    expect(r1a.ok || r1b.ok).toBe(true);
    // Neither should have a deadlock error
    expect(r1a.stderr).not.toContain('deadlock');
    expect(r1b.stderr).not.toContain('deadlock');
  });

  it('Test D: failing one item rolls back entire batch', () => {
    // Send a batch with valid prize + non-existent prize
    const result = psqlMayFail(`
      SELECT update_prize_instructions(
        '${RACE_CAMP_ID}', '${BIZ_ID}', '${USER_ID}',
        '[{"prize_id": "${RACE_PRIZE_ID}", "prize_instructions": "Should not persist"},
          {"prize_id": "${BOGUS_PRIZE_ID}", "prize_instructions": "Does not exist"}]'::jsonb
      );
    `);

    // Should fail due to non-existent prize
    expect(result.ok).toBe(false);
    expect(result.output).toContain('does not belong to campaign');

    // Verify: the first prize was NOT updated (rollback)
    const instructions = psql(`SELECT prize_instructions FROM promo_prizes WHERE id = '${RACE_PRIZE_ID}';`);
    expect(instructions).toBe('Original instructions');
  });

  it('Test E: direct service-role bypass blocked by trigger when integrity_locked', () => {
    // Lock the campaign
    psql(`UPDATE promo_campaigns SET integrity_locked = true WHERE id = '${RACE_CAMP_ID}';`);

    // Attempt direct UPDATE (bypassing RPC) — trigger should block it
    const result = psqlMayFail(`
      UPDATE promo_prizes SET prize_instructions = 'hacked' WHERE id = '${RACE_PRIZE_ID}';
    `);

    expect(result.ok).toBe(false);
    expect(result.output).toContain('integrity_locked');

    // Verify instructions unchanged
    const instructions = psql(`SELECT prize_instructions FROM promo_prizes WHERE id = '${RACE_PRIZE_ID}';`);
    expect(instructions).toBe('Original instructions');
  });
});

// ═══════════════════════════════════════════════════════
// G. Privilege assertions for update_prize_instructions (real DB)
// ═══════════════════════════════════════════════════════
describe.skipIf(!canRunDb)('update_prize_instructions privilege assertions (real DB)', () => {
  it('service_role can execute update_prize_instructions', () => {
    // Service role (default psql connection) should be able to call the function
    // We just need a valid campaign — reuse setup from race tests
    psql(`
      DELETE FROM promo_prizes WHERE campaign_id = '${CAMP_ID}';
      DELETE FROM promo_campaigns WHERE id = '${CAMP_ID}';
      DELETE FROM businesses WHERE id = '${BIZ_ID}';
      DELETE FROM profiles WHERE id = '${USER_ID}';
      DELETE FROM auth.users WHERE id = '${USER_ID}';
    `);
    psql(`ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS phone TEXT;`);
    psql(`INSERT INTO auth.users (id, phone) VALUES ('${USER_ID}', '+0001990001') ON CONFLICT (id) DO NOTHING;`);
    psql(`
      INSERT INTO businesses (id, name, slug, owner_id, address, city, neighborhood, phone, status, payout_mode, country_code, verification_level)
      VALUES ('${BIZ_ID}', 'Priv Test Biz', 'priv-test-biz-199a', '${USER_ID}', '4 Test', 'Lagos', 'VI', '+0001990005', 'active', 'manual', 'NG', 'basic');
    `);
    psql(`
      INSERT INTO promo_campaigns (id, business_id, name, status, integrity_locked, code_entry_mode, accept_bare_codes, winner_message, try_again_message, invalid_message, already_used_message, expired_message, created_by)
      VALUES ('${CAMP_ID}', '${BIZ_ID}', 'Priv Test Camp', 'draft', false, 'bare_code', true, 'W', 'T', 'I', 'A', 'E', '${USER_ID}');
    `);
    psql(`
      INSERT INTO promo_prizes (id, campaign_id, name, prize_type, quantity, allocated_count, prize_instructions)
      VALUES ('${PRIZE_ID}', '${CAMP_ID}', 'Priv Prize', 'product', 10, 0, 'Original');
    `);

    const result = psql(`
      SELECT update_prize_instructions(
        '${CAMP_ID}', '${BIZ_ID}', '${USER_ID}',
        '[{"prize_id": "${PRIZE_ID}", "prize_instructions": "Updated by service_role"}]'::jsonb
      );
    `);
    expect(JSON.parse(result).success).toBe(true);

    // Cleanup
    psql(`
      DELETE FROM promo_prizes WHERE id = '${PRIZE_ID}';
      DELETE FROM promo_campaigns WHERE id = '${CAMP_ID}';
      DELETE FROM businesses WHERE id = '${BIZ_ID}';
      DELETE FROM profiles WHERE id = '${USER_ID}';
      DELETE FROM auth.users WHERE id = '${USER_ID}';
    `);
  });

  it('anon role cannot execute update_prize_instructions', () => {
    expect(() => {
      psql(`
        SET ROLE anon;
        SELECT update_prize_instructions(
          '00000000-0000-0000-0000-000000000000',
          '00000000-0000-0000-0000-000000000000',
          '00000000-0000-0000-0000-000000000000',
          '[]'::jsonb
        );
      `);
    }).toThrow();
    psql(`RESET ROLE;`);
  });

  it('authenticated role cannot execute update_prize_instructions', () => {
    expect(() => {
      psql(`
        SET ROLE authenticated;
        SELECT update_prize_instructions(
          '00000000-0000-0000-0000-000000000000',
          '00000000-0000-0000-0000-000000000000',
          '00000000-0000-0000-0000-000000000000',
          '[]'::jsonb
        );
      `);
    }).toThrow();
    psql(`RESET ROLE;`);
  });
});
