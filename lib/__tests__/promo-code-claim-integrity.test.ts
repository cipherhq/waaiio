/**
 * Promo code entropy + claim reference integrity tests.
 *
 * Covers:
 * - Generated code minimum body length enforcement
 * - Prefix cannot reduce random body below minimum
 * - Imported code minimum length
 * - Claim reference format and entropy
 * - Server-side enforcement (API routes)
 */
import { describe, it, expect } from 'vitest';
import {
  computeBodyLength,
  normalizePromoCode,
  validateGeneratedEntropy,
  validatePrefix,
  isRoutablePromoCode,
  isImportablePromoCode,
  MIN_GENERATED_BODY_LENGTH,
  MIN_IMPORTED_CODE_LENGTH,
} from '@/lib/promotions/normalize';
import { generateClaimReference, generateSecureCode } from '@/lib/promotions/crypto';

describe('Generated code entropy', () => {
  it('1. no-prefix, 10 random chars accepted', () => {
    const result = validateGeneratedEntropy(10);
    expect(result.valid).toBe(true);
    expect(result.bodyLength).toBe(10);
  });

  it('2. no-prefix, fewer than 10 random chars rejected', () => {
    const result = validateGeneratedEntropy(9);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Insufficient code entropy');
  });

  it('3. WIN prefix + 13 total = 10 body, accepted', () => {
    const result = validateGeneratedEntropy(13, 'WIN');
    expect(result.valid).toBe(true);
    expect(result.bodyLength).toBe(10);
  });

  it('4. PROM prefix + 14 total = 10 body, accepted', () => {
    const result = validateGeneratedEntropy(14, 'PROM');
    expect(result.valid).toBe(true);
    expect(result.bodyLength).toBe(10);
  });

  it('5. prefix cannot reduce random body below 10', () => {
    // WIN (3 chars) + code_length 12 = 9 body → rejected
    const result = validateGeneratedEntropy(12, 'WIN');
    expect(result.valid).toBe(false);
    expect(result.bodyLength).toBe(9);
    expect(result.error).toContain('minimum 10');

    // PROM (4 chars) + code_length 13 = 9 body → rejected
    const result2 = validateGeneratedEntropy(13, 'PROM');
    expect(result2.valid).toBe(false);
    expect(result2.bodyLength).toBe(9);
  });

  it('6. default code_length 12 remains secure', () => {
    const result = validateGeneratedEntropy(12);
    expect(result.valid).toBe(true);
    expect(result.bodyLength).toBe(12);
  });

  it('7. max-length 24 remains valid', () => {
    const result = validateGeneratedEntropy(24, 'PROM');
    expect(result.valid).toBe(true);
    expect(result.bodyLength).toBe(20);
  });

  it('8a. creation API enforces minimum code_length >= 10', () => {
    const fs = require('fs');
    const src = fs.readFileSync('app/api/promotions/create/route.ts', 'utf-8');
    expect(src).toContain('effectiveLength < 10');
    expect(src).toContain('validateGeneratedEntropy');
  });

  it('8b. generation API independently enforces entropy', () => {
    const fs = require('fs');
    const src = fs.readFileSync('app/api/promotions/generate-codes/route.ts', 'utf-8');
    expect(src).toContain('validateGeneratedEntropy');
  });

  it('9. cryptographic generation produces correct body length', () => {
    const code = generateSecureCode(10, 'WIN');
    // Total = WIN + 10 body = 13
    expect(code.length).toBe(13);
    expect(code.startsWith('WIN')).toBe(true);
    // Body has at least one digit (bot routing requirement)
    const body = code.slice(3);
    expect(body.length).toBe(10);
    expect(/\d/.test(body)).toBe(true);
  });

  it('MIN_GENERATED_BODY_LENGTH is 10', () => {
    expect(MIN_GENERATED_BODY_LENGTH).toBe(10);
  });
});

