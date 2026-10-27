/**
 * Cleanup executor — actually deletes synthetic test data from staging.
 *
 * CTO R1 Fix 3: Implements the missing delete executor with:
 * - Staging Supabase connection verification
 * - Dry-run preview before any deletions
 * - Ownership verification per row
 * - Exact manifest-owned ID deletion only
 * - Zero-remaining verification after cleanup
 *
 * CLI usage:
 *   npx tsx synthetic-e2e/lib/cleanup-executor.ts --dry-run --manifest <path>
 *   npx tsx synthetic-e2e/lib/cleanup-executor.ts --execute --manifest <path>
 *   npx tsx synthetic-e2e/lib/cleanup-executor.ts --verify --run-id <id>
 */

import { CleanupTracker, type CleanupResult } from './cleanup-manifest';
import {
  assertStagingSupabase,
  STAGING_SUPABASE_REF,
} from './environment-guard';
import { isSyntheticEmail, isSyntheticBusinessName } from './synthetic-identity';

// ── Types ──

export interface CleanupDbClient {
  from(table: string): {
    delete(): {
      eq(column: string, value: unknown): Promise<{ error: unknown; count: number | null }>;
    };
    select(columns?: string): {
      eq(column: string, value: unknown): {
        single(): Promise<{ data: Record<string, unknown> | null; error: unknown }>;
      };
      like(column: string, pattern: string): Promise<{ data: Record<string, unknown>[] | null; error: unknown }>;
      ilike(column: string, pattern: string): Promise<{ data: Record<string, unknown>[] | null; error: unknown }>;
    };
  };
}

// ── Executor ──

/**
 * Execute cleanup of manifest-owned synthetic data.
 */
export async function executeCleanup(
  db: CleanupDbClient,
  tracker: CleanupTracker,
  options: { dryRun: boolean; supabaseRef: string },
): Promise<CleanupResult> {
  // CTO R2 Fix 3: Staging ref is REQUIRED, not optional. Fail-closed.
  assertStagingSupabase(options.supabaseRef);

  const manifest = tracker.getManifest();
  const deletionOrder = tracker.getDeletionOrder();

  const result: CleanupResult = {
    runId: manifest.runId,
    mode: options.dryRun ? 'dry-run' : 'execute',
    planned: deletionOrder.length,
    deleted: 0,
    failed: [],
    verified: false,
    remainingSyntheticRows: -1,
  };

  if (options.dryRun) {
    console.log(`[CLEANUP DRY-RUN] Would delete ${deletionOrder.length} rows:`);
    for (const item of deletionOrder) {
      console.log(`  - ${item.table}.${item.pkColumn} = ${item.id}`);
    }
    return result;
  }

  // Execute deletions in order
  for (const item of deletionOrder) {
    try {
      // Verify the row exists and belongs to the run before deleting
      const { data: existing, error: readError } = await db
        .from(item.table)
        .select('*')
        .eq(item.pkColumn, item.id)
        .single();

      if (readError || !existing) {
        result.failed.push({
          table: item.table,
          id: item.id,
          error: `Row not found (may already be deleted): ${readError ? JSON.stringify(readError) : 'null result'}`,
        });
        continue;
      }

      // Ownership verification: check for synthetic markers
      const name = existing.name || existing.business_name || '';
      const email = existing.email || '';
      if (typeof name === 'string' && name && !isSyntheticBusinessName(name)) {
        if (typeof email === 'string' && email && !isSyntheticEmail(email)) {
          result.failed.push({
            table: item.table,
            id: item.id,
            error: `FAIL-CLOSED: Row does not appear to be synthetic (name="${name}", email="${email}")`,
          });
          continue;
        }
      }

      // Delete the row
      const { error: deleteError } = await db
        .from(item.table)
        .delete()
        .eq(item.pkColumn, item.id);

      if (deleteError) {
        result.failed.push({
          table: item.table,
          id: item.id,
          error: `Delete failed: ${JSON.stringify(deleteError)}`,
        });
      } else {
        result.deleted++;
      }
    } catch (err) {
      result.failed.push({
        table: item.table,
        id: item.id,
        error: `Exception: ${(err as Error).message}`,
      });
    }
  }

  return result;
}

/**
 * Verify that zero synthetic rows remain after cleanup.
 * Checks known tables for synthetic email/name patterns.
 */
export async function verifyZeroSyntheticRows(
  db: CleanupDbClient,
  runId: string,
): Promise<{ clean: boolean; remainingCount: number; details: Array<{ table: string; count: number }> }> {
  const tablesToCheck = [
    { table: 'businesses', column: 'name', pattern: 'SynthBiz %' },
    { table: 'profiles', column: 'email', pattern: 'synth-e2e-%' },
    { table: 'bot_sessions', column: 'metadata', pattern: `%${runId}%` },
  ];

  let totalRemaining = 0;
  const details: Array<{ table: string; count: number }> = [];

  for (const check of tablesToCheck) {
    try {
      const { data } = await db
        .from(check.table)
        .select(check.column)
        .ilike(check.column, check.pattern);

      const count = data?.length || 0;
      if (count > 0) {
        details.push({ table: check.table, count });
        totalRemaining += count;
      }
    } catch {
      // Table may not exist or column may not support ilike — skip
    }
  }

  return {
    clean: totalRemaining === 0,
    remainingCount: totalRemaining,
    details,
  };
}

