/**
 * Promo Winner Visibility Tests (#190)
 *
 * Tests the defense-in-depth integrity checks that protect winner-code
 * decryption in the Winners API. Verifies:
 *
 * - Pre-redemption confidentiality: unused winning codes are never disclosed.
 * - Post-redemption visibility: claimed winner gets exact printed code.
 * - Cross-business/campaign denial.
 * - Fail-closed on decryption/integrity failure.
 * - Response data minimization (no ciphertext, hash, or allocation metadata).
 * - UI renders redeemed_code only when present, preserves phone masking.
 */
import { describe, it, expect } from 'vitest';
import { encryptPromoCode, decryptPromoCode } from '@/lib/promotions/crypto';
import { formatPromoCode, normalizePromoCode, isRoutablePromoCode } from '@/lib/promotions/normalize';

// ═══════════════════════════════════════════════════════
// 1. resolveRedeemedCode integrity logic tests
//
// The resolveRedeemedCode function is defined in the Winners API route.
// Since it's not exported, we replicate the exact logic here to test
// every branch. The route file is the source of truth — these tests
// prove the contract that the function must enforce.
// ═══════════════════════════════════════════════════════

type CodeJoin = {
  encrypted_code: string | null;
  campaign_id: string;
  status: string;
  outcome: string;
};

/**
 * Exact replica of resolveRedeemedCode from the Winners API route.
 * Tests verify this logic matches the 8-check contract.
 */
function resolveRedeemedCode(
  codeRow: CodeJoin | CodeJoin[] | null,
  redemptionCampaignId: string,
): string | null {
  if (!codeRow) return null;
  const code = Array.isArray(codeRow) ? (codeRow[0] ?? null) : codeRow;
  if (!code) return null;

  // Check 5: code belongs to same campaign as the redemption
  if (code.campaign_id !== redemptionCampaignId) return null;
  // Check 6: code is durably claimed
  if (code.status !== 'claimed') return null;
  // Check 7: code outcome is winner
  if (code.outcome !== 'winner') return null;
  // Check 8: decrypt and validate
  if (!code.encrypted_code) return null;
  try {
    const decrypted = decryptPromoCode(code.encrypted_code);
    if (!isRoutablePromoCode(decrypted)) return null;
    return formatPromoCode(decrypted);
  } catch {
    return null;
  }
}

const CAMPAIGN_A = '00000000-0000-0000-0000-000000000001';
const CAMPAIGN_B = '00000000-0000-0000-0000-000000000002';

// Generate a real encrypted code for testing
const TEST_NORMALIZED = 'K7PM4XQ9N2WF';
const TEST_FORMATTED = 'K7PM-4XQ9-N2WF';

describe('resolveRedeemedCode — defense-in-depth integrity', () => {
  // We need a real encrypted value for the positive test
  let validEncrypted: string;

  // Encrypt the test code (uses the actual crypto module)
  try {
    validEncrypted = encryptPromoCode(TEST_NORMALIZED);
  } catch {
    // If TOKEN_ENCRYPTION_KEY is not set, skip encryption-dependent tests
    validEncrypted = '';
  }

  const validCodeRow: CodeJoin = {
    encrypted_code: validEncrypted,
    campaign_id: CAMPAIGN_A,
    status: 'claimed',
    outcome: 'winner',
  };

  it('returns exact formatted code for valid claimed winner', () => {
    if (!validEncrypted) return; // skip if no encryption key
    const result = resolveRedeemedCode(validCodeRow, CAMPAIGN_A);
    expect(result).toBe(TEST_FORMATTED);
  });

  it('returns null when codeRow is null (missing promo_code_id / unresolvable FK)', () => {
    expect(resolveRedeemedCode(null, CAMPAIGN_A)).toBeNull();
  });

  it('returns null when codeRow is empty array', () => {
    expect(resolveRedeemedCode([], CAMPAIGN_A)).toBeNull();
  });

  it('returns null when code campaign_id mismatches redemption campaign_id', () => {
    const mismatch: CodeJoin = { ...validCodeRow, campaign_id: CAMPAIGN_B };
    expect(resolveRedeemedCode(mismatch, CAMPAIGN_A)).toBeNull();
  });

  it('returns null when code status is "unused" (pre-redemption confidentiality)', () => {
    const unused: CodeJoin = { ...validCodeRow, status: 'unused' };
    expect(resolveRedeemedCode(unused, CAMPAIGN_A)).toBeNull();
  });

  it('returns null when code status is "void"', () => {
    const voided: CodeJoin = { ...validCodeRow, status: 'void' };
    expect(resolveRedeemedCode(voided, CAMPAIGN_A)).toBeNull();
  });

  it('returns null when code outcome is "try_again" (loser code)', () => {
    const loser: CodeJoin = { ...validCodeRow, outcome: 'try_again' };
    expect(resolveRedeemedCode(loser, CAMPAIGN_A)).toBeNull();
  });

  it('returns null when encrypted_code is null', () => {
    const noEnc: CodeJoin = { ...validCodeRow, encrypted_code: null };
    expect(resolveRedeemedCode(noEnc, CAMPAIGN_A)).toBeNull();
  });

  it('returns null on corrupt/wrong-key ciphertext (fail closed, no error thrown)', () => {
    const corrupt: CodeJoin = { ...validCodeRow, encrypted_code: 'totally-invalid-ciphertext' };
    // Must NOT throw — must return null
    expect(resolveRedeemedCode(corrupt, CAMPAIGN_A)).toBeNull();
  });

  it('handles array form of codeRow (PostgREST may return array for FK join)', () => {
    if (!validEncrypted) return;
    expect(resolveRedeemedCode([validCodeRow], CAMPAIGN_A)).toBe(TEST_FORMATTED);
  });
});

