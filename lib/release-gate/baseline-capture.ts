/**
 * Release Gate V2 — Baseline Capture
 *
 * Captures a complete snapshot of database catalog state, invariant
 * test results, and system configuration at a specific point in time.
 *
 * Usage:
 *   Locally:  TEST_DATABASE_URL=... npx tsx lib/release-gate/baseline-capture.ts
 *   In tests: import { captureBaseline } from './baseline-capture'
 *
 * The capture uses pg_catalog queries — it reads only; never mutates.
 *
 * @see RELEASE_GATE_V2.md §8 (State Diff & Regression Baseline)
 */

import { execSync } from 'child_process';
import { randomUUID } from 'crypto';
import type {
  BaselineSnapshot,
  FunctionCatalog,
  FunctionGrant,
  TableRls,
  RlsPolicy,
  Extension,
  Constraint,
  TriggerEntry,
  CronJob,
  InvariantResult,
} from './types';
import { INVARIANTS, PROTECTED_OBJECTS } from './invariant-registry';

// ═══════════════════════════════════════════════════════════════════
// SQL Runner
// ═══════════════════════════════════════════════════════════════════

export function runSQL(dbUrl: string, sql: string): string {
  try {
    const result = execSync(
      `psql "${dbUrl}" -t -A -v ON_ERROR_STOP=1`,
      { input: sql, encoding: 'utf-8', timeout: 30000 },
    );
    return result.trim();
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    throw new Error(`SQL failed (exit ${e.status}): ${e.stderr || e.stdout || 'unknown error'}`);
  }
}

export function runSQLRows(dbUrl: string, sql: string): string[][] {
  const raw = runSQL(dbUrl, sql);
  if (!raw) return [];
  return raw.split('\n').map(line => line.split('|'));
}

// ═══════════════════════════════════════════════════════════════════
// Catalog Capture Queries
// ═══════════════════════════════════════════════════════════════════

const FUNCTIONS_QUERY = `
  SELECT
    n.nspname,
    p.proname,
    pg_get_function_identity_arguments(p.oid),
    pg_get_function_result(p.oid),
    CASE WHEN p.prosecdef THEN 'definer' ELSE 'invoker' END,
    r.rolname,
    COALESCE(array_to_string(p.proconfig, '||'), ''),
    l.lanname,
    encode(extensions.digest(pg_get_functiondef(p.oid)::text, 'sha256'), 'hex')
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  JOIN pg_roles r ON r.oid = p.proowner
  JOIN pg_language l ON l.oid = p.prolang
  WHERE n.nspname = 'public'
    AND l.lanname IN ('plpgsql', 'sql')
  ORDER BY p.proname;
`;

/** Overload-safe grant query using pg_catalog + pg_get_function_identity_arguments.
 *  Includes grantee=0 (PUBLIC) — mapped to the string 'PUBLIC' below. */
const FUNCTION_GRANTS_QUERY = `
  SELECT
    n.nspname,
    p.proname,
    pg_get_function_identity_arguments(p.oid),
    CASE WHEN acl.grantee = 0 THEN 'PUBLIC' ELSE acl.grantee::regrole::text END,
    acl.is_grantable
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) AS acl
  WHERE n.nspname = 'public'
    AND acl.privilege_type = 'EXECUTE'
  ORDER BY p.proname, CASE WHEN acl.grantee = 0 THEN 'PUBLIC' ELSE acl.grantee::regrole::text END;
`;


const TABLE_RLS_QUERY = `
  SELECT
    n.nspname,
    c.relname,
    c.relrowsecurity,
    c.relforcerowsecurity
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relkind = 'r'
    AND c.relname NOT LIKE 'pg_%'
    AND c.relname NOT LIKE '_realtime%'
  ORDER BY c.relname;
`;

const RLS_POLICIES_QUERY = `
  SELECT
    schemaname,
    tablename,
    policyname,
    permissive,
    COALESCE(array_to_string(roles, ','), ''),
    cmd,
    COALESCE(encode(extensions.digest(COALESCE(qual, '')::text, 'sha256'), 'hex'), ''),
    COALESCE(encode(extensions.digest(COALESCE(with_check, '')::text, 'sha256'), 'hex'), '')
  FROM pg_policies
  WHERE schemaname = 'public'
  ORDER BY tablename, policyname;
`;

const EXTENSIONS_QUERY = `
  SELECT
    e.extname,
    n.nspname,
    e.extversion
  FROM pg_extension e
  JOIN pg_namespace n ON n.oid = e.extnamespace
  ORDER BY e.extname;
`;

const CONSTRAINTS_QUERY = `
  SELECT
    tc.table_schema,
    tc.table_name,
    tc.constraint_name,
    tc.constraint_type,
    COALESCE(encode(extensions.digest(pg_get_constraintdef(c.oid)::text, 'sha256'), 'hex'), '')
  FROM information_schema.table_constraints tc
  JOIN pg_constraint c ON c.conname = tc.constraint_name
    AND c.connamespace = (SELECT oid FROM pg_namespace WHERE nspname = tc.table_schema)
  WHERE tc.table_schema = 'public'
  ORDER BY tc.table_name, tc.constraint_name;
`;

