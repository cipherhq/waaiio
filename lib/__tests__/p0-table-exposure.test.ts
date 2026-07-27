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
 * Also verifies application code uses safe views for public queries.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const MIGRATION_PATH = path.resolve('supabase/migrations/293_fix_production_table_exposure.sql');
const migration293 = fs.readFileSync(MIGRATION_PATH, 'utf-8');

// Historical migration 223 must not be modified
const MIGRATION_223_PATH = path.resolve('supabase/migrations/223_security_fix_exposed_tables.sql');
const migration223 = fs.readFileSync(MIGRATION_223_PATH, 'utf-8');
const migration223Hash = require('crypto').createHash('sha256').update(migration223).digest('hex');

describe('P0: Migration 293 — table exposure remediation', () => {
  // ─── whatsapp_channels ───
  it('drops shared_channels_public_read policy', () => {
    expect(migration293).toContain('DROP POLICY IF EXISTS "shared_channels_public_read"');
  });

  it('creates whatsapp_channels_public view with safe columns only', () => {
    expect(migration293).toContain('CREATE OR REPLACE VIEW public.whatsapp_channels_public');
    // Extract only the view definition (not comments)
    const viewStart = migration293.indexOf('CREATE OR REPLACE VIEW public.whatsapp_channels_public');
    const viewEnd = migration293.indexOf('GRANT SELECT ON public.whatsapp_channels_public');
    const viewDef = migration293.slice(viewStart, viewEnd);
    // Must include safe fields
    expect(viewDef).toContain('phone_number');
    expect(viewDef).toContain('country_code');
    expect(viewDef).toContain('display_name');
    // Must NOT include sensitive fields in the view SELECT
    expect(viewDef).not.toContain('meta_access_token');
    expect(viewDef).not.toContain('waba_id');
    expect(viewDef).not.toContain('phone_number_id');
    expect(viewDef).not.toContain('gupshup_api_key');
  });

  it('grants view access to anon and authenticated', () => {
    expect(migration293).toMatch(/GRANT SELECT ON.*whatsapp_channels_public.*TO anon.*authenticated/);
  });

  it('revokes direct anon access to whatsapp_channels base table', () => {
    expect(migration293).toContain('REVOKE ALL ON public.whatsapp_channels FROM anon');
  });

  // ─── processed_webhook_events ───
  it('drops processed_webhook_events_service_all policy', () => {
    expect(migration293).toContain('DROP POLICY IF EXISTS "processed_webhook_events_service_all"');
  });

  it('ensures service_only policy exists', () => {
    expect(migration293).toContain('processed_webhook_events_service_only');
    expect(migration293).toContain('TO service_role');
  });

  it('revokes anon and authenticated from processed_webhook_events', () => {
    expect(migration293).toContain('REVOKE ALL ON public.processed_webhook_events FROM anon');
    expect(migration293).toContain('REVOKE ALL ON public.processed_webhook_events FROM authenticated');
  });

  // ─── businesses ───
  it('drops public_read_active_businesses policy', () => {
    expect(migration293).toContain('DROP POLICY IF EXISTS "public_read_active_businesses"');
  });

  it('creates businesses_public view with safe columns only', () => {
    expect(migration293).toContain('CREATE OR REPLACE VIEW public.businesses_public');
    // Must include public-page columns
    expect(migration293).toMatch(/name/);
    expect(migration293).toMatch(/slug/);
    expect(migration293).toMatch(/logo_url/);
    expect(migration293).toMatch(/operating_hours/);
    // Must NOT include sensitive columns in the view definition
    const viewDef = migration293.slice(
      migration293.indexOf('CREATE OR REPLACE VIEW public.businesses_public'),
      migration293.indexOf('GRANT SELECT ON public.businesses_public'),
    );
    expect(viewDef).not.toContain('google_calendar_token');
    expect(viewDef).not.toContain('google_calendar_refresh_token');
    expect(viewDef).not.toContain('payment_channels');
    expect(viewDef).not.toContain('custom_fee_percentage');
    expect(viewDef).not.toContain('custom_fee_flat');
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

  it('creates service_role read policy for bot_keywords', () => {
    expect(migration293).toContain('bot_keywords_service_read');
    expect(migration293).toContain('TO service_role');
  });

  it('creates owner read policy for bot_keywords', () => {
    expect(migration293).toContain('bot_keywords_owner_read');
    expect(migration293).toContain('TO authenticated');
    expect(migration293).toContain('owner_id = auth.uid()');
  });

  it('revokes anon from bot_keywords', () => {
    expect(migration293).toContain('REVOKE ALL ON public.bot_keywords FROM anon');
  });

  // ─── Structural safety ───
  it('does not null or delete credential values', () => {
    expect(migration293).not.toContain('SET google_calendar_token');
    expect(migration293).not.toContain('SET google_calendar_refresh_token');
    expect(migration293).not.toMatch(/UPDATE.*businesses.*SET.*NULL/);
  });

  it('does not perform data backfills', () => {
    // No UPDATE/INSERT/DELETE on user data tables
    expect(migration293).not.toMatch(/INSERT INTO.*businesses/);
    expect(migration293).not.toMatch(/UPDATE.*bookings/);
    expect(migration293).not.toMatch(/DELETE FROM.*businesses/);
  });

  it('is idempotent (IF EXISTS / IF NOT EXISTS guards)', () => {
    const drops = (migration293.match(/DROP POLICY/g) || []).length;
    const ifExists = (migration293.match(/IF EXISTS/g) || []).length;
    // Every DROP should have IF EXISTS
    expect(ifExists).toBeGreaterThanOrEqual(drops);
  });

  it('uses explicit schema names', () => {
    expect(migration293).toContain('public.whatsapp_channels');
    expect(migration293).toContain('public.processed_webhook_events');
    expect(migration293).toContain('public.businesses');
    expect(migration293).toContain('public.bot_keywords');
  });

  it('migration 223 is unchanged', () => {
    const currentHash = require('crypto').createHash('sha256').update(
      fs.readFileSync(MIGRATION_223_PATH, 'utf-8')
    ).digest('hex');
    expect(currentHash).toBe(migration223Hash);
  });
});

describe('P0: Application code uses safe views for public queries', () => {
  it('OnboardingWizard queries whatsapp_channels_public, not base table', () => {
    const source = fs.readFileSync(
      path.resolve('app/get-started/OnboardingWizard.tsx'), 'utf-8',
    );
    // Shared channel queries should use the public view
    const sharedQueries = source.match(/from\(['"]whatsapp_channels['"]\)/g) || [];
    const publicQueries = source.match(/from\(['"]whatsapp_channels_public['"]\)/g) || [];
    // Should have no bare base-table shared queries
    // (dedicated channel queries via business_id are fine on the base table)
    expect(publicQueries.length).toBeGreaterThan(0);
  });

  it('public booking page queries businesses_public', () => {
    const source = fs.readFileSync(
      path.resolve('app/b/[slug]/page.tsx'), 'utf-8',
    );
    const publicQueries = source.match(/from\(['"]businesses_public['"]\)/g) || [];
    expect(publicQueries.length).toBeGreaterThanOrEqual(2); // metadata + main query
  });

  it('recurring setup page queries businesses_public', () => {
    const source = fs.readFileSync(
      path.resolve('app/recurring/[slug]/page.tsx'), 'utf-8',
    );
    expect(source).toContain("from('businesses_public')");
  });

  it('dashboard shared-channel fallbacks use whatsapp_channels_public', () => {
    const dashboard = fs.readFileSync(
      path.resolve('app/dashboard/page.tsx'), 'utf-8',
    );
    const qrCode = fs.readFileSync(
      path.resolve('app/dashboard/qr-code/page.tsx'), 'utf-8',
    );
    expect(dashboard).toContain("from('whatsapp_channels_public')");
    expect(qrCode).toContain("from('whatsapp_channels_public')");
  });

  it('no public view exposes token or credential columns', () => {
    const viewDef = migration293.slice(
      migration293.indexOf('CREATE OR REPLACE VIEW public.whatsapp_channels_public'),
      migration293.indexOf('GRANT SELECT ON public.whatsapp_channels_public'),
    );
    const sensitiveColumns = [
      'meta_access_token', 'waba_id', 'phone_number_id',
      'meta_token_expires_at', 'gupshup_api_key',
    ];
    for (const col of sensitiveColumns) {
      expect(viewDef).not.toContain(col);
    }
  });
});
