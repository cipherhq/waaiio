/**
 * Release Gate V2 — State Diff & Regression Baseline Types
 *
 * These types define the schema for baseline snapshots, release manifests,
 * diff results, and release certificates. They are the source of truth for
 * the release state-diff system — future engineers and AI agents read these
 * types to understand the system without needing conversation history.
 *
 * @see RELEASE_GATE_V2.md §8 (State Diff & Regression Baseline)
 */

// ═══════════════════════════════════════════════════════════════════
// §1 — Baseline Snapshot
// ═══════════════════════════════════════════════════════════════════

/** A single database function's catalog entry */
export interface FunctionCatalog {
  schema: string;
  name: string;
  /** Full argument signature, e.g. "uuid, uuid, text[], text[]" */
  arg_types: string;
  /** Return type */
  return_type: string;
  /** SECURITY DEFINER or SECURITY INVOKER */
  security: 'definer' | 'invoker';
  /** Owner role */
  owner: string;
  /** Function-level proconfig entries, e.g. ["search_path=public, extensions"] */
  proconfig: string[];
  /** Language (plpgsql, sql, etc.) */
  language: string;
  /** SHA-256 of the function body — detects silent body changes */
  body_hash: string;
}

/** EXECUTE grants on a function */
export interface FunctionGrant {
  schema: string;
  function_name: string;
  arg_types: string;
  grantee: string;
  is_grantable: boolean;
}

/** RLS policy on a table */
export interface RlsPolicy {
  schema: string;
  table_name: string;
  policy_name: string;
  permissive: 'PERMISSIVE' | 'RESTRICTIVE';
  roles: string[];
  cmd: 'ALL' | 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE';
  qual_hash: string;
  with_check_hash: string;
}

/** Table-level RLS status */
export interface TableRls {
  schema: string;
  table_name: string;
  rls_enabled: boolean;
  force_rls: boolean;
}

/** Installed extension */
export interface Extension {
  name: string;
  schema: string;
  version: string;
}

/** CHECK/UNIQUE/FK constraint */
export interface Constraint {
  schema: string;
  table_name: string;
  constraint_name: string;
  constraint_type: string;
  definition: string;
}

/** Trigger on a table */
export interface TriggerEntry {
  schema: string;
  table_name: string;
  trigger_name: string;
  event_manipulation: string;
  action_timing: string;
  action_statement_hash: string;
}

/** Cron job (pg_cron or Vercel cron) */
export interface CronJob {
  source: 'pg_cron' | 'vercel';
  name: string;
  schedule: string;
  command_or_path: string;
}

/** Applied migration record */
export interface MigrationRecord {
  version: string;
  name: string;
  /** SHA-256 of migration file content at this SHA */
  content_hash: string;
}

/**
 * Complete baseline snapshot of system state.
 * Captured at a specific SHA and database state.
 */
export interface BaselineSnapshot {
  /** Unique ID for this baseline (UUID) */
  id: string;
  /** When this baseline was captured */
  captured_at: string;
  /** Git SHA this baseline represents */
  git_sha: string;
  /** Phase: before deployment, candidate state, or after deployment */
  phase: 'pre_deployment' | 'candidate' | 'post_deployment';
  /** Human label, e.g. "Production 2026-09-22" */
  label: string;

  // Database catalog
  functions: FunctionCatalog[];
  function_grants: FunctionGrant[];
  table_rls: TableRls[];
  rls_policies: RlsPolicy[];
  extensions: Extension[];
  constraints: Constraint[];
  triggers: TriggerEntry[];
  cron_jobs: CronJob[];
  migrations: MigrationRecord[];

  // Invariant test results
  invariant_results: InvariantResult[];

  // Golden journey results
  journey_results: JourneyResult[];
}

// ═══════════════════════════════════════════════════════════════════
// §2 — Invariant & Journey Results
// ═══════════════════════════════════════════════════════════════════

export interface InvariantResult {
  /** Invariant ID from the registry, e.g. "DB-001" */
  invariant_id: string;
  /** Human-readable description */
  description: string;
  /** Pass/fail/skip/error */
  status: 'pass' | 'fail' | 'skip' | 'error';
  /** Evidence details (query result, error message, etc.) */
  evidence: string;
  /** Is this invariant critical (blocks release if failed)? */
  critical: boolean;
}

export interface JourneyResult {
  /** Journey ID, e.g. "appointment-stripe" */
  journey_id: string;
  description: string;
  status: 'pass' | 'fail' | 'skip' | 'error';
  /** Individual checkpoint results within the journey */
  checkpoints: JourneyCheckpoint[];
}

export interface JourneyCheckpoint {
  name: string;
  status: 'pass' | 'fail' | 'skip' | 'error';
  evidence: string;
}

// ═══════════════════════════════════════════════════════════════════
// §3 — Release Change Manifest (declared expected changes)
// ═══════════════════════════════════════════════════════════════════

/**
 * Declares what a release is EXPECTED to change.
 * Any delta not covered by a manifest entry is flagged as unexpected.
 */
export interface ReleaseManifest {
  /** Release identifier (PR number, version, etc.) */
  release_id: string;
  /** Candidate SHA */
  candidate_sha: string;
  /** Base SHA (what's currently deployed) */
  base_sha: string;
  /** Who approved this manifest */
  approved_by: string;
  /** When manifest was created */
  created_at: string;

  /** Expected changes to declare */
  expected_changes: ExpectedChange[];
}

