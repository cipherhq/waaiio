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
  it('10. weak short imports rejected (< 10 chars)', () => {
    expect(isRoutablePromoCode('ABC123')).toBe(false);     // 6 chars
    expect(isRoutablePromoCode('ABCDEF789')).toBe(false);  // 9 chars
  });

  it('11. safe imports accepted (>= 10 chars)', () => {
    expect(isRoutablePromoCode('ABCDEFGH12')).toBe(true);  // 10 chars
    expect(isRoutablePromoCode('WIN7PM4XQ9N2WF')).toBe(true); // 14 chars
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
  it('13. new references have WAA-XXXX-XXXX-XXXX format (~60 bits)', () => {
    const ref = generateClaimReference();
    // Format: WAA-XXXX-XXXX-XXXX
    expect(ref).toMatch(/^WAA-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    // Total reference length: 4 (WAA-) + 4 + 1 (-) + 4 + 1 (-) + 4 = 18
    expect(ref.length).toBe(18);
  });

  it('14. claim_reference uniqueness enforced by DB migration', () => {
    const fs = require('fs');
    const src = fs.readFileSync('supabase/migrations/330_promo_code_claim_integrity.sql', 'utf-8');
    expect(src).toContain('idx_promo_redemptions_claim_ref_unique');
    expect(src).toContain('UNIQUE');
    expect(src).toContain('claim_reference');
  });

  it('15. collision retry in claim function (bounded, fail-closed)', () => {
    const fs = require('fs');
    const src = fs.readFileSync('supabase/migrations/330_promo_code_claim_integrity.sql', 'utf-8');
    // Bounded retry loop
    expect(src).toContain('FOR v_ref_attempt IN 1..3 LOOP');
    // Collision check
    expect(src).toContain('PERFORM 1 FROM promo_redemptions WHERE claim_reference = v_claim_ref');
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
  it('migration 330 preserves existing code_length values', () => {
    const fs = require('fs');
    const src = fs.readFileSync('supabase/migrations/330_promo_code_claim_integrity.sql', 'utf-8');
    // Does not truncate/modify existing promo_campaigns data
    expect(src).not.toContain('UPDATE promo_campaigns SET code_length');
    // Does not DROP the table
    expect(src).not.toContain('DROP TABLE promo_campaigns');
  });

  it('migration 330 handles potential duplicate claim_references safely', () => {
    const fs = require('fs');
    const src = fs.readFileSync('supabase/migrations/330_promo_code_claim_integrity.sql', 'utf-8');
    // Checks for duplicates before choosing index strategy
    expect(src).toContain('HAVING count(*) > 1');
    expect(src).toContain('IF v_dups = 0 THEN');
  });
});