const TRIGGERS_QUERY = `
  SELECT
    trigger_schema,
    event_object_table,
    trigger_name,
    event_manipulation,
    action_timing,
    encode(extensions.digest(action_statement::text, 'sha256'), 'hex')
  FROM information_schema.triggers
  WHERE trigger_schema = 'public'
  ORDER BY event_object_table, trigger_name;
`;

// ═══════════════════════════════════════════════════════════════════
// Invariant Checks
// ═══════════════════════════════════════════════════════════════════

function checkInvariant(dbUrl: string, invariant: typeof INVARIANTS[number]): InvariantResult {
  if (!invariant.check_query) {
    return {
      invariant_id: invariant.id,
      description: invariant.description,
      status: 'skip',
      evidence: 'No catalog query — requires behavioral test',
      critical: invariant.critical,
    };
  }

  try {
    const rows = runSQLRows(dbUrl, invariant.check_query);
    // For catalog assertions, zero rows = PASS (no violations found)
    // Exception: DB-006 expects rows with 'OK' status
    if (invariant.id === 'DB-006') {
      const allOk = rows.every(r => r[1] === 'OK');
      const missing = rows.filter(r => r[1] !== 'OK').map(r => r[0]);
      return {
        invariant_id: invariant.id,
        description: invariant.description,
        status: allOk && rows.length > 0 ? 'pass' : 'fail',
        evidence: allOk ? `Both functions have correct search_path` : `Missing extensions in search_path: ${missing.join(', ')}`,
        critical: invariant.critical,
      };
    }

    // Default: zero rows = pass (no violations)
    if (rows.length === 0 || (rows.length === 1 && rows[0][0] === '')) {
      return {
        invariant_id: invariant.id,
        description: invariant.description,
        status: 'pass',
        evidence: 'No violations found',
        critical: invariant.critical,
      };
    }

    return {
      invariant_id: invariant.id,
      description: invariant.description,
      status: 'fail',
      evidence: `Violations: ${JSON.stringify(rows)}`,
      critical: invariant.critical,
    };
  } catch (err) {
    return {
      invariant_id: invariant.id,
      description: invariant.description,
      status: 'error',
      evidence: `Query error: ${(err as Error).message}`,
      critical: invariant.critical,
    };
  }
}

function checkProtectedObjects(dbUrl: string): InvariantResult[] {
  const results: InvariantResult[] = [];

  for (const obj of PROTECTED_OBJECTS) {
    if (obj.type !== 'function') continue;

    try {
      // Parse the identifier to extract schema.name(args)
      const match = obj.identifier.match(/^(\w+)\.(\w+)\((.+)\)$/);
      if (!match) {
        results.push({
          invariant_id: 'DB-002',
          description: `Protected object ${obj.identifier}: could not parse identifier`,
          status: 'error',
          evidence: 'Invalid identifier format',
          critical: true,
        });
        continue;
      }

      const [, schema, name] = match;

      // Validate identifiers are safe (alphanumeric + underscore only)
      if (!/^\w+$/.test(schema) || !/^\w+$/.test(name)) {
        results.push({
          invariant_id: 'DB-002',
          description: `Protected object ${obj.identifier}: unsafe identifier characters`,
          status: 'error',
          evidence: `schema="${schema}" name="${name}" contain non-alphanumeric characters`,
          critical: true,
        });
        continue;
      }

      // Use exact regprocedure cast for overload-safe identity
      const regprocedure = `${schema}.${name}(${match[3]})`;
      const query = `
        SELECT
          CASE WHEN p.prosecdef THEN 'definer' ELSE 'invoker' END AS security,
          COALESCE(array_to_string(p.proconfig, '||'), '') AS proconfig
        FROM pg_proc p
        WHERE p.oid = '${regprocedure}'::regprocedure;
      `;

      let rows: string[][];
      try {
        rows = runSQLRows(dbUrl, query);
      } catch (regErr) {
        // regprocedure cast fails when function doesn't exist
        if (obj.required) {
          results.push({
            invariant_id: 'DB-002',
            description: `Required protected function ${obj.identifier}: NOT FOUND`,
            status: 'fail',
            evidence: `Function does not exist in catalog. Required objects must be present.`,
            critical: true,
          });
        } else {
          results.push({
            invariant_id: 'DB-002',
            description: `Protected function ${obj.identifier}: not found in catalog`,
            status: 'skip',
            evidence: 'Function does not exist (may not be deployed yet)',
            critical: false,
          });
        }
        continue;
      }

      if (rows.length === 0 || (rows.length === 1 && rows[0][0] === '')) {
        // Function not found — fail if required
        results.push({
          invariant_id: 'DB-002',
          description: `Protected function ${obj.identifier}: ${obj.required ? 'REQUIRED BUT MISSING' : 'not found'}`,
          status: obj.required ? 'fail' : 'skip',
          evidence: obj.required ? 'Required function does not exist in catalog' : 'Function not deployed yet',
          critical: obj.required,
        });
        continue;
      }

      const [security, proconfig] = rows[0];
      const violations: string[] = [];

      for (const [prop, expectedValue] of Object.entries(obj.protected_properties)) {
        if (prop === 'security') {
          if (security !== expectedValue) {
            violations.push(`security: expected ${expectedValue}, got ${security}`);
          }
        } else if (prop.startsWith('proconfig:')) {
          const key = prop.split(':')[1];
          const configStr = `${key}=${expectedValue}`;
          if (!proconfig.includes(configStr)) {
            violations.push(`${prop}: expected "${configStr}" in proconfig, got "${proconfig}"`);
          }
        }
      }

      results.push({
        invariant_id: 'DB-002',
        description: `Protected function ${obj.identifier}`,
        status: violations.length === 0 ? 'pass' : 'fail',
        evidence: violations.length === 0
          ? 'All protected properties match'
          : `Violations: ${violations.join('; ')}`,
        critical: true,
      });
    } catch (err) {
      results.push({
        invariant_id: 'DB-002',
        description: `Protected function ${obj.identifier}`,
        status: 'error',
        evidence: `Check error: ${(err as Error).message}`,
        critical: true,
      });
    }
  }

  return results;
}

