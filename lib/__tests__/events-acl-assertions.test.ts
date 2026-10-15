import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

describe('Migration 412: events authenticated grants', () => {
  const sql = readFileSync(join(process.cwd(), 'supabase/migrations/412_events_authenticated_grants.sql'), 'utf-8');
  const statements = sql.split('\n').filter(line => !line.trimStart().startsWith('--'));
  const statementsText = statements.join('\n');

  it('grants SELECT, INSERT, UPDATE, DELETE on events to authenticated', () => {
    expect(sql).toMatch(/GRANT\s+SELECT,\s*INSERT,\s*UPDATE,\s*DELETE\s+ON\s+public\.events\s+TO\s+authenticated/i);
  });

  it('grants SELECT, INSERT, UPDATE, DELETE on event_ticket_types to authenticated', () => {
    expect(sql).toMatch(/GRANT\s+SELECT,\s*INSERT,\s*UPDATE,\s*DELETE\s+ON\s+public\.event_ticket_types\s+TO\s+authenticated/i);
  });

  it('does not grant to anon', () => {
    expect(statementsText).not.toMatch(/TO\s+anon/i);
  });

  it('does not grant TRUNCATE', () => {
    expect(statementsText).not.toMatch(/\bTRUNCATE\b/i);
  });

  it('does not grant TRIGGER', () => {
    expect(statementsText).not.toMatch(/\bTRIGGER\b/i);
  });

  it('does not grant REFERENCES', () => {
    expect(statementsText).not.toMatch(/\bREFERENCES\b/i);
  });
});