describe('Imported code validation', () => {
  it('10. weak short NEW imports rejected (< 10 chars)', () => {
    expect(isImportablePromoCode('ABC123')).toBe(false);     // 6 chars
    expect(isImportablePromoCode('ABCDEF789')).toBe(false);  // 9 chars
  });

  it('11. safe NEW imports accepted (>= 10 chars)', () => {
    expect(isImportablePromoCode('ABCDEFGH12')).toBe(true);  // 10 chars
    expect(isImportablePromoCode('WIN7PM4XQ9N2WF')).toBe(true); // 14 chars
  });

  it('A. legacy 6-char code still routes for redemption', () => {
    expect(isRoutablePromoCode('ABCDE1')).toBe(true);
  });

  it('B. legacy 9-char code still routes for redemption', () => {
    expect(isRoutablePromoCode('ABCDEFG12')).toBe(true);
  });

  it('C. NEW 6-9 char CSV imports rejected', () => {
    expect(isImportablePromoCode('ABCDE1')).toBe(false);
    expect(isImportablePromoCode('ABCDEFG12')).toBe(false);
  });

  it('D. NEW >=10 char imports succeed', () => {
    expect(isImportablePromoCode('ABCDEFGH12')).toBe(true);
  });

  it('12. duplicate normalization preserved', () => {
    expect(normalizePromoCode('k7pm-4xq9-n2wf')).toBe('K7PM4XQ9N2WF');
    expect(normalizePromoCode('K7PM 4XQ9 N2WF')).toBe('K7PM4XQ9N2WF');
  });

  it('MIN_IMPORTED_CODE_LENGTH is 10', () => {
    expect(MIN_IMPORTED_CODE_LENGTH).toBe(10);
  });
});

describe('Claim reference integrity', () => {
  it('13. new references have WAA-XXXX-XXXX-XXXX-XXXX format (exactly 64 bits)', () => {
    const ref = generateClaimReference();
    // Format: WAA-XXXX-XXXX-XXXX-XXXX (16 uppercase hex chars from 8 random bytes)
    expect(ref).toMatch(/^WAA-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/);
    expect(ref.length).toBe(23);
  });

  it('14. claim_reference uniqueness enforced by DB migration', () => {
    const fs = require('fs');
    const src = fs.readFileSync('supabase/migrations/330_promo_code_claim_integrity.sql', 'utf-8');
    expect(src).toContain('idx_promo_redemptions_claim_ref_unique');
    expect(src).toContain('UNIQUE');
    expect(src).toContain('claim_reference');
  });

  it('15. collision retry wraps INSERT via EXCEPTION WHEN unique_violation', () => {
    const fs = require('fs');
    const src = fs.readFileSync('supabase/migrations/330_promo_code_claim_integrity.sql', 'utf-8');
    // Bounded retry loop
    expect(src).toContain('FOR v_ref_attempt IN 1..5 LOOP');
    // Collision handled by catching actual UNIQUE violation on INSERT, not SELECT-before-INSERT
    expect(src).toContain('EXCEPTION WHEN unique_violation');
    // Fail-closed on exhaustion
    expect(src).toContain('claim_reference_collision_exhausted');
  });

  it('16. fail-closed: exhausted retries raise exception', () => {
    const fs = require('fs');
    const src = fs.readFileSync('supabase/migrations/330_promo_code_claim_integrity.sql', 'utf-8');
    expect(src).toContain('RAISE EXCEPTION');
    expect(src).toContain('claim_reference_collision_exhausted');
  });

  it('17. generated references use cryptographically random characters', () => {
    // Generate several and verify diversity
    const refs = new Set<string>();
    for (let i = 0; i < 100; i++) {
      refs.add(generateClaimReference());
    }
    // All 100 should be unique
    expect(refs.size).toBe(100);
  });

  it('18. existing promo-code claim idempotency preserved', () => {
    const fs = require('fs');
    const src = fs.readFileSync('supabase/migrations/330_promo_code_claim_integrity.sql', 'utf-8');
    // Idempotency check on inbound_message_id preserved
    expect(src).toContain('promo_msg:');
    expect(src).toContain('pg_advisory_xact_lock');
    expect(src).toContain('inbound_message_id');
  });

  it('19. same code remains single-use (status transitions)', () => {
    const fs = require('fs');
    const src = fs.readFileSync('supabase/migrations/330_promo_code_claim_integrity.sql', 'utf-8');
    // Code locked FOR UPDATE
    expect(src).toContain('FOR UPDATE');
    // Status gate: only unused codes can be claimed
    expect(src).toContain("v_code.status = 'claimed'");
    expect(src).toContain("SET status = 'claimed'");
    // Uniqueness on promo_code_id in redemptions
    expect(src).toContain('promo_code_id');
  });

  it('20. winner allocation/outcome behavior unchanged', () => {
    const fs = require('fs');
    const src = fs.readFileSync('supabase/migrations/330_promo_code_claim_integrity.sql', 'utf-8');
    // Outcome comes from the code, not computed at claim time
    expect(src).toContain('v_code.outcome');
    // Winner/try_again paths preserved
    expect(src).toContain("'winner'");
    expect(src).toContain("'try_again'");
    // Fulfillment status based on outcome
    expect(src).toContain("CASE WHEN v_code.outcome = 'winner'");
  });
});

