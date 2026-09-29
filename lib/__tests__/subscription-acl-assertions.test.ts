import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

describe('Migration 410: subscription service_role grants', () => {
  const migrationPath = join(process.cwd(), 'supabase/migrations/410_subscription_service_role_grants.sql');
  const sql = readFileSync(migrationPath, 'utf-8');

  it('grants SELECT, INSERT, UPDATE on subscriptions to service_role', () => {
    expect(sql).toMatch(/GRANT\s+SELECT,\s*INSERT,\s*UPDATE\s+ON\s+public\.subscriptions\s+TO\s+service_role/i);
  });

  it('grants SELECT, INSERT on subscription_payments to service_role', () => {
    expect(sql).toMatch(/GRANT\s+SELECT,\s*INSERT\s+ON\s+public\.subscription_payments\s+TO\s+service_role/i);
  });

  it('does not grant to anon', () => {
    // Only check non-comment lines (lines not starting with --)
    const statements = sql.split('\n').filter(line => !line.trimStart().startsWith('--'));
    const statementsText = statements.join('\n');
    expect(statementsText).not.toMatch(/TO\s+anon/i);
  });

  it('does not grant to authenticated', () => {
    const statements = sql.split('\n').filter(line => !line.trimStart().startsWith('--'));
    const statementsText = statements.join('\n');
    expect(statementsText).not.toMatch(/TO\s+authenticated/i);
  });

  it('does not grant DELETE', () => {
    const statements = sql.split('\n').filter(line => !line.trimStart().startsWith('--'));
    const statementsText = statements.join('\n');
    expect(statementsText).not.toMatch(/\bDELETE\b/i);
  });
});
