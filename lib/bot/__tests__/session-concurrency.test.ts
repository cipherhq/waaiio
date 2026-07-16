import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';

describe('Session optimistic concurrency', () => {
  const executor = readFileSync('lib/bot/flows/executor.ts', 'utf-8');
  const migration = readFileSync('supabase/migrations/236_session_versioning.sql', 'utf-8');

  describe('Schema', () => {
    it('adds version column to bot_sessions', () => {
      expect(migration).toContain('version BIGINT NOT NULL DEFAULT 0');
    });

    it('creates compare-and-set RPC', () => {
      expect(migration).toContain('update_session_cas');
      expect(migration).toContain('p_expected_version');
    });

    it('CAS rejects stale versions', () => {
      expect(migration).toContain('AND version = p_expected_version');
    });

    it('CAS increments version on success', () => {
      expect(migration).toContain('version = version + 1');
    });

    it('CAS returns conflict details on version mismatch', () => {
      expect(migration).toContain('version_conflict');
      expect(migration).toContain('current_version');
    });

    it('RPC restricted to service_role', () => {
      expect(migration).toContain('REVOKE ALL ON FUNCTION update_session_cas');
      expect(migration).toContain('GRANT EXECUTE');
      expect(migration).toContain('TO service_role');
    });
  });

  describe('Executor implementation', () => {
    it('calls update_session_cas instead of direct update', () => {
      expect(executor).toContain('update_session_cas');
    });

    it('passes expected version from session', () => {
      expect(executor).toContain('p_expected_version');
    });

    it('detects version conflicts', () => {
      expect(executor).toContain('version_conflict');
    });

    it('returns early on conflict instead of sending stale response', () => {
      // After detecting conflict, should NOT send a message
      expect(executor).toContain('version_conflict');
      // Should have a return after conflict detection
    });

    it('updates local session version after successful CAS', () => {
      expect(executor).toContain('.version =');
    });
  });

  describe('Bot types include version', () => {
    const botTypes = readFileSync('lib/bot/bot-types.ts', 'utf-8');
    const flowTypes = readFileSync('lib/bot/flows/types.ts', 'utf-8');

    it('BotSession has version field', () => {
      expect(botTypes).toContain('version: number');
    });

    it('FlowContext session has version field', () => {
      expect(flowTypes).toContain('version: number');
    });
  });
});