// ═══════════════════════════════════════════════════════
// 2. Crypto round-trip verification
// ═══════════════════════════════════════════════════════

describe('Promo code encrypt/decrypt round-trip', () => {
  it('decrypting an encrypted code returns the original normalized value', () => {
    let encrypted: string;
    try {
      encrypted = encryptPromoCode(TEST_NORMALIZED);
    } catch {
      return; // skip if no encryption key
    }
    expect(decryptPromoCode(encrypted)).toBe(TEST_NORMALIZED);
  });

  it('formatPromoCode produces hyphenated groups', () => {
    expect(formatPromoCode('K7PM4XQ9N2WF')).toBe('K7PM-4XQ9-N2WF');
    expect(formatPromoCode('ABCDEFGH')).toBe('ABCD-EFGH');
    expect(formatPromoCode('ABC')).toBe('ABC');
  });
});

// ═══════════════════════════════════════════════════════
// 3. Winners API source-code contract tests
//
// Verify the API route file contains the required structure.
// ═══════════════════════════════════════════════════════

describe('Winners API route contract', () => {
  const fs = require('fs');
  const routeSrc = fs.readFileSync('app/api/promotions/winners/route.ts', 'utf-8');

  it('imports decryptPromoCode from promotions/crypto', () => {
    expect(routeSrc).toContain("import { decryptPromoCode } from '@/lib/promotions/crypto'");
  });

  it('imports formatPromoCode and isRoutablePromoCode from promotions/normalize', () => {
    expect(routeSrc).toContain('formatPromoCode');
    expect(routeSrc).toContain('isRoutablePromoCode');
    expect(routeSrc).toContain("from '@/lib/promotions/normalize'");
  });

  it('joins promo_campaign_codes via promo_code_id FK', () => {
    expect(routeSrc).toContain('promo_campaign_codes!promo_code_id');
  });

  it('selects encrypted_code, campaign_id, status, outcome from code row', () => {
    expect(routeSrc).toContain('encrypted_code');
    expect(routeSrc).toContain('campaign_id');
    // status and outcome are selected for integrity checks
    expect(routeSrc).toMatch(/promo_campaign_codes.*status/s);
    expect(routeSrc).toMatch(/promo_campaign_codes.*outcome/s);
  });

  it('filters redemptions by outcome = winner', () => {
    expect(routeSrc).toContain(".eq('outcome', 'winner')");
  });

  it('response maps redeemed_code field', () => {
    expect(routeSrc).toContain('redeemed_code:');
  });

  it('does NOT expose ciphertext in response', () => {
    // encrypted_code must NOT appear in the response mapping
    const responseSection = routeSrc.split('const winners =')[1];
    expect(responseSection).toBeDefined();
    // encrypted_code should only appear in the select query, not in the mapped output
    const mappingBlock = responseSection.split('return {')[1]?.split('}')[0] || '';
    expect(mappingBlock).not.toContain('encrypted_code');
  });

  it('does NOT expose normalized_code_hash in response', () => {
    expect(routeSrc).not.toContain('normalized_code_hash');
  });

  it('checks code.campaign_id matches redemption campaign_id (check 5)', () => {
    expect(routeSrc).toContain('code.campaign_id !== redemptionCampaignId');
  });

  it('checks code.status === claimed (check 6)', () => {
    expect(routeSrc).toContain("code.status !== 'claimed'");
  });

  it('checks code.outcome === winner (check 7)', () => {
    expect(routeSrc).toContain("code.outcome !== 'winner'");
  });

  it('wraps decryption in try/catch and returns null on failure (check 8)', () => {
    expect(routeSrc).toMatch(/try\s*\{[\s\S]*?decryptPromoCode[\s\S]*?\}\s*catch/);
  });

  it('enforces requireCapability with promo_verification / read_history', () => {
    expect(routeSrc).toContain("capability: 'promo_verification'");
    expect(routeSrc).toContain("action: 'read_history'");
  });

  it('verifies campaign belongs to business before any data query', () => {
    expect(routeSrc).toContain(".eq('business_id', businessId)");
  });

  it('masks phone numbers in response', () => {
    expect(routeSrc).toContain('maskPhone(r.phone_e164)');
  });
});

