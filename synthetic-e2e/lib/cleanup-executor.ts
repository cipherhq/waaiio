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
 * Allowlisted tables that cleanup may touch.
 * CTO R3 Fix 4: Prevents arbitrary table deletion via manifest manipulation.
 */
const CLEANUP_ALLOWED_TABLES = new Set([
  'businesses',
  'profiles',
  'bot_sessions',
  'messaging_opt_outs',
  'launch_subscribers',
  'whatsapp_channels',
  'products',
  'services',
]);

/**
 * Execute cleanup of manifest-owned synthetic data.
 *
 * CTO R3 Fix 4: Execution and verification are intentionally unsupported
 * until staging deletion is separately authorized. This function is gated
 * with table allowlists, mandatory synthetic markers, and staging identity.
 *
 * Callers must use the CLI entry point, which exits nonzero without
 * staging credentials and authorization.
 */
export async function executeCleanup(
  db: CleanupDbClient,
  tracker: CleanupTracker,
  options: { dryRun: boolean; supabaseRef: string },
): Promise<CleanupResult> {
  // Staging ref is REQUIRED. Fail-closed.
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

  // Validate all tables are in the allowlist BEFORE any deletion
  for (const item of deletionOrder) {
    if (!CLEANUP_ALLOWED_TABLES.has(item.table)) {
      result.failed.push({
        table: item.table,
        id: item.id,
        error: `FAIL-CLOSED: Table "${item.table}" is not in cleanup allowlist`,
      });
    }
  }
  if (result.failed.length > 0) {
    return result; // Abort — do not proceed with partial deletion
  }

  if (options.dryRun) {
    for (const item of deletionOrder) {
      console.log(`  [DRY-RUN] DELETE FROM ${item.table} WHERE ${item.pkColumn} = '${item.id}'`);
    }
    return result;
  }

  // Execute deletions in order
  for (const item of deletionOrder) {
    try {
      const { data: existing, error: readError } = await db
        .from(item.table)
        .select('*')
        .eq(item.pkColumn, item.id)
        .single();

      if (readError || !existing) {
        result.failed.push({
          table: item.table,
          id: item.id,
          error: `Row not found: ${readError ? JSON.stringify(readError) : 'null'}`,
        });
        continue;
      }

      // CTO R3 Fix 4: Ownership verification — REQUIRE at least one synthetic marker.
      // Fail-closed: rows with NO identifiable synthetic marker are rejected.
      const name = String(existing.name || existing.business_name || '');
      const email = String(existing.email || '');
      const hasSyntheticName = name && isSyntheticBusinessName(name);
      const hasSyntheticEmail = email && isSyntheticEmail(email);

      if (!hasSyntheticName && !hasSyntheticEmail) {
        result.failed.push({
          table: item.table,
          id: item.id,
          error: `FAIL-CLOSED: Row has no synthetic marker (name="${name}", email="${email}"). Refusing to delete.`,
        });
        continue;
      }

      const { error: deleteError, count } = await db
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
        // CTO R3: Track affected-row count for verification
        if (count !== null && count !== 1) {
          result.failed.push({
            table: item.table,
            id: item.id,
            error: `Unexpected affected rows: expected 1, got ${count}`,
          });
        } else {
          result.deleted++;
        }
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
 * Checks known tables for run-specific synthetic patterns.
 *
 * CTO R3 Fix 4: Propagates query errors instead of swallowing them.
 * Uses run-specific patterns, not broad non-run-specific scans.
 */
export async function verifyZeroSyntheticRows(
  db: CleanupDbClient,
  runId: string,
): Promise<{ clean: boolean; remainingCount: number; details: Array<{ table: string; count: number }>; errors: string[] }> {
  if (!runId || runId.length < 8) {
    throw new Error('FAIL-CLOSED: verifyZeroSyntheticRows requires a valid run ID');
  }

  // Use run-specific patterns to avoid matching unrelated data
  const tablesToCheck = [
    { table: 'businesses', column: 'name', pattern: `%${runId.slice(-12)}%` },
    { table: 'profiles', column: 'email', pattern: `%${runId.slice(-12)}%` },
  ];

  let totalRemaining = 0;
  const details: Array<{ table: string; count: number }> = [];
  const errors: string[] = [];

  for (const check of tablesToCheck) {
    const { data, error } = await db
      .from(check.table)
      .select(check.column)
      .ilike(check.column, check.pattern);

    // CTO R3: Propagate errors instead of swallowing
    if (error) {
      errors.push(`Query error on ${check.table}: ${JSON.stringify(error)}`);
      continue;
    }

    const count = data?.length || 0;
    if (count > 0) {
      details.push({ table: check.table, count });
      totalRemaining += count;
    }
  }

  return {
    clean: totalRemaining === 0 && errors.length === 0,
    remainingCount: totalRemaining,
    details,
    errors,
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