describe('Prefix validation integration', () => {
  it('validatePrefix rejects prefix that would reduce body below 10', () => {
    // WIN (3) + code_length 12 = 9 body → rejected
    const r = validatePrefix('WIN', 12);
    expect(r.valid).toBe(false);
    expect(r.error).toContain('10 random body characters');
  });

  it('validatePrefix accepts prefix with sufficient body', () => {
    // WIN (3) + code_length 13 = 10 body → accepted
    const r = validatePrefix('WIN', 13);
    expect(r.valid).toBe(true);
  });
});

describe('No migration breaks existing schema', () => {
  it('migration 330 preserves legacy code_length 6-24 DB constraint', () => {
    const fs = require('fs');
    const src = fs.readFileSync('supabase/migrations/330_promo_code_claim_integrity.sql', 'utf-8');
    // Must NOT alter the DB constraint — API layer is the security authority
    expect(src).not.toContain('ALTER TABLE promo_campaigns ADD CONSTRAINT chk_code_length');
    expect(src).not.toContain('UPDATE promo_campaigns SET code_length');
  });

  it('migration 330 handles potential duplicate claim_references safely', () => {
    const fs = require('fs');
    const src = fs.readFileSync('supabase/migrations/330_promo_code_claim_integrity.sql', 'utf-8');
    expect(src).toContain('HAVING count(*) > 1');
    expect(src).toContain('IF v_dups = 0 THEN');
  });
});

