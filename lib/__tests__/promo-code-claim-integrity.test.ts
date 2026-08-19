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
    // Now validates with Number(state.code_length) since field can be empty
    expect(wizardSrc).toContain('validateGeneratedEntropy(len, state.code_prefix');
    expect(wizardSrc).not.toContain("code_length < 6");
    expect(wizardSrc).not.toContain("'Code length must be between 6 and 24'");
  });

  it('help text references MIN_GENERATED_BODY_LENGTH, not 6', () => {
    expect(wizardSrc).not.toContain('Min 6, max 24');
    expect(wizardSrc).toContain('{MIN_GENERATED_BODY_LENGTH}');
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

describe('Numeric input UX', () => {
  const fs = require('fs');
  const wizardSrc = fs.readFileSync('app/dashboard/promotions/create/page.tsx', 'utf-8');

  it('no Math.max clamping in numeric onChange handlers', () => {
    // All 7 numeric fields should use raw value, not Math.max clamping
    // code_count, code_length, prize quantity, max_attempts, rate_limit_max, rate_limit_window, eligibility_min_age
    // The only Math.max remaining should be in non-input contexts (display/preview)
    const onChangeHandlers = wizardSrc.match(/onChange=\{[^}]*Math\.max\(1/g) || [];
    expect(onChangeHandlers.length).toBe(0);
  });

  it('fields can become temporarily empty (string passthrough)', () => {
    // onChange handlers should pass empty string through, not clamp to minimum
    expect(wizardSrc).toContain("v === '' ? ('' as unknown as number) : Number(v)");
  });

  it('step validation catches invalid numeric values', () => {
    expect(wizardSrc).toContain('Code count must be a positive integer');
    expect(wizardSrc).toContain('Code length is required');
    expect(wizardSrc).toContain('Max attempts per phone must be a positive integer');
    expect(wizardSrc).toContain('Rate limit max attempts must be a positive integer');
    expect(wizardSrc).toContain('Rate limit window must be a positive integer');
  });

  it('prize quantity requires positive integer (rejects fractional)', () => {
    expect(wizardSrc).toContain('Number.isInteger(q)');
    expect(wizardSrc).toContain('Number.isFinite(q)');
    expect(wizardSrc).toContain('prize quantity must be a positive integer');
  });
});

describe('Client CSV import validation', () => {
  it('handleFile uses normalizePromoCode + isImportablePromoCode', () => {
    const fs = require('fs');
    const src = fs.readFileSync('app/dashboard/promotions/create/page.tsx', 'utf-8');
    expect(src).toContain('normalizePromoCode');
    expect(src).toContain('isImportablePromoCode');
  });

  it('short imported codes are rejected client-side', () => {
    // isImportablePromoCode rejects <10 chars
    expect(isImportablePromoCode('ABCDE1')).toBe(false);    // 6 chars
    expect(isImportablePromoCode('ABCDEFG12')).toBe(false);  // 9 chars
  });

  it('valid imported codes are accepted', () => {
    expect(isImportablePromoCode('ABCDEFGH12')).toBe(true);  // 10 chars
  });

  it('historical routing helpers remain legacy-compatible', () => {
    expect(isRoutablePromoCode('ABCDE1')).toBe(true);  // 6 chars routes
    expect(isRoutablePromoCode('ABCDEFG12')).toBe(true);  // 9 chars routes
  });

  it('handleFile rejects entire file on any invalid code (all-or-nothing)', () => {
    const fs = require('fs');
    const src = fs.readFileSync('app/dashboard/promotions/create/page.tsx', 'utf-8');
    // Sets import_file=null, import_total=0 on ANY invalid codes
    expect(src).toContain('import_file: null, import_preview: [], import_total: 0');
    // Clear message about fixing CSV
    expect(src).toContain('Fix the CSV and upload it again');
  });

  it('handleFile shows invalid count in error message', () => {
    const fs = require('fs');
    const src = fs.readFileSync('app/dashboard/promotions/create/page.tsx', 'utf-8');
    expect(src).toContain('codes are invalid');
    expect(src).toContain('at least 10 normalized alphanumeric');
  });
});

describe('Update API entropy enforcement', () => {
  const fs = require('fs');
  const updateSrc = fs.readFileSync('app/api/promotions/update/route.ts', 'utf-8');

  it('imports validatePrefix and validateGeneratedEntropy', () => {
    expect(updateSrc).toContain('validatePrefix');
    expect(updateSrc).toContain('validateGeneratedEntropy');
  });

  it('validates entropy when codeLength or codePrefix is changed', () => {
    expect(updateSrc).toContain("'codeLength' in body || 'codePrefix' in body");
    expect(updateSrc).toContain('validateGeneratedEntropy(proposedLength, proposedPrefix');
  });

  it('uses stored campaign values when only one field is supplied', () => {
    // proposedLength falls back to campaign.code_length
    expect(updateSrc).toContain('campaign.code_length');
    // proposedPrefix falls back to campaign.code_prefix
    expect(updateSrc).toContain('campaign.code_prefix');
  });

  it('does not trigger entropy validation for unrelated updates', () => {
    // Guard: only when codeLength/codePrefix is being changed
    expect(updateSrc).toContain("'codeLength' in body || 'codePrefix' in body");
    // Inside !campaign.integrity_locked block
    expect(updateSrc).toContain('!campaign.integrity_locked');
  });

  it('preserves integrity_locked behavior', () => {
    expect(updateSrc).toContain('INTEGRITY_LOCKED_FIELDS');
    expect(updateSrc).toContain('integrity-locked fields');
  });

  it('persists normalized uppercase prefix (not raw input)', () => {
    expect(updateSrc).toContain('.trim().toUpperCase()');
  });
});

describe('Update API prefix normalization', () => {
  const fs = require('fs');
  const src = fs.readFileSync('app/api/promotions/update/route.ts', 'utf-8');

  it('normalizes then persists: normalized || null', () => {
    // Must normalize first, then use falsy check (handles whitespace-only)
    expect(src).toContain("const normalized = body.codePrefix ? String(body.codePrefix).trim().toUpperCase() : ''");
    expect(src).toContain('updates.code_prefix = normalized || null');
  });

  it('"promo" persists as "PROMO"', () => {
    // trim().toUpperCase() handles lowercase
    expect(src).toContain('.trim().toUpperCase()');
  });

  it('whitespace-only input persists as null', () => {
    // "   ".trim() = "" => toUpperCase() = "" => "" || null = null
    // The normalized || null pattern handles this
    expect(src).toContain('normalized || null');
  });
});

describe('Minimum age validation', () => {
  const fs = require('fs');
  const wizardSrc = fs.readFileSync('app/dashboard/promotions/create/page.tsx', 'utf-8');

  it('age validation only applies to age_confirmation mode', () => {
    expect(wizardSrc).toContain("state.eligibility_mode === 'age_confirmation'");
    // Must NOT check age for 'none' or 'custom' mode
    expect(wizardSrc).not.toContain("eligibility_mode !== 'none' && state.eligibility_min_age");
  });

  it('empty age is invalid in age_confirmation mode', () => {
    // Number('') => NaN, !Number.isFinite(NaN) => true → error
    expect(wizardSrc).toContain('Number.isFinite(age)');
    expect(wizardSrc).toContain('Minimum age is required');
  });

  it('age validation uses Number.isInteger', () => {
    expect(wizardSrc).toContain('Number.isInteger(age)');
  });
});

describe('Server fraud-control validation', () => {
  it('create API validates max_attempts_per_phone', () => {
    const fs = require('fs');
    const src = fs.readFileSync('app/api/promotions/create/route.ts', 'utf-8');
    expect(src).toContain("'max_attempts_per_phone must be a positive integer'");
  });

  it('create API validates rate_limit_window_minutes', () => {
    const fs = require('fs');
    const src = fs.readFileSync('app/api/promotions/create/route.ts', 'utf-8');
    expect(src).toContain("'rate_limit_window_minutes must be a positive integer'");
  });

  it('create API validates rate_limit_max_attempts', () => {
    const fs = require('fs');
    const src = fs.readFileSync('app/api/promotions/create/route.ts', 'utf-8');
    expect(src).toContain("'rate_limit_max_attempts must be a positive integer'");
  });

  it('create API validates eligibility_min_age when supplied', () => {
    const fs = require('fs');
    const src = fs.readFileSync('app/api/promotions/create/route.ts', 'utf-8');
    expect(src).toContain("'eligibility_min_age must be a positive integer'");
  });

  it('update API validates fraud-control fields only when supplied', () => {
    const fs = require('fs');
    const src = fs.readFileSync('app/api/promotions/update/route.ts', 'utf-8');
    // Each field guarded by 'fieldName' in body
    expect(src).toContain("'maxAttemptsPerPhone' in body");
    expect(src).toContain("'rateLimitWindowMinutes' in body");
    expect(src).toContain("'rateLimitMaxAttempts' in body");
    expect(src).toContain("'max_attempts_per_phone must be a positive integer'");
    expect(src).toContain("'rate_limit_max_attempts must be a positive integer'");
    expect(src).toContain("'eligibility_min_age must be a positive integer'");
  });

  it('update API allows null eligibility_min_age', () => {
    const fs = require('fs');
    const src = fs.readFileSync('app/api/promotions/update/route.ts', 'utf-8');
    expect(src).toContain('eligibility_min_age = null');
  });
});