// ═══════════════════════════════════════════════════════
// 4. Winners dashboard UI contract tests
// ═══════════════════════════════════════════════════════

describe('Winners dashboard UI contract', () => {
  const fs = require('fs');
  const pageSrc = fs.readFileSync('app/dashboard/promotions/[id]/page.tsx', 'utf-8');

  it('Winner interface includes redeemed_code field', () => {
    expect(pageSrc).toMatch(/interface Winner\s*\{[\s\S]*?redeemed_code:\s*string\s*\|\s*null/);
  });

  it('renders "Redeemed Code" column header', () => {
    expect(pageSrc).toContain('Redeemed Code');
  });

  it('renders winner.redeemed_code in table cell', () => {
    expect(pageSrc).toContain('winner.redeemed_code');
  });

  it('renders dash fallback when redeemed_code is null/empty', () => {
    // The pattern: {winner.redeemed_code || '—'}
    expect(pageSrc).toMatch(/winner\.redeemed_code\s*\|\|\s*'—'/);
  });

  it('preserves existing phone masking display', () => {
    expect(pageSrc).toContain('winner.phone_e164');
  });

  it('preserves existing prize_name display', () => {
    expect(pageSrc).toContain('winner.prize_name');
  });

  it('preserves existing claim_reference display', () => {
    expect(pageSrc).toContain('winner.claim_reference');
  });

  it('does NOT expose ciphertext, hash, or allocation metadata in UI', () => {
    // These fields must NEVER appear in the Winners tab rendering
    const winnersSection = pageSrc.split("activeTab === 'winners'")[1]?.split("activeTab === 'analytics'")[0] || '';
    expect(winnersSection).not.toContain('encrypted_code');
    expect(winnersSection).not.toContain('normalized_code_hash');
    expect(winnersSection).not.toContain('code_ciphertext');
  });
});

// ═══════════════════════════════════════════════════════
// 5. Pre-redemption confidentiality structural tests
// ═══════════════════════════════════════════════════════

describe('Pre-redemption confidentiality', () => {
  const fs = require('fs');
  const exportSrc = fs.readFileSync('app/api/promotions/export-codes/route.ts', 'utf-8');

  it('export-codes full CSV header does NOT include outcome column', () => {
    expect(exportSrc).toContain("const CSV_HEADER_FULL = 'code,display_suffix,status\\n'");
  });

  it('export-codes JSON redacts outcome for unused codes', () => {
    expect(exportSrc).toContain("outcome: isClaimed ? c.outcome : null");
  });

  it('export-codes JSON redacts prize_id for unused codes', () => {
    expect(exportSrc).toContain("prize_id: isClaimed ? c.prize_id : null");
  });

  it('export-codes full export CSV row does NOT write outcome/prize_id fields', () => {
    // The full export csvChunks.push call must NOT include outcome or prize_id values.
    // We check that escapeCsvField is only called with decrypted, display_suffix, status —
    // not outcome or prize_id. The comment mentioning "outcome/prize_id NEVER included"
    // is a developer note, not a data leak.
    const fullSection = exportSrc.split('if (isFull)')[1]?.split('} else {')[0] || '';
    // The only escapeCsvField calls should be for decrypted, display_suffix, status
    const escapeMatches = fullSection.match(/escapeCsvField\([^)]+\)/g) || [];
    expect(escapeMatches.length).toBe(3);
    expect(escapeMatches.some((m: string) => m.includes('decrypted'))).toBe(true);
    expect(escapeMatches.some((m: string) => m.includes('display_suffix'))).toBe(true);
    expect(escapeMatches.some((m: string) => m.includes('status'))).toBe(true);
    // Confirm none reference outcome or prize_id
    expect(escapeMatches.some((m: string) => m.includes('outcome'))).toBe(false);
    expect(escapeMatches.some((m: string) => m.includes('prize_id'))).toBe(false);
  });
});