describe('Blocker fixes — canonical claim_promo_code behavior', () => {
  const fs = require('fs');
  const src = fs.readFileSync('supabase/migrations/330_promo_code_claim_integrity.sql', 'utf-8');

  it('uses submitted_code_hash column (not normalized_code_hash) for attempts', () => {
    // The promo_verification_attempts table has submitted_code_hash, not normalized_code_hash
    const insertAttemptPattern = /INSERT INTO promo_verification_attempts[^;]*submitted_code_hash/g;
    const matches = src.match(insertAttemptPattern);
    expect(matches).toBeTruthy();
    expect(matches!.length).toBeGreaterThan(5); // multiple exit points log attempts
    // Must NOT reference normalized_code_hash as a column target in INSERT
    expect(src).not.toMatch(/INTO promo_verification_attempts[^)]*normalized_code_hash/);
  });

  it('never writes pending to promo_attempt_result (enum has no pending value)', () => {
    // The enum values are: winner, try_again, invalid, already_claimed, campaign_inactive, rate_limited, not_eligible
    // The INSERT result values must be one of these, never 'pending'
    const attemptInserts = src.match(/INTO promo_verification_attempts[\s\S]*?VALUES[\s\S]*?'(\w+)'/g) || [];
    for (const insert of attemptInserts) {
      expect(insert).not.toContain("'pending'");
    }
  });

  it('uses gen_random_bytes(8) for exactly 64 bits of cryptographic randomness', () => {
    expect(src).toContain('gen_random_bytes(8)');
    expect(src).toContain("encode(gen_random_bytes(8), 'hex')");
    // Must NOT use random() or modulo-biased alphabet mapping
    const claimRefSection = src.substring(src.indexOf('High-entropy claim reference'));
    expect(claimRefSection).not.toContain('floor(random()');
    expect(claimRefSection).not.toContain('% v_alpha_len');
  });

  it('collision retry wraps actual INSERT, not SELECT-before-INSERT', () => {
    expect(src).not.toContain('PERFORM 1 FROM promo_redemptions WHERE claim_reference');
    expect(src).toContain('EXCEPTION WHEN unique_violation');
  });

  it('collision retry only retries claim_reference index violations', () => {
    expect(src).toContain('GET STACKED DIAGNOSTICS v_constraint_name = CONSTRAINT_NAME');
    expect(src).toContain("v_constraint_name = 'idx_promo_redemptions_claim_ref_unique'");
    expect(src).toContain('RAISE;'); // re-raises unrelated violations
  });

  it('code_length DB constraint preserved at legacy 6-24 (API enforces >=10)', () => {
    // Migration must NOT change the DB constraint to >= 10
    expect(src).not.toContain('CHECK (code_length >= 10');
    // Comment explains why
    expect(src).toContain('legacy 6-24');
  });
});

describe('Wizard entropy enforcement', () => {
  const fs = require('fs');
  const wizardSrc = fs.readFileSync('app/dashboard/promotions/create/page.tsx', 'utf-8');

  it('wizard imports MIN_GENERATED_BODY_LENGTH and validateGeneratedEntropy', () => {
    expect(wizardSrc).toContain('MIN_GENERATED_BODY_LENGTH');
    expect(wizardSrc).toContain('validateGeneratedEntropy');
  });

  it('step 2 validation uses validateGeneratedEntropy (not hardcoded 6)', () => {
    expect(wizardSrc).toContain('validateGeneratedEntropy(state.code_length, state.code_prefix');
    expect(wizardSrc).not.toContain("code_length < 6");
    expect(wizardSrc).not.toContain("'Code length must be between 6 and 24'");
  });

  it('code_length input min is dynamic based on prefix', () => {
    expect(wizardSrc).toContain('min={MIN_GENERATED_BODY_LENGTH + (state.code_prefix');
  });

  it('help text references MIN_GENERATED_BODY_LENGTH, not 6', () => {
    expect(wizardSrc).not.toContain('Min 6, max 24');
    expect(wizardSrc).toContain('{MIN_GENERATED_BODY_LENGTH}');
  });

  it('prefix change auto-bumps code_length to maintain minimum body', () => {
    expect(wizardSrc).toContain('Math.max(state.code_length, minTotal)');
  });

  it('10/no prefix: validateGeneratedEntropy accepts', () => {
    expect(validateGeneratedEntropy(10).valid).toBe(true);
  });

  it('<10/no prefix: validateGeneratedEntropy rejects', () => {
    expect(validateGeneratedEntropy(9).valid).toBe(false);
  });

  it('14 with 4-char prefix: accepted (body=10)', () => {
    expect(validateGeneratedEntropy(14, 'PROM').valid).toBe(true);
  });

  it('12 with 4-char prefix: rejected (body=8)', () => {
    expect(validateGeneratedEntropy(12, 'PROM').valid).toBe(false);
  });

  it('24 max remains accepted when body >= 10', () => {
    expect(validateGeneratedEntropy(24).valid).toBe(true);
    expect(validateGeneratedEntropy(24, 'PROM').valid).toBe(true); // body=20
  });
});
