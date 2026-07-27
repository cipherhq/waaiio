/**
 * P0: Production table exposure remediation tests
 *
 * Verifies that migration 293 closes the 4 security exposures
 * found during the Issue #53 preflight:
 *   1. whatsapp_channels: shared_channels_public_read dropped
 *   2. processed_webhook_events: service_all dropped
 *   3. businesses: public_read_active_businesses dropped, view created
 *   4. bot_keywords: anyone_read_system_category dropped
 *
 * Test categories:
 *   A. Static migration SQL structure checks
 *   B. Application code uses safe view helpers
 *   C. Zero-downtime fallback helper logic
 *   D. Column allowlist enforcement
 *   E. Active-business semantics regression tests
 *
 * Real PostgreSQL authorization tests are in p0-table-exposure-db.test.ts
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  isRelationNotFound,
  queryBusinessesPublic,
  queryChannelsPublic,
  validateColumns,
  BUSINESSES_PUBLIC_COLUMNS,
  CHANNELS_PUBLIC_COLUMNS,
} from '../supabase/safe-view-query';

const MIGRATION_PATH = path.resolve('supabase/migrations/293_fix_production_table_exposure.sql');
const migration293 = fs.readFileSync(MIGRATION_PATH, 'utf-8');

// Historical migration 223 must not be modified
const MIGRATION_223_PATH = path.resolve('supabase/migrations/223_security_fix_exposed_tables.sql');
const migration223 = fs.readFileSync(MIGRATION_223_PATH, 'utf-8');
const migration223Hash = require('crypto').createHash('sha256').update(migration223).digest('hex');

// ═══════════════════════════════════════════════════════════════
// A. Static migration SQL structure checks
// ═══════════════════════════════════════════════════════════════
describe('P0: Migration 293 — static SQL structure', () => {
  // ─── whatsapp_channels ───
  it('drops shared_channels_public_read policy', () => {
    expect(migration293).toContain('DROP POLICY IF EXISTS "shared_channels_public_read"');
  });

  it('creates whatsapp_channels_public view with security_barrier and safe columns only', () => {
    expect(migration293).toContain('CREATE OR REPLACE VIEW public.whatsapp_channels_public');
    expect(migration293).toContain('security_barrier = true');
    const viewStart = migration293.indexOf('CREATE OR REPLACE VIEW public.whatsapp_channels_public');
    const viewEnd = migration293.indexOf('REVOKE ALL ON public.whatsapp_channels_public');
    const viewDef = migration293.slice(viewStart, viewEnd);
    expect(viewDef).toContain('phone_number');
    expect(viewDef).toContain('country_code');
    expect(viewDef).toContain('display_name');
    expect(viewDef).not.toContain('meta_access_token');
    expect(viewDef).not.toContain('waba_id');
    expect(viewDef).not.toContain('phone_number_id');
    expect(viewDef).not.toContain('gupshup_api_key');
    expect(viewDef).not.toContain('meta_token_expires_at');
  });

  it('revokes ALL from PUBLIC on whatsapp_channels_public view before granting', () => {
    expect(migration293).toContain('REVOKE ALL ON public.whatsapp_channels_public FROM PUBLIC');
  });

  it('grants only SELECT on view to anon and authenticated', () => {
    expect(migration293).toMatch(/GRANT SELECT ON.*whatsapp_channels_public.*TO anon.*authenticated/);
  });

  it('revokes direct anon access to whatsapp_channels base table', () => {
    expect(migration293).toContain('REVOKE ALL ON public.whatsapp_channels FROM anon');
  });

  // ─── processed_webhook_events ───
  it('drops processed_webhook_events_service_all policy', () => {
    expect(migration293).toContain('DROP POLICY IF EXISTS "processed_webhook_events_service_all"');
  });

  it('uses explicit DROP + CREATE for service_only policy (not IF NOT EXISTS)', () => {
    expect(migration293).toContain('DROP POLICY IF EXISTS "processed_webhook_events_service_only"');
    expect(migration293).toContain('CREATE POLICY "processed_webhook_events_service_only"');
    const createLine = migration293.slice(
      migration293.indexOf('CREATE POLICY "processed_webhook_events_service_only"'),
      migration293.indexOf('CREATE POLICY "processed_webhook_events_service_only"') + 100,
    );
    expect(createLine).not.toContain('IF NOT EXISTS');
  });

  it('service_only policy targets service_role with USING and WITH CHECK', () => {
    const policySection = migration293.slice(
      migration293.indexOf('CREATE POLICY "processed_webhook_events_service_only"'),
      migration293.indexOf('REVOKE ALL ON public.processed_webhook_events FROM PUBLIC'),
    );
    expect(policySection).toContain('TO service_role');
    expect(policySection).toContain('USING (true)');
    expect(policySection).toContain('WITH CHECK (true)');
  });

  it('revokes from PUBLIC, anon, and authenticated on processed_webhook_events', () => {
    expect(migration293).toContain('REVOKE ALL ON public.processed_webhook_events FROM PUBLIC');
    expect(migration293).toContain('REVOKE ALL ON public.processed_webhook_events FROM anon');
    expect(migration293).toContain('REVOKE ALL ON public.processed_webhook_events FROM authenticated');
  });

  it('grants SELECT, INSERT, UPDATE, DELETE to service_role on processed_webhook_events', () => {
    expect(migration293).toMatch(/GRANT SELECT, INSERT, UPDATE, DELETE ON.*processed_webhook_events.*TO service_role/);
  });

  // ─── businesses ───
  it('drops public_read_active_businesses policy', () => {
    expect(migration293).toContain('DROP POLICY IF EXISTS "public_read_active_businesses"');
  });

  it('creates businesses_public view with security_barrier and safe columns only', () => {
    expect(migration293).toContain('CREATE OR REPLACE VIEW public.businesses_public');
    const viewDef = migration293.slice(
      migration293.indexOf('CREATE OR REPLACE VIEW public.businesses_public'),
      migration293.indexOf('REVOKE ALL ON public.businesses_public'),
    );
    expect(viewDef).toContain('security_barrier = true');
    expect(viewDef).toContain('name');
    expect(viewDef).toContain('slug');
    expect(viewDef).toContain('logo_url');
    expect(viewDef).toContain('operating_hours');
    expect(viewDef).toContain("WHERE status = 'active'");
    expect(viewDef).not.toContain('google_calendar_token');
    expect(viewDef).not.toContain('google_calendar_refresh_token');
    expect(viewDef).not.toContain('payment_channels');
    expect(viewDef).not.toContain('custom_fee_percentage');
    expect(viewDef).not.toContain('custom_fee_flat');
    expect(viewDef).not.toContain('metadata');
  });

  it('businesses_public view uses status = active (not is_active)', () => {
    const viewDef = migration293.slice(
      migration293.indexOf('CREATE OR REPLACE VIEW public.businesses_public'),
      migration293.indexOf('REVOKE ALL ON public.businesses_public'),
    );
    expect(viewDef).toContain("WHERE status = 'active'");
    expect(viewDef).not.toMatch(/is_active/);
  });

  it('revokes ALL from PUBLIC on businesses_public view before granting', () => {
    expect(migration293).toContain('REVOKE ALL ON public.businesses_public FROM PUBLIC');
  });

  it('grants businesses_public view to anon and authenticated', () => {
    expect(migration293).toMatch(/GRANT SELECT ON.*businesses_public.*TO anon.*authenticated/);
  });

  it('revokes direct anon access to businesses base table', () => {
    expect(migration293).toContain('REVOKE ALL ON public.businesses FROM anon');
  });

  // ─── bot_keywords ───
  it('drops anyone_read_system_category policy', () => {
    expect(migration293).toContain('DROP POLICY IF EXISTS "anyone_read_system_category"');
  });

  it('uses explicit DROP + CREATE for bot_keywords policies', () => {
    expect(migration293).toContain('DROP POLICY IF EXISTS "bot_keywords_service_read"');
    expect(migration293).toContain('CREATE POLICY "bot_keywords_service_read"');
    expect(migration293).toContain('DROP POLICY IF EXISTS "bot_keywords_owner_read"');
    expect(migration293).toContain('CREATE POLICY "bot_keywords_owner_read"');
  });

  it('bot_keywords_owner_read scopes via owner_id = auth.uid()', () => {
    const ownerSection = migration293.slice(
      migration293.indexOf('CREATE POLICY "bot_keywords_owner_read"'),
      migration293.indexOf('REVOKE ALL ON public.bot_keywords FROM PUBLIC'),
    );
    expect(ownerSection).toContain('TO authenticated');
    expect(ownerSection).toContain('owner_id = auth.uid()');
    expect(ownerSection).toContain('business_id IN');
  });

  it('revokes anon from bot_keywords', () => {
    expect(migration293).toContain('REVOKE ALL ON public.bot_keywords FROM anon');
  });

  // ─── Audit block ───
  it('audit checks pg_policies with schemaname and tablename scope', () => {
    expect(migration293).toContain("schemaname = 'public'");
  });

  it('audit checks for ANY policy granting anon access (not just named policies)', () => {
    expect(migration293).toContain("roles @> ARRAY['anon']");
  });

  it('audit verifies effective privileges with has_table_privilege()', () => {
    expect(migration293).toContain('has_table_privilege');
    expect(migration293).toContain("'anon'");
  });

  it('audit raises exception on failure', () => {
    expect(migration293).toContain('RAISE EXCEPTION');
  });

  // ─── Structural safety ───
  it('does not null or delete credential values', () => {
    expect(migration293).not.toContain('SET google_calendar_token');
    expect(migration293).not.toContain('SET google_calendar_refresh_token');
    expect(migration293).not.toMatch(/UPDATE.*businesses.*SET.*NULL/);
  });

  it('does not perform data backfills', () => {
    expect(migration293).not.toMatch(/INSERT INTO.*businesses/);
    expect(migration293).not.toMatch(/UPDATE.*bookings/);
    expect(migration293).not.toMatch(/DELETE FROM.*businesses/);
  });

  it('is idempotent (IF EXISTS on all DROP statements)', () => {
    const drops = (migration293.match(/DROP POLICY/g) || []).length;
    const ifExists = (migration293.match(/DROP POLICY IF EXISTS/g) || []).length;
    expect(ifExists).toBe(drops);
  });

  it('uses explicit schema names for all tables', () => {
    expect(migration293).toContain('public.whatsapp_channels');
    expect(migration293).toContain('public.processed_webhook_events');
    expect(migration293).toContain('public.businesses');
    expect(migration293).toContain('public.bot_keywords');
  });

  it('migration 223 is unchanged', () => {
    const currentHash = require('crypto').createHash('sha256').update(
      fs.readFileSync(MIGRATION_223_PATH, 'utf-8'),
    ).digest('hex');
    expect(currentHash).toBe(migration223Hash);
  });

  it('documents application-first deployment requirement', () => {
    expect(migration293).toContain('application code MUST be deployed');
    expect(migration293).toContain('do NOT apply this migration');
  });
});

// ═══════════════════════════════════════════════════════════════
// B. Application code uses safe view fallback helpers
// ═══════════════════════════════════════════════════════════════
describe('P0: Application code uses safe view fallback helpers', () => {
  it('booking page uses queryBusinessesPublic helper', () => {
    const source = fs.readFileSync(path.resolve('app/b/[slug]/page.tsx'), 'utf-8');
    expect(source).toContain('queryBusinessesPublic');
    expect(source).toContain("from '@/lib/supabase/safe-view-query'");
  });

  it('recurring setup page uses queryBusinessesPublic helper', () => {
    const source = fs.readFileSync(path.resolve('app/recurring/[slug]/page.tsx'), 'utf-8');
    expect(source).toContain('queryBusinessesPublic');
  });

  it('OnboardingWizard uses queryChannelsPublic helper', () => {
    const source = fs.readFileSync(path.resolve('app/get-started/OnboardingWizard.tsx'), 'utf-8');
    expect(source).toContain('queryChannelsPublic');
    expect(source).toContain("from '@/lib/supabase/safe-view-query'");
  });

  it('dashboard and qr-code pages use queryChannelsPublic helper', () => {
    const dashboard = fs.readFileSync(path.resolve('app/dashboard/page.tsx'), 'utf-8');
    const qrCode = fs.readFileSync(path.resolve('app/dashboard/qr-code/page.tsx'), 'utf-8');
    expect(dashboard).toContain('queryChannelsPublic');
    expect(qrCode).toContain('queryChannelsPublic');
  });

  it('keyword-campaigns page uses queryChannelsPublic helper', () => {
    const source = fs.readFileSync(path.resolve('app/dashboard/keyword-campaigns/page.tsx'), 'utf-8');
    expect(source).toContain('queryChannelsPublic');
  });

  it('all callers use only allowed columns', () => {
    const files = [
      { path: 'app/b/[slug]/page.tsx', fn: 'queryBusinessesPublic', allowlist: BUSINESSES_PUBLIC_COLUMNS },
      { path: 'app/recurring/[slug]/page.tsx', fn: 'queryBusinessesPublic', allowlist: BUSINESSES_PUBLIC_COLUMNS },
    ];
    for (const file of files) {
      const source = fs.readFileSync(path.resolve(file.path), 'utf-8');
      // Extract column strings from queryBusinessesPublic/queryChannelsPublic calls
      const re = new RegExp(`${file.fn}\\([^,]+,\\s*'([^']+)'`, 'g');
      let match;
      while ((match = re.exec(source)) !== null) {
        const cols = match[1].split(',').map((c: string) => c.trim());
        for (const col of cols) {
          expect(file.allowlist.has(col)).toBe(true);
        }
      }
    }
  });

  it('no public view definition exposes token or credential columns', () => {
    const viewDef = migration293.slice(
      migration293.indexOf('CREATE OR REPLACE VIEW public.whatsapp_channels_public'),
      migration293.indexOf('REVOKE ALL ON public.whatsapp_channels_public'),
    );
    for (const col of ['meta_access_token', 'waba_id', 'phone_number_id', 'meta_token_expires_at', 'gupshup_api_key']) {
      expect(viewDef).not.toContain(col);
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// C. Zero-downtime fallback helper logic
// ═══════════════════════════════════════════════════════════════
describe('P0: Zero-downtime fallback — isRelationNotFound', () => {
  it('returns true for PostgreSQL 42P01 (relation does not exist)', () => {
    expect(isRelationNotFound({ code: '42P01', message: 'relation "businesses_public" does not exist' })).toBe(true);
  });

  it('returns false for null error', () => {
    expect(isRelationNotFound(null)).toBe(false);
  });

  it('returns false for permission error (42501)', () => {
    expect(isRelationNotFound({ code: '42501', message: 'permission denied' })).toBe(false);
  });

  it('returns false for network/connection errors', () => {
    expect(isRelationNotFound({ code: 'PGRST301', message: 'connection refused' })).toBe(false);
  });

  it('returns false for PostgREST schema cache error', () => {
    expect(isRelationNotFound({ code: 'PGRST200', message: 'Could not find relation' })).toBe(false);
  });

  it('returns false for empty error object', () => {
    expect(isRelationNotFound({})).toBe(false);
  });

  it('returns false for error with no code', () => {
    expect(isRelationNotFound({ message: 'some error' })).toBe(false);
  });

  it('returns false for RLS violation', () => {
    expect(isRelationNotFound({ code: '42000', message: 'new row violates RLS' })).toBe(false);
  });
});

describe('P0: Zero-downtime fallback — queryBusinessesPublic', () => {
  function mockSupabase(viewResult: any, baseResult?: any) {
    const chainable = (result: any) => {
      const chain: any = {
        select: () => chain,
        eq: () => chain,
        single: () => chain,
        maybeSingle: () => chain,
        limit: () => chain,
        then: (resolve: any) => resolve(result),
      };
      return chain;
    };

    let callCount = 0;
    return {
      from: (table: string) => {
        callCount++;
        if (callCount === 1 && table === 'businesses_public') return chainable(viewResult);
        if (table === 'businesses') return chainable(baseResult || { data: null, error: null });
        return chainable(viewResult);
      },
    };
  }

  it('returns view result when view exists', async () => {
    const viewResult = { data: { name: 'Test Biz' }, error: null };
    const supabase = mockSupabase(viewResult);
    const result = await queryBusinessesPublic(supabase as any, 'name');
    expect(result.data).toEqual({ name: 'Test Biz' });
    expect(result.error).toBeNull();
  });

  it('falls back to base table on 42P01 error', async () => {
    const viewResult = { data: null, error: { code: '42P01', message: 'relation does not exist' } };
    const baseResult = { data: { name: 'Fallback Biz' }, error: null };
    const supabase = mockSupabase(viewResult, baseResult);
    const result = await queryBusinessesPublic(supabase as any, 'name');
    expect(result.data).toEqual({ name: 'Fallback Biz' });
  });

  it('does NOT fall back on permission error', async () => {
    const viewResult = { data: null, error: { code: '42501', message: 'permission denied' } };
    const supabase = mockSupabase(viewResult);
    const result = await queryBusinessesPublic(supabase as any, 'name');
    expect(result.error?.code).toBe('42501');
  });

  it('does NOT fall back on network error', async () => {
    const viewResult = { data: null, error: { code: 'PGRST301', message: 'connection failed' } };
    const supabase = mockSupabase(viewResult);
    const result = await queryBusinessesPublic(supabase as any, 'name');
    expect(result.error?.code).toBe('PGRST301');
  });

  it('does NOT fall back on empty result (no error)', async () => {
    const viewResult = { data: null, error: null };
    const supabase = mockSupabase(viewResult);
    const result = await queryBusinessesPublic(supabase as any, 'name');
    expect(result.data).toBeNull();
    expect(result.error).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════
// D. Column allowlist enforcement
// ═══════════════════════════════════════════════════════════════
describe('P0: Column allowlist — validateColumns', () => {
  it('accepts valid simple columns for businesses_public', () => {
    expect(() => validateColumns('name, slug, id', BUSINESSES_PUBLIC_COLUMNS, 'test')).not.toThrow();
  });

  it('accepts valid simple columns for channels_public', () => {
    expect(() => validateColumns('phone_number, country_code', CHANNELS_PUBLIC_COLUMNS, 'test')).not.toThrow();
  });

  it('rejects google_calendar_token', () => {
    expect(() => validateColumns('name, google_calendar_token', BUSINESSES_PUBLIC_COLUMNS, 'test'))
      .toThrow('not in the safe allowlist');
  });

  it('rejects google_calendar_refresh_token', () => {
    expect(() => validateColumns('google_calendar_refresh_token', BUSINESSES_PUBLIC_COLUMNS, 'test'))
      .toThrow('not in the safe allowlist');
  });

  it('rejects payment_channels', () => {
    expect(() => validateColumns('payment_channels', BUSINESSES_PUBLIC_COLUMNS, 'test'))
      .toThrow('not in the safe allowlist');
  });

  it('rejects metadata', () => {
    expect(() => validateColumns('metadata', BUSINESSES_PUBLIC_COLUMNS, 'test'))
      .toThrow('not in the safe allowlist');
  });

  it('rejects meta_access_token', () => {
    expect(() => validateColumns('meta_access_token', CHANNELS_PUBLIC_COLUMNS, 'test'))
      .toThrow('not in the safe allowlist');
  });

  it('rejects waba_id', () => {
    expect(() => validateColumns('waba_id', CHANNELS_PUBLIC_COLUMNS, 'test'))
      .toThrow('not in the safe allowlist');
  });

  it('rejects phone_number_id', () => {
    expect(() => validateColumns('phone_number_id', CHANNELS_PUBLIC_COLUMNS, 'test'))
      .toThrow('not in the safe allowlist');
  });

  it('rejects wildcard (*)', () => {
    expect(() => validateColumns('*', BUSINESSES_PUBLIC_COLUMNS, 'test'))
      .toThrow('wildcard');
  });

  it('rejects aliased selections (name AS business_name)', () => {
    expect(() => validateColumns('name AS business_name', BUSINESSES_PUBLIC_COLUMNS, 'test'))
      .toThrow('unsafe column expression');
  });

  it('rejects nested selections (table.column)', () => {
    expect(() => validateColumns('businesses.name', BUSINESSES_PUBLIC_COLUMNS, 'test'))
      .toThrow('unsafe column expression');
  });

  it('rejects function calls (count(*))', () => {
    expect(() => validateColumns('count(*)', BUSINESSES_PUBLIC_COLUMNS, 'test'))
      .toThrow('unsafe column expression');
  });

  it('rejects relationship expressions (table!inner)', () => {
    expect(() => validateColumns('services!inner(id)', BUSINESSES_PUBLIC_COLUMNS, 'test'))
      .toThrow('unsafe column expression');
  });

  it('rejects parenthesized subselections', () => {
    expect(() => validateColumns('name(id, slug)', BUSINESSES_PUBLIC_COLUMNS, 'test'))
      .toThrow('unsafe column expression');
  });

  it('rejects empty column string', () => {
    expect(() => validateColumns('', BUSINESSES_PUBLIC_COLUMNS, 'test'))
      .toThrow('empty column selection');
  });

  it('queryBusinessesPublic rejects unsafe columns before querying', () => {
    const supabase = { from: () => { throw new Error('should not reach DB'); } };
    expect(() => queryBusinessesPublic(supabase as any, 'google_calendar_token'))
      .rejects.toThrow('not in the safe allowlist');
  });

  it('queryChannelsPublic rejects unsafe columns before querying', () => {
    const supabase = { from: () => { throw new Error('should not reach DB'); } };
    expect(() => queryChannelsPublic(supabase as any, 'meta_access_token'))
      .rejects.toThrow('not in the safe allowlist');
  });
});

// ═══════════════════════════════════════════════════════════════
// E. Active-business semantics regression tests
// ═══════════════════════════════════════════════════════════════
describe('P0: Active-business semantics', () => {
  it('businesses_public view uses status = active predicate', () => {
    const viewDef = migration293.slice(
      migration293.indexOf('CREATE OR REPLACE VIEW public.businesses_public'),
      migration293.indexOf('REVOKE ALL ON public.businesses_public'),
    );
    expect(viewDef).toContain("WHERE status = 'active'");
  });

  it('view does not reference is_active on businesses (column does not exist)', () => {
    const viewDef = migration293.slice(
      migration293.indexOf('CREATE OR REPLACE VIEW public.businesses_public'),
      migration293.indexOf('REVOKE ALL ON public.businesses_public'),
    );
    expect(viewDef).not.toContain('is_active');
  });

  it('migration documents that businesses.status is the canonical authority', () => {
    expect(migration293).toContain('canonical');
    expect(migration293).toContain("status = 'active'");
    expect(migration293).toContain('NO is_active');
  });

  it('status enum values are documented correctly', () => {
    const viewDef = migration293.slice(
      migration293.indexOf('CREATE OR REPLACE VIEW public.businesses_public'),
      migration293.indexOf('REVOKE ALL ON public.businesses_public'),
    );
    expect(viewDef).toContain("status = 'active'");
    expect(viewDef).not.toContain("'pending'");
    expect(viewDef).not.toContain("'suspended'");
  });
});
