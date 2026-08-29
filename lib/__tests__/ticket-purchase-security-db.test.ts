/**
 * Ticket Purchase Security — Real PostgreSQL Tests
 *
 * Proves the ticket purchase trust boundary:
 * - purchase_tickets_atomic is service_role only
 * - Cross-event ticket type validation exists in the API route
 * - finalize_free_ticket_booking is service_role only
 *
 * Requires TEST_DATABASE_URL pointing to a PostgreSQL database with
 * all migrations applied.
 */
import { describe, it, expect } from 'vitest';
import { execSync } from 'child_process';
import { readFileSync } from 'fs';

const dbUrl = process.env.TEST_DATABASE_URL;

// ═══════════════════════════════════════════════════════════
// 1. Structural: API route cross-event ticket type check
// ═══════════════════════════════════════════════════════════

describe('Ticket purchase API — structural security checks', () => {
  it('events/purchase/route.ts validates ticket type belongs to event', () => {
    const code = readFileSync('app/api/events/purchase/route.ts', 'utf-8');
    expect(code).toContain('tt.event_id !== event.id');
  });

  it('events/purchase/route.ts reads price from DB, not request body', () => {
    const code = readFileSync('app/api/events/purchase/route.ts', 'utf-8');
    // The route must read unitPrice from DB (event.price or tt.price)
    expect(code).toContain('unitPrice');
    // And must NOT accept a price from the request body
    const bodyDestructure = code.match(/const\s*\{[^}]*\}\s*=\s*(?:await\s+)?(?:body|request\.json)/g);
    if (bodyDestructure) {
      for (const match of bodyDestructure) {
        expect(match).not.toContain('price');
      }
    }
  });

  it('events/purchase/route.ts computes total server-side', () => {
    const code = readFileSync('app/api/events/purchase/route.ts', 'utf-8');
    expect(code).toMatch(/totalAmount\s*=\s*unitPrice\s*\*\s*quantity/);
  });
});

// ═══════════════════════════════════════════════════════════
// 2. Database: ACL enforcement
// ═══════════════════════════════════════════════════════════

if (!dbUrl) {
  describe.skip('Ticket purchase DB security — TEST_DATABASE_URL not set', () => {
    it('skipped', () => {});
  });
} else {

function runSQL(sql: string, role?: string): { stdout: string; stderr: string; exitCode: number } {
  const fullSql = role ? `SET ROLE ${role};\n${sql}` : sql;
  try {
    let stdout = execSync(
      `psql "${dbUrl}" -t -A -v ON_ERROR_STOP=1`,
      { input: fullSql, encoding: 'utf-8', timeout: 15000 },
    );
    stdout = stdout.trim();
    if (role && stdout.startsWith('SET\n')) stdout = stdout.slice(4).trim();
    else if (role && stdout === 'SET') stdout = '';
    return { stdout, stderr: '', exitCode: 0 };
  } catch (err: any) {
    return { stdout: err.stdout?.trim() || '', stderr: err.stderr?.trim() || '', exitCode: err.status || 1 };
  }
}

describe('Ticket purchase DB security', () => {

  // purchase_tickets_atomic ACL
  it('purchase_tickets_atomic: anon denied', () => {
    const r = runSQL("SELECT has_function_privilege('anon', 'purchase_tickets_atomic(uuid, uuid, uuid, integer, uuid, text, text, text, integer, text)', 'EXECUTE') AS p;");
    expect(r.stdout).toBe('f');
  });

  it('purchase_tickets_atomic: authenticated denied', () => {
    const r = runSQL("SELECT has_function_privilege('authenticated', 'purchase_tickets_atomic(uuid, uuid, uuid, integer, uuid, text, text, text, integer, text)', 'EXECUTE') AS p;");
    expect(r.stdout).toBe('f');
  });

  it('purchase_tickets_atomic: service_role allowed', () => {
    const r = runSQL("SELECT has_function_privilege('service_role', 'purchase_tickets_atomic(uuid, uuid, uuid, integer, uuid, text, text, text, integer, text)', 'EXECUTE') AS p;");
    expect(r.stdout).toBe('t');
  });

  it('runtime: anon cannot call purchase_tickets_atomic', () => {
    const r = runSQL(
      "SELECT purchase_tickets_atomic('00000000-0000-0000-0000-000000000000'::uuid, '00000000-0000-0000-0000-000000000000'::uuid, '00000000-0000-0000-0000-000000000000'::uuid, 1, '00000000-0000-0000-0000-000000000000'::uuid, 'test', 'test@test.com', '1234567890', 100, 'NGN');",
      'anon'
    );
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain('permission denied');
  });

  it('runtime: authenticated cannot call purchase_tickets_atomic', () => {
    const r = runSQL(
      "SELECT purchase_tickets_atomic('00000000-0000-0000-0000-000000000000'::uuid, '00000000-0000-0000-0000-000000000000'::uuid, '00000000-0000-0000-0000-000000000000'::uuid, 1, '00000000-0000-0000-0000-000000000000'::uuid, 'test', 'test@test.com', '1234567890', 100, 'NGN');",
      'authenticated'
    );
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain('permission denied');
  });

  // finalize_free_ticket_booking ACL (hardened by migration 304)
  it('finalize_free_ticket_booking: anon denied', () => {
    const r = runSQL("SELECT has_function_privilege('anon', 'finalize_free_ticket_booking(uuid, uuid, uuid, integer)', 'EXECUTE') AS p;");
    expect(r.stdout).toBe('f');
  });

  it('finalize_free_ticket_booking: authenticated denied', () => {
    const r = runSQL("SELECT has_function_privilege('authenticated', 'finalize_free_ticket_booking(uuid, uuid, uuid, integer)', 'EXECUTE') AS p;");
    expect(r.stdout).toBe('f');
  });

  it('finalize_free_ticket_booking: service_role allowed', () => {
    const r = runSQL("SELECT has_function_privilege('service_role', 'finalize_free_ticket_booking(uuid, uuid, uuid, integer)', 'EXECUTE') AS p;");
    expect(r.stdout).toBe('t');
  });

  // purchase_tickets_atomic uses FOR UPDATE (structural proof from function source)
  it('purchase_tickets_atomic uses FOR UPDATE row locking', () => {
    const r = runSQL(`
      SELECT prosrc FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'purchase_tickets_atomic';
    `);
    expect(r.stdout.toLowerCase()).toContain('for update');
  });
});

} // end if (dbUrl)
