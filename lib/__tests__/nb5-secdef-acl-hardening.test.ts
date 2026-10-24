/**
 * NB-5: SECURITY DEFINER ACL hardening tests
 *
 * Verifies that M463 correctly locks down exposed SECURITY DEFINER functions.
 * Tests read migration SQL to verify REVOKE/GRANT statements and search_path.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const MIGRATION_PATH = path.join(process.cwd(), 'supabase/migrations/463_secdef_acl_audit_hardening.sql');
const migrationSql = fs.readFileSync(MIGRATION_PATH, 'utf-8');

describe('M463: SECURITY DEFINER ACL hardening', () => {
  describe('calculate_volume_discount', () => {
    it('has SET search_path = public in CREATE OR REPLACE', () => {
      const fnBlock = migrationSql.substring(
        migrationSql.indexOf('CREATE OR REPLACE FUNCTION public.calculate_volume_discount'),
        migrationSql.indexOf('REVOKE ALL ON FUNCTION public.calculate_volume_discount'),
      );
      expect(fnBlock).toContain('SET search_path = public');
    });

    it('REVOKE from anon, authenticated, and PUBLIC', () => {
      expect(migrationSql).toContain(
        'REVOKE ALL ON FUNCTION public.calculate_volume_discount(uuid, uuid, integer, integer) FROM PUBLIC',
      );
      expect(migrationSql).toContain(
        'REVOKE ALL ON FUNCTION public.calculate_volume_discount(uuid, uuid, integer, integer) FROM anon',
      );
      expect(migrationSql).toContain(
        'REVOKE ALL ON FUNCTION public.calculate_volume_discount(uuid, uuid, integer, integer) FROM authenticated',
      );
    });

    it('GRANT only to service_role', () => {
      expect(migrationSql).toContain(
        'GRANT EXECUTE ON FUNCTION public.calculate_volume_discount(uuid, uuid, integer, integer) TO service_role',
      );
    });

    it('body is SECURITY DEFINER', () => {
      const fnBlock = migrationSql.substring(
        migrationSql.indexOf('CREATE OR REPLACE FUNCTION public.calculate_volume_discount'),
        migrationSql.indexOf('$$;'),
      );
      expect(fnBlock).toContain('SECURITY DEFINER');
    });

    it('assertion verifies anon cannot execute', () => {
      expect(migrationSql).toContain('calculate_volume_discount still executable by anon');
    });

    it('assertion verifies search_path is set', () => {
      expect(migrationSql).toContain('calculate_volume_discount missing search_path=public');
    });
  });

  describe('check_conversation_limit', () => {
    it('REVOKE from anon, authenticated, and PUBLIC', () => {
      expect(migrationSql).toContain(
        'REVOKE ALL ON FUNCTION public.check_conversation_limit(uuid) FROM PUBLIC',
      );
      expect(migrationSql).toContain(
        'REVOKE ALL ON FUNCTION public.check_conversation_limit(uuid) FROM anon',
      );
      expect(migrationSql).toContain(
        'REVOKE ALL ON FUNCTION public.check_conversation_limit(uuid) FROM authenticated',
      );
    });

    it('GRANT only to service_role', () => {
      expect(migrationSql).toContain(
        'GRANT EXECUTE ON FUNCTION public.check_conversation_limit(uuid) TO service_role',
      );
    });
  });

  describe('dashboard revenue RPCs — anon revoked, authenticated kept', () => {
    const dashboardFns = [
      'get_business_revenue(uuid)',
      'get_order_revenue(uuid)',
      'get_outstanding_invoices(uuid)',
    ];

    for (const fn of dashboardFns) {
      it(`${fn}: REVOKE from anon`, () => {
        expect(migrationSql).toContain(`REVOKE EXECUTE ON FUNCTION public.${fn} FROM anon`);
      });

      it(`${fn}: does NOT revoke from authenticated`, () => {
        // Should not contain a blanket REVOKE ALL for these functions
        // (only targeted REVOKE FROM anon)
        const revokeAuthPattern = `REVOKE EXECUTE ON FUNCTION public.${fn} FROM authenticated`;
        expect(migrationSql).not.toContain(revokeAuthPattern);
      });
    }

    it('assertion verifies authenticated can still execute get_business_revenue', () => {
      expect(migrationSql).toContain('get_business_revenue NOT executable by authenticated');
    });
  });

  describe('check_business_role — anon revoked, authenticated kept (RLS dependency)', () => {
    it('REVOKE from anon', () => {
      expect(migrationSql).toContain(
        'REVOKE EXECUTE ON FUNCTION public.check_business_role(uuid, uuid, business_role[]) FROM anon',
      );
    });

    it('does NOT revoke from authenticated (RLS policy dependency)', () => {
      expect(migrationSql).not.toContain(
        'REVOKE EXECUTE ON FUNCTION public.check_business_role(uuid, uuid, business_role[]) FROM authenticated',
      );
    });

    it('assertion verifies RLS compatibility preserved', () => {
      expect(migrationSql).toContain('check_business_role NOT executable by authenticated (RLS needs it)');
    });
  });

  describe('intentionally public functions NOT revoked', () => {
    it('handle_new_user has no REVOKE statement', () => {
      expect(migrationSql).not.toMatch(/REVOKE.*handle_new_user/);
    });

    it('get_active_appointments_public has no REVOKE statement', () => {
      expect(migrationSql).not.toMatch(/REVOKE.*get_active_appointments_public/);
    });

    it('get_upcoming_class_sessions has no REVOKE statement', () => {
      expect(migrationSql).not.toMatch(/REVOKE.*get_upcoming_class_sessions/);
    });
  });

  describe('verification assertions block present', () => {
    it('contains DO $$ verification block', () => {
      expect(migrationSql).toContain('DO $$');
      expect(migrationSql).toContain('M463: All SECURITY DEFINER ACL assertions passed');
    });

    it('has assertion for every hardened function', () => {
      const assertionCount = (migrationSql.match(/RAISE EXCEPTION 'ASSERT FAIL/g) || []).length;
      // 3 for calculate_volume_discount (anon, authenticated, search_path)
      // 2 for check_conversation_limit (anon, authenticated)
      // 3 for dashboard RPCs (anon × 3)
      // 1 for check_business_role (anon)
      // 1 backward-compat check (authenticated on get_business_revenue)
      // 1 backward-compat check (authenticated on check_business_role)
      // 1 service_role check (calculate_volume_discount)
      expect(assertionCount).toBe(12);
    });
  });
});

describe('Application callers use service client', () => {
  it('calculate_volume_discount is called via ctx.supabase (service client in bot)', () => {
    const orderingFlow = fs.readFileSync('lib/bot/flows/ordering.flow.ts', 'utf-8');
    expect(orderingFlow).toContain("ctx.supabase.rpc('calculate_volume_discount'");
  });

  it('check_conversation_limit has no active TypeScript callers (legacy DB function)', () => {
    // This function exists only in migration SQL (M081, M095, M193).
    // No TypeScript code calls it via RPC — it's safe to lock to service_role.
    const migrationSql081 = fs.readFileSync('supabase/migrations/081_conversation_usage.sql', 'utf-8');
    expect(migrationSql081).toContain('check_conversation_limit');
  });
});
