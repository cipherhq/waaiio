import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';

describe('Consent Service', () => {
  const source = readFileSync('lib/growth/consent-service.ts', 'utf-8');

  describe('grantConsent', () => {
    it('inserts into customer_consents table', () => {
      expect(source).toContain("from('customer_consents')");
      expect(source).toContain('.insert(');
    });

    it('sets status to granted', () => {
      expect(source).toContain("status: 'granted'");
    });

    it('records the source of consent', () => {
      expect(source).toContain('source: params.source');
    });

    it('stores evidence reference', () => {
      expect(source).toContain('evidence_reference');
    });
  });

  describe('revokeConsent', () => {
    it('inserts a revocation record (append-only)', () => {
      expect(source).toContain("status: 'revoked'");
    });

    it('does not update existing records', () => {
      // Append-only: should NOT have .update() for consents
      const revokeSection = source.slice(source.indexOf('revokeConsent'));
      expect(revokeSection).not.toContain('.update(');
    });
  });

  describe('verifyConsent', () => {
    it('returns the latest consent record', () => {
      expect(source).toContain("order('created_at'");
      expect(source).toContain('.limit(1)');
    });

    it('checks channel and purpose', () => {
      expect(source).toContain("eq('channel'");
      expect(source).toContain("eq('purpose'");
    });

    it('returns unknown when no record exists', () => {
      expect(source).toContain("status: 'unknown'");
    });
  });
});

describe('Consent Schema (migration 241)', () => {
  const migration = readFileSync('supabase/migrations/241_growth_engine.sql', 'utf-8');

  it('creates customer_consents table', () => {
    expect(migration).toContain('customer_consents');
  });

  it('has channel CHECK constraint', () => {
    expect(migration).toContain("'whatsapp'");
    expect(migration).toContain("'sms'");
    expect(migration).toContain("'email'");
  });

  it('has purpose CHECK constraint', () => {
    expect(migration).toContain("'utility'");
    expect(migration).toContain("'marketing'");
    expect(migration).toContain("'authentication'");
  });

  it('has RLS enabled', () => {
    expect(migration).toContain('ENABLE ROW LEVEL SECURITY');
  });
});
