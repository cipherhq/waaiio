import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * Contract tests for attendance_log RLS policies and input validation.
 * Since we cannot spin up a real Supabase instance in CI, these verify:
 * 1. The API route enforces the same validation rules the DB constraints enforce.
 * 2. Migration SQL contains the expected RLS policies and CHECK constraints.
 */

const MIGRATIONS_DIR = path.resolve(__dirname, '../../supabase/migrations');

// Read relevant migrations once
const migration229 = fs.readFileSync(path.join(MIGRATIONS_DIR, '229_attendance_log.sql'), 'utf-8');
const migration230 = fs.readFileSync(path.join(MIGRATIONS_DIR, '230_attendance_rls_hardening.sql'), 'utf-8');

describe('Attendance check-in API — input validation contract', () => {
  describe('schema constraints (migration 229 + 230)', () => {
    it('attendance_log table has RLS enabled', () => {
      expect(migration229).toContain('ENABLE ROW LEVEL SECURITY');
    });

    it('owners can only SELECT their own attendance records', () => {
      expect(migration229).toContain('owners_read');
      expect(migration229).toMatch(/FOR SELECT/);
      expect(migration229).toContain('owner_id = auth.uid()');
    });

    it('unsafe service_insert policy was removed', () => {
      // Migration 229 created a permissive WITH CHECK (true) — migration 230 drops it
      expect(migration229).toContain('service_insert');
      expect(migration230).toContain('DROP POLICY IF EXISTS "service_insert"');
    });

    it('admin/operations roles have read access', () => {
      expect(migration230).toContain('admin_ops_read');
      expect(migration230).toContain("'admin', 'operations'");
    });

    it('no INSERT policy exists for anon/authenticated roles after hardening', () => {
      // After dropping service_insert, only service role (which bypasses RLS) can insert
      // The API route uses createServiceClient() for inserts
      expect(migration230).toContain('DROP POLICY IF EXISTS "service_insert"');
      // And no new INSERT policy is created in 230
      expect(migration230).not.toMatch(/FOR INSERT/);
    });
  });

  describe('CHECK constraints (migration 230)', () => {
    it('customer_name limited to 200 characters', () => {
      expect(migration230).toContain('chk_attendance_name_length');
      expect(migration230).toContain("length(customer_name) <= 200");
    });

    it('customer_phone limited to 30 characters', () => {
      expect(migration230).toContain('chk_attendance_phone_length');
      expect(migration230).toContain("length(customer_phone) <= 30");
    });

    it('customer_email limited to 320 characters', () => {
      expect(migration230).toContain('chk_attendance_email_length');
      expect(migration230).toContain("length(customer_email) <= 320");
    });

    it('notes limited to 2000 characters', () => {
      expect(migration230).toContain('chk_attendance_notes_length');
      expect(migration230).toContain("length(notes) <= 2000");
    });

    it('source constrained to web, whatsapp, manual', () => {
      expect(migration230).toContain('chk_attendance_source');
      expect(migration230).toContain("source IN ('web', 'whatsapp', 'manual')");
    });
  });

  describe('API route validation mirrors DB constraints', () => {
    // These tests read the API route source to verify it enforces the same limits
    // the DB CHECK constraints enforce — defense in depth.
    const routeSource = fs.readFileSync(
      path.resolve(__dirname, '../../app/api/checkin/route.ts'),
      'utf-8',
    );

    it('rejects missing business_id and customer_name', () => {
      expect(routeSource).toContain("!business_id || !trimmedName");
      expect(routeSource).toContain("business_id and customer_name are required");
    });

    it('rejects name over 200 characters', () => {
      expect(routeSource).toContain('trimmedName.length > 200');
    });

    it('rejects phone under 7 or over 20 digits', () => {
      expect(routeSource).toContain('cleanPhone.length < 7');
      expect(routeSource).toContain('cleanPhone.length > 20');
    });

    it('rejects invalid email (missing @)', () => {
      expect(routeSource).toContain("!trimmedEmail.includes('@')");
    });

    it('rejects notes over 2000 characters', () => {
      expect(routeSource).toContain('trimmedNotes.length > 2000');
    });

    it('uses service client for inserts (bypasses RLS)', () => {
      expect(routeSource).toContain('createServiceClient');
    });

    it('verifies business is active before inserting', () => {
      expect(routeSource).toContain(".eq('is_active', true)");
    });
  });

  describe('source validation', () => {
    it('valid sources match the CHECK constraint', () => {
      const validSources = ['web', 'whatsapp', 'manual'];
      // Verify the constraint text includes all valid sources
      for (const src of validSources) {
        expect(migration230).toContain(`'${src}'`);
      }
    });

    it('API default source is "web"', () => {
      const routeSource = fs.readFileSync(
        path.resolve(__dirname, '../../app/api/checkin/route.ts'),
        'utf-8',
      );
      expect(routeSource).toContain("source: 'web'");
    });
  });
});