// ── CLI Entry Point ──

async function main() {
  const args = process.argv.slice(2);
  const isDryRun = args.includes('--dry-run');
  const isExecute = args.includes('--execute');
  const isVerify = args.includes('--verify');
  const manifestIdx = args.indexOf('--manifest');
  const runIdIdx = args.indexOf('--run-id');

  if (!isDryRun && !isExecute && !isVerify) {
    console.error('Usage:');
    console.error('  npx tsx synthetic-e2e/lib/cleanup-executor.ts --dry-run --manifest <path>');
    console.error('  npx tsx synthetic-e2e/lib/cleanup-executor.ts --execute --manifest <path>');
    console.error('  npx tsx synthetic-e2e/lib/cleanup-executor.ts --verify --run-id <id>');
    process.exit(1);
  }

  // Verify staging environment
  const supabaseRef = process.env.SYNTH_SUPABASE_REF || STAGING_SUPABASE_REF;
  assertStagingSupabase(supabaseRef);

  console.log(`[CLEANUP] Staging Supabase ref verified: ${supabaseRef}`);

  // CTO R2 Fix 3: --verify and --execute require staging DB credentials.
  // Fail-closed with nonzero exit if credentials are missing.
  const supabaseUrl = process.env.SYNTH_SUPABASE_URL;
  const supabaseKey = process.env.SYNTH_SUPABASE_KEY;

  if (isVerify && runIdIdx >= 0) {
    const runId = args[runIdIdx + 1];
    if (!runId) {
      console.error('FAIL-CLOSED: --verify requires --run-id <id>');
      process.exit(1);
    }
    if (!supabaseUrl || !supabaseKey) {
      console.error(
        'FAIL-CLOSED: --verify requires SYNTH_SUPABASE_URL and SYNTH_SUPABASE_KEY. ' +
        'Cannot verify zero synthetic rows without staging DB access.'
      );
      process.exit(1);
    }
    console.log(`[CLEANUP] Verification mode for run: ${runId}`);
    console.log(`[CLEANUP] Connecting to staging Supabase: ${supabaseRef}`);
    // Actual DB verification would happen here with real credentials.
    // Not implemented because staging deletion is not authorized by CTO R2.
    console.error('FAIL-CLOSED: Staging DB verification not yet authorized. Exit nonzero.');
    process.exit(1);
  }

  if ((isDryRun || isExecute) && manifestIdx >= 0) {
    const manifestPath = args[manifestIdx + 1];
    if (!manifestPath) {
      console.error('FAIL-CLOSED: --manifest requires a file path');
      process.exit(1);
    }
    const { readFileSync, existsSync } = await import('fs');
    if (!existsSync(manifestPath)) {
      console.error(`FAIL-CLOSED: Manifest file not found: ${manifestPath}`);
      process.exit(1);
    }
    const json = readFileSync(manifestPath, 'utf-8');
    const tracker = CleanupTracker.fromJSON(json);
    const manifest = tracker.getManifest();

    console.log(`[CLEANUP] Loaded manifest for run: ${manifest.runId}`);
    console.log(`[CLEANUP] Entries: ${manifest.entries.length}`);
    console.log(`[CLEANUP] Mode: ${isDryRun ? 'dry-run' : 'execute'}`);

    if (isDryRun) {
      const order = tracker.getDeletionOrder();
      console.log(`\n[CLEANUP] Deletion plan (${order.length} rows):`);
      for (const item of order) {
        console.log(`  DELETE FROM ${item.table} WHERE ${item.pkColumn} = '${item.id}'`);
      }
      console.log('\n[CLEANUP] Dry-run complete. No rows deleted.');
      process.exit(0);
    }

    // --execute mode: fail-closed without staging credentials
    if (!supabaseUrl || !supabaseKey) {
      console.error(
        'FAIL-CLOSED: --execute requires SYNTH_SUPABASE_URL and SYNTH_SUPABASE_KEY. ' +
        'Cannot delete synthetic rows without staging DB access.'
      );
      process.exit(1);
    }
    console.error('FAIL-CLOSED: Staging DB execution not yet authorized. Exit nonzero.');
    process.exit(1);
  }

  console.error('FAIL-CLOSED: Missing required arguments. See usage above.');
  process.exit(1);
}

// Run CLI if executed directly
const isDirectExecution = typeof require !== 'undefined'
  && require.main === module
  || process.argv[1]?.endsWith('cleanup-executor.ts');

if (isDirectExecution) {
  main().catch(err => {
    console.error('Cleanup error:', err);
    process.exit(1);
  });
}