export interface ExpectedChange {
  /** What category: function, grant, rls, constraint, migration, config */
  category: 'function' | 'grant' | 'rls' | 'constraint' | 'migration' | 'config' | 'cron' | 'extension';
  /** Object identifier (function name, table.policy, etc.) */
  object_id: string;
  /** What changed: added, removed, modified, attribute_changed */
  change_type: 'added' | 'removed' | 'modified' | 'attribute_changed';
  /** Human description of why this change is expected */
  reason: string;
  /** Which PR/issue authorized this change */
  authorization: string;
}

// ═══════════════════════════════════════════════════════════════════
// §4 — State Diff Results
// ═══════════════════════════════════════════════════════════════════

export type DiffClassification = 'expected' | 'unexpected' | 'improved' | 'regression';

export interface StateDiffEntry {
  /** What category of object changed */
  category: 'function' | 'grant' | 'rls' | 'constraint' | 'migration' | 'config' | 'cron' | 'extension' | 'trigger' | 'invariant' | 'journey';
  /** Object identifier */
  object_id: string;
  /** What kind of change */
  change_type: 'added' | 'removed' | 'modified';
  /** What specifically changed (e.g., "search_path", "body_hash", "status") */
  field: string;
  /** Value in the before baseline */
  before: string;
  /** Value in the after baseline */
  after: string;
  /** Classification */
  classification: DiffClassification;
  /** If expected, which manifest entry covers it */
  manifest_entry?: string;
  /** If regression, which commits are most likely responsible */
  likely_commits?: string[];
  /** If regression, which files are most likely responsible */
  likely_files?: string[];
  /** Is this a critical diff that blocks the release? */
  critical: boolean;
}

export interface StateDiffResult {
  /** Comparison identifier */
  id: string;
  /** When this diff was computed */
  computed_at: string;
  /** Before baseline */
  before_baseline_id: string;
  before_sha: string;
  /** After baseline */
  after_baseline_id: string;
  after_sha: string;
  /** Release manifest used for expected-change matching */
  manifest_id: string | null;

  /** All detected differences */
  entries: StateDiffEntry[];

  /** Summary counts */
  summary: {
    total: number;
    expected: number;
    unexpected: number;
    improved: number;
    regressions: number;
    critical_regressions: number;
  };

  /** Final gate verdict */
  verdict: 'PASS' | 'BLOCKED';
  /** If blocked, the reasons */
  block_reasons: string[];
}

// ═══════════════════════════════════════════════════════════════════
// §5 — Release Certificate
// ═══════════════════════════════════════════════════════════════════

export interface ReleaseCertificate {
  /** Certificate identifier */
  id: string;
  /** When issued */
  issued_at: string;
  /** Release SHA */
  release_sha: string;
  /** Deployment identifier (e.g. Vercel deployment ID) */
  deployment_id: string | null;

  /** Baseline identities */
  pre_deployment_baseline_id: string;
  candidate_baseline_id: string | null;
  post_deployment_baseline_id: string | null;

  /** Migration set included in this release */
  migrations_applied: string[];

  /** State diff results */
  pre_to_candidate_diff: StateDiffResult | null;
  pre_to_post_diff: StateDiffResult | null;

  /** Invariant gate */
  invariant_summary: {
    total: number;
    passed: number;
    failed: number;
    critical_failed: number;
  };

  /** Journey gate */
  journey_summary: {
    total: number;
    passed: number;
    failed: number;
  };

  /** Provider acceptance */
  provider_checks: ProviderCheck[];

  /** Final status */
  status: 'PASS' | 'BLOCKED' | 'PENDING_REVIEW';
  block_reasons: string[];

  /** Who must review (automation produces, CTO reviews, Owner authorizes) */
  requires_cto_review: boolean;
  requires_owner_authorization: boolean;
  cto_review_sha: string | null;
  owner_authorization: string | null;
}

export interface ProviderCheck {
  provider: 'stripe' | 'paystack' | 'meta' | 'flutterwave' | 'square' | 'paypal';
  check_name: string;
  status: 'pass' | 'fail' | 'skip' | 'not_applicable';
  evidence: string;
}

// ═══════════════════════════════════════════════════════════════════
// §6 — Invariant Registry (machine-readable)
// ═══════════════════════════════════════════════════════════════════

export interface InvariantDefinition {
  id: string;
  description: string;
  category: 'database' | 'payment' | 'channel' | 'security';
  /** Is this critical (blocks release if failed)? */
  critical: boolean;
  /** Which issue/PR established this invariant */
  owner: string;
  /** What type of evidence is required */
  evidence_type: 'catalog_assertion' | 'rpc_execution' | 'behavioral_test' | 'code_audit' | 'provider_check';
  /** SQL or description of how to check this invariant */
  check_query?: string;
}

// ═══════════════════════════════════════════════════════════════════
// §7 — Critical function/object registry
// ═══════════════════════════════════════════════════════════════════

/**
 * Functions and objects whose catalog properties are protected.
 * Any change to these requires an explicit manifest entry.
 * This is the machine-readable form of the invariant registry's
 * "protected properties" concept.
 */
export interface ProtectedObject {
  /** Object type */
  type: 'function' | 'table' | 'policy' | 'grant';
  /** Schema-qualified identifier */
  identifier: string;
  /** Which properties are protected and their required values */
  protected_properties: Record<string, string>;
  /** Which invariant IDs protect this object */
  invariant_ids: string[];
}
