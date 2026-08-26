/**
 * Promo Winner Visibility Tests (#190) — Correction Round 1
 *
 * Exercises the REAL production resolveRedeemedCode from
 * lib/promotions/resolve-winner-code.ts with a deterministic
 * test encryption key. No copied resolver. No silent skips.
 *
 * Deterministic crypto: TOKEN_ENCRYPTION_KEY is set to a fixed
 * 64-hex-char test key before module import. Every positive
 * encryption/decryption assertion genuinely executes the AES-256-GCM
 * path and will fail CI if broken.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

// ═══════════════════════════════════════════════════════
// Deterministic test encryption key — 64 hex = 32 bytes for AES-256-GCM.
// Set BEFORE any module reads TOKEN_ENCRYPTION_KEY at import time.
// ═══════════════════════════════════════════════════════
const TEST_KEY = 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789';
let originalKey: string | undefined;

beforeAll(() => {
  originalKey = process.env.TOKEN_ENCRYPTION_KEY;
  process.env.TOKEN_ENCRYPTION_KEY = TEST_KEY;
});

afterAll(() => {
  if (originalKey !== undefined) {
    process.env.TOKEN_ENCRYPTION_KEY = originalKey;
  } else {
    delete process.env.TOKEN_ENCRYPTION_KEY;
  }
});

import type { CodeJoin } from '@/lib/promotions/resolve-winner-code';
import { formatPromoCode } from '@/lib/promotions/normalize';

const CAMPAIGN_A = '00000000-0000-0000-0000-000000000001';
const CAMPAIGN_B = '00000000-0000-0000-0000-000000000002';
const TEST_NORMALIZED = 'K7PM4XQ9N2WF';
const TEST_FORMATTED = 'K7PM-4XQ9-N2WF';

// ═══════════════════════════════════════════════════════
// 1. Production resolveRedeemedCode — behavioral tests
// ═══════════════════════════════════════════════════════

describe('resolveRedeemedCode — production function with deterministic crypto', () => {
  let validEncrypted: string;

  beforeAll(async () => {
    const { encryptPromoCode } = await import('@/lib/promotions/crypto');
    validEncrypted = encryptPromoCode(TEST_NORMALIZED);
    // Verify real AES-256-GCM encryption occurred (not plaintext passthrough)
    expect(validEncrypted).not.toBe(TEST_NORMALIZED);
    expect(validEncrypted.split(':')).toHaveLength(3);
  });

  async function callResolve(
    codeRow: CodeJoin | CodeJoin[] | null,
    campaignId: string,
  ): Promise<string | null> {
    const { resolveRedeemedCode } = await import('@/lib/promotions/resolve-winner-code');
    return resolveRedeemedCode(codeRow, campaignId);
  }

  function makeCodeRow(overrides: Partial<CodeJoin> = {}): CodeJoin {
    return {
      encrypted_code: validEncrypted,
      campaign_id: CAMPAIGN_A,
      status: 'claimed',
      outcome: 'winner',
      ...overrides,
    };
  }

  it('authorized + claimed winner → exact formatted redeemed code', async () => {
    const result = await callResolve(makeCodeRow(), CAMPAIGN_A);
    expect(result).toBe(TEST_FORMATTED);
  });

  it('crypto round-trip: encrypted value decrypts to original', async () => {
    const { decryptPromoCode } = await import('@/lib/promotions/crypto');
    const decrypted = decryptPromoCode(validEncrypted);
    expect(decrypted).toBe(TEST_NORMALIZED);
    expect(formatPromoCode(decrypted)).toBe(TEST_FORMATTED);
  });

  it('status="unused" → no decryption (pre-redemption confidentiality)', async () => {
    expect(await callResolve(makeCodeRow({ status: 'unused' }), CAMPAIGN_A)).toBeNull();
  });

  it('status="void" → no disclosure', async () => {
    expect(await callResolve(makeCodeRow({ status: 'void' }), CAMPAIGN_A)).toBeNull();
  });

  it('claimed loser (outcome="try_again") → no disclosure', async () => {
    expect(await callResolve(makeCodeRow({ outcome: 'try_again' }), CAMPAIGN_A)).toBeNull();
  });

  it('code/redemption campaign mismatch → no disclosure', async () => {
    expect(await callResolve(makeCodeRow({ campaign_id: CAMPAIGN_B }), CAMPAIGN_A)).toBeNull();
  });

  it('corrupt ciphertext (valid iv:tag:data format) → null, no leakage', async () => {
    const corrupt = 'aabbccdd00112233aabbccdd:0011223344556677aabbccddeeff0011:deadbeef';
    const result = await callResolve(makeCodeRow({ encrypted_code: corrupt }), CAMPAIGN_A);
    expect(result).toBeNull();
  });

  it('non-encrypted plaintext passthrough → rejected by isRoutablePromoCode', async () => {
    const result = await callResolve(
      makeCodeRow({ encrypted_code: 'totally-invalid-not-a-code' }),
      CAMPAIGN_A,
    );
    expect(result).toBeNull();
  });

  it('null encrypted_code → null', async () => {
    expect(await callResolve(makeCodeRow({ encrypted_code: null }), CAMPAIGN_A)).toBeNull();
  });

  it('null codeRow (missing/unresolvable promo_code_id) → null', async () => {
    expect(await callResolve(null, CAMPAIGN_A)).toBeNull();
  });

  it('empty array (PostgREST null relationship) → null', async () => {
    expect(await callResolve([], CAMPAIGN_A)).toBeNull();
  });

  it('PostgREST array shape (single-element) → resolves correctly', async () => {
    expect(await callResolve([makeCodeRow()], CAMPAIGN_A)).toBe(TEST_FORMATTED);
  });

  it('PostgREST array with failing first element → null', async () => {
    expect(await callResolve([makeCodeRow({ status: 'unused' })], CAMPAIGN_A)).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════
// 2. API response contract — no secret leakage
// ═══════════════════════════════════════════════════════

describe('Winners API response contract — no secret leakage', () => {
  const fs = require('fs');
  const routeSrc = fs.readFileSync('app/api/promotions/winners/route.ts', 'utf-8');
  const responseBlock = routeSrc.split('const winners =')[1]?.split('return NextResponse.json')[0] || '';

  it('response includes redeemed_code', () => {
    expect(responseBlock).toContain('redeemed_code:');
  });

  it('response masks phone via maskPhone', () => {
    expect(responseBlock).toContain('maskPhone(r.phone_e164)');
  });

  it('response does NOT expose encrypted_code', () => {
    const mappedFields = responseBlock.match(/^\s+\w+:/gm) || [];
    const fieldNames = mappedFields.map((f: string) => f.trim().replace(':', ''));
    expect(fieldNames).not.toContain('encrypted_code');
  });

  it('route does NOT expose normalized_code_hash', () => {
    expect(routeSrc).not.toContain('normalized_code_hash');
  });

  it('response does NOT expose display_suffix', () => {
    const mappedFields = responseBlock.match(/^\s+\w+:/gm) || [];
    const fieldNames = mappedFields.map((f: string) => f.trim().replace(':', ''));
    expect(fieldNames).not.toContain('display_suffix');
  });

  it('route imports resolveRedeemedCode from shared module', () => {
    expect(routeSrc).toContain("from '@/lib/promotions/resolve-winner-code'");
  });

  it('route enforces promo_verification / read_history capability', () => {
    expect(routeSrc).toContain("capability: 'promo_verification'");
    expect(routeSrc).toContain("action: 'read_history'");
  });

  it('route verifies campaign belongs to business before data query', () => {
    const beforeQuery = routeSrc.split('promo_redemptions')[0] || '';
    expect(beforeQuery).toContain("from('promo_campaigns')");
    expect(beforeQuery).toContain(".eq('business_id', businessId)");
  });

  it('route filters to outcome=winner only', () => {
    expect(routeSrc).toContain(".eq('outcome', 'winner')");
  });

  it('route joins promo_campaign_codes via FK', () => {
    expect(routeSrc).toContain('promo_campaign_codes!promo_code_id');
  });
});

// ═══════════════════════════════════════════════════════
// 3. Dashboard UI contract
// ═══════════════════════════════════════════════════════

describe('Winners dashboard UI contract', () => {
  const fs = require('fs');
  const pageSrc = fs.readFileSync('app/dashboard/promotions/[id]/page.tsx', 'utf-8');

  it('Winner interface includes redeemed_code: string | null', () => {
    expect(pageSrc).toMatch(/interface Winner\s*\{[\s\S]*?redeemed_code:\s*string\s*\|\s*null/);
  });

  it('renders "Redeemed Code" column header', () => {
    expect(pageSrc).toContain('Redeemed Code');
  });

  it('renders winner.redeemed_code with dash fallback', () => {
    expect(pageSrc).toMatch(/winner\.redeemed_code\s*\|\|\s*'—'/);
  });

  it('preserves phone masking display', () => {
    expect(pageSrc).toContain('{winner.phone_e164}');
  });

  it('Winners table does NOT render secret fields', () => {
    const tableStart = pageSrc.indexOf('Redeemed Code');
    const tableEnd = pageSrc.indexOf('</table>', tableStart);
    const winnersTable = pageSrc.slice(tableStart, tableEnd);
    expect(winnersTable).not.toContain('encrypted_code');
    expect(winnersTable).not.toContain('normalized_code_hash');
    expect(winnersTable).not.toContain('code_ciphertext');
  });
});

// ═══════════════════════════════════════════════════════
// 4. Pre-redemption confidentiality — export paths unchanged
// ═══════════════════════════════════════════════════════

describe('Pre-redemption confidentiality — export paths unchanged', () => {
  const fs = require('fs');
  const exportSrc = fs.readFileSync('app/api/promotions/export-codes/route.ts', 'utf-8');

  it('full CSV header omits outcome', () => {
    expect(exportSrc).toContain("const CSV_HEADER_FULL = 'code,display_suffix,status\\n'");
  });

  it('JSON mode redacts outcome for unused codes', () => {
    expect(exportSrc).toContain('outcome: isClaimed ? c.outcome : null');
  });

  it('JSON mode redacts prize_id for unused codes', () => {
    expect(exportSrc).toContain('prize_id: isClaimed ? c.prize_id : null');
  });
});