// ═══════════════════════════════════════════════════════════════════
// Main Capture
// ═══════════════════════════════════════════════════════════════════

export interface CaptureOptions {
  dbUrl: string;
  gitSha: string;
  phase: BaselineSnapshot['phase'];
  label: string;
}

export function captureBaseline(opts: CaptureOptions): BaselineSnapshot {
  const { dbUrl, gitSha, phase, label } = opts;

  // Capture catalog state
  const functionRows = runSQLRows(dbUrl, FUNCTIONS_QUERY);
  const functions: FunctionCatalog[] = functionRows
    .filter(r => r.length >= 9 && r[0])
    .map(r => ({
      schema: r[0],
      name: r[1],
      arg_types: r[2],
      return_type: r[3],
      security: r[4] as 'definer' | 'invoker',
      owner: r[5],
      proconfig: r[6] ? r[6].split('||') : [],
      language: r[7],
      body_hash: r[8],
    }));

  const grantRows = runSQLRows(dbUrl, FUNCTION_GRANTS_QUERY);
  const function_grants: FunctionGrant[] = grantRows
    .filter(r => r.length >= 5 && r[0])
    .map(r => ({
      schema: r[0],
      function_name: r[1],
      arg_types: r[2],
      grantee: r[3],
      is_grantable: r[4] === 'YES',
    }));

  const rlsRows = runSQLRows(dbUrl, TABLE_RLS_QUERY);
  const table_rls: TableRls[] = rlsRows
    .filter(r => r.length >= 4 && r[0])
    .map(r => ({
      schema: r[0],
      table_name: r[1],
      rls_enabled: r[2] === 't',
      force_rls: r[3] === 't',
    }));

  const policyRows = runSQLRows(dbUrl, RLS_POLICIES_QUERY);
  const rls_policies: RlsPolicy[] = policyRows
    .filter(r => r.length >= 8 && r[0])
    .map(r => ({
      schema: r[0],
      table_name: r[1],
      policy_name: r[2],
      permissive: r[3] as 'PERMISSIVE' | 'RESTRICTIVE',
      roles: r[4] ? r[4].split(',') : [],
      cmd: r[5] as RlsPolicy['cmd'],
      qual_hash: r[6],
      with_check_hash: r[7],
    }));

  const extRows = runSQLRows(dbUrl, EXTENSIONS_QUERY);
  const extensions: Extension[] = extRows
    .filter(r => r.length >= 3 && r[0])
    .map(r => ({
      name: r[0],
      schema: r[1],
      version: r[2],
    }));

  const constraintRows = runSQLRows(dbUrl, CONSTRAINTS_QUERY);
  const constraints: Constraint[] = constraintRows
    .filter(r => r.length >= 5 && r[0])
    .map(r => ({
      schema: r[0],
      table_name: r[1],
      constraint_name: r[2],
      constraint_type: r[3],
      definition: r[4],
    }));

  const triggerRows = runSQLRows(dbUrl, TRIGGERS_QUERY);
  const triggers: TriggerEntry[] = triggerRows
    .filter(r => r.length >= 6 && r[0])
    .map(r => ({
      schema: r[0],
      table_name: r[1],
      trigger_name: r[2],
      event_manipulation: r[3],
      action_timing: r[4],
      action_statement_hash: r[5],
    }));

  // Run invariant checks
  const invariant_results: InvariantResult[] = [];

  for (const inv of INVARIANTS) {
    invariant_results.push(checkInvariant(dbUrl, inv));
  }

  // Run protected object checks
  invariant_results.push(...checkProtectedObjects(dbUrl));

  return {
    id: randomUUID(),
    captured_at: new Date().toISOString(),
    git_sha: gitSha,
    phase,
    label,
    functions,
    function_grants,
    table_rls,
    rls_policies,
    extensions,
    constraints,
    triggers,
    cron_jobs: [], // Populated separately from vercel.json / pg_cron
    migrations: [], // Populated from migration file listing
    invariant_results,
    journey_results: [], // Populated by journey tests
  };
}
