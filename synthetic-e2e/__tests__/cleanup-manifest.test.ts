/**
 * Tests for the cleanup manifest tracker.
 *
 * Issue #728 safety gate 4: Verify that cleanup is targeted,
 * ordered, idempotent, and only deletes manifest-owned IDs.
 */

import { describe, it, expect } from 'vitest';
import { CleanupTracker } from '../lib/cleanup-manifest';
import { executeCleanup, verifyZeroSyntheticRows } from '../lib/cleanup-executor';
import { STAGING_SUPABASE_REF } from '../lib/environment-guard';

describe('CleanupTracker', () => {
  it('tracks entities for cleanup', () => {
    const tracker = new CleanupTracker('run-123');

    tracker.track({
      table: 'businesses',
      id: 'biz-1',
      pkColumn: 'id',
      meta: { name: 'SynthBiz 1' },
    });

    const manifest = tracker.getManifest();
    expect(manifest.entries).toHaveLength(1);
    expect(manifest.entries[0].table).toBe('businesses');
    expect(manifest.entries[0].id).toBe('biz-1');
  });

  it('tracks dependent entities', () => {
    const tracker = new CleanupTracker('run-123');

    tracker.track({
      table: 'businesses',
      id: 'biz-1',
      pkColumn: 'id',
      meta: {},
    });

    tracker.trackDependent('businesses', 'biz-1', {
      table: 'bot_sessions',
      id: 'session-1',
    });

    const manifest = tracker.getManifest();
    expect(manifest.entries[0].dependents).toHaveLength(1);
    expect(manifest.entries[0].dependents[0].table).toBe('bot_sessions');
  });

  it('generates correct deletion order (dependents first)', () => {
    const tracker = new CleanupTracker('run-123');

    tracker.track({ table: 'businesses', id: 'biz-1', pkColumn: 'id', meta: {} });
    tracker.track({ table: 'profiles', id: 'prof-1', pkColumn: 'id', meta: {} });

    tracker.trackDependent('businesses', 'biz-1', { table: 'bot_sessions', id: 'sess-1' });
    tracker.trackDependent('businesses', 'biz-1', { table: 'products', id: 'prod-1' });

    const order = tracker.getDeletionOrder();

    // Dependents of last-created parent come first (reverse creation order)
    // Then the parents themselves
    const tables = order.map(o => `${o.table}:${o.id}`);

    // profiles was created second, so it appears before businesses in reverse order
    // But profiles has no dependents, so it's just itself
    expect(tables).toContain('bot_sessions:sess-1');
    expect(tables).toContain('products:prod-1');
    expect(tables).toContain('businesses:biz-1');
    expect(tables).toContain('profiles:prof-1');

    // Dependents must come before their parent
    const sessIdx = tables.indexOf('bot_sessions:sess-1');
    const bizIdx = tables.indexOf('businesses:biz-1');
    expect(sessIdx).toBeLessThan(bizIdx);
  });

  it('deduplicates entities in deletion order', () => {
    const tracker = new CleanupTracker('run-123');

    // Same entity tracked as both independent and dependent
    tracker.track({ table: 'sessions', id: 'sess-1', pkColumn: 'id', meta: {} });
    tracker.trackDependent('businesses', 'biz-1', { table: 'sessions', id: 'sess-1' });

    const order = tracker.getDeletionOrder();
    const sessEntries = order.filter(o => o.table === 'sessions' && o.id === 'sess-1');
    expect(sessEntries).toHaveLength(1);
  });

  it('generates dry-run preview', () => {
    const tracker = new CleanupTracker('run-123');
    tracker.track({ table: 'businesses', id: 'biz-1', pkColumn: 'id', meta: {} });
    tracker.track({ table: 'profiles', id: 'prof-1', pkColumn: 'id', meta: {} });

    const preview = tracker.previewCleanup();
    expect(preview.mode).toBe('dry-run');
    expect(preview.planned).toBe(2);
    expect(preview.deleted).toBe(0);
  });

  it('serializes and deserializes', () => {
    const tracker = new CleanupTracker('run-123');
    tracker.track({ table: 'businesses', id: 'biz-1', pkColumn: 'id', meta: { name: 'test' } });
    tracker.trackDependent('businesses', 'biz-1', { table: 'sessions', id: 'sess-1' });

    const json = tracker.toJSON();
    const restored = CleanupTracker.fromJSON(json);

    expect(restored.getManifest().runId).toBe('run-123');
    expect(restored.getManifest().entries).toHaveLength(1);
    expect(restored.getManifest().entries[0].dependents).toHaveLength(1);
    expect(restored.getDeletionOrder()).toHaveLength(2);
  });
});

describe('executeCleanup safety gates', () => {
  it('dry-run succeeds without DB access', async () => {
    const tracker = new CleanupTracker('run-dry');
    tracker.track({ table: 'businesses', id: 'biz-1', pkColumn: 'id', meta: {} });

    const result = await executeCleanup(
      {} as any, // No DB client needed for dry-run
      tracker,
      { dryRun: true, supabaseRef: STAGING_SUPABASE_REF },
    );

    expect(result.mode).toBe('dry-run');
    expect(result.planned).toBe(1);
    expect(result.deleted).toBe(0);
  });

  it('THROWS when dryRun=false (execution unsupported)', async () => {
    const tracker = new CleanupTracker('run-exec');
    tracker.track({ table: 'businesses', id: 'biz-1', pkColumn: 'id', meta: {} });

    await expect(executeCleanup(
      {} as any,
      tracker,
      { dryRun: false, supabaseRef: STAGING_SUPABASE_REF },
    )).rejects.toThrow('FAIL-CLOSED: executeCleanup with dryRun=false is intentionally unsupported');
  });

  it('dry-run rejects tables not in allowlist', async () => {
    const tracker = new CleanupTracker('run-bad');
    tracker.track({ table: 'dangerous_table', id: 'x', pkColumn: 'id', meta: {} });

    const result = await executeCleanup(
      {} as any,
      tracker,
      { dryRun: true, supabaseRef: STAGING_SUPABASE_REF },
    );

    expect(result.failed.length).toBe(1);
    expect(result.failed[0].error).toContain('not in cleanup allowlist');
  });
});

describe('verifyZeroSyntheticRows safety', () => {
  it('rejects empty or short run IDs', async () => {
    await expect(verifyZeroSyntheticRows({} as any, '')).rejects.toThrow('FAIL-CLOSED');
    await expect(verifyZeroSyntheticRows({} as any, 'short')).rejects.toThrow('FAIL-CLOSED');
  });
});
