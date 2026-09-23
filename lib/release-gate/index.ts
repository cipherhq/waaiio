/**
 * Release Gate V2 — Module Index
 *
 * This module provides the executable release-safety infrastructure:
 *
 * - types.ts              — Schema definitions (baseline, manifest, diff, certificate)
 * - invariant-registry.ts — Machine-readable invariant + protected object registry
 * - baseline-capture.ts   — Captures DB catalog state from a live database
 * - diff-engine.ts        — Compares baselines, classifies differences
 * - sha-guard.ts          — Exact-SHA freshness and stale-evidence rejection
 * - gate.ts               — Gate orchestrator (BEFORE → CANDIDATE → AFTER)
 * - migration-lint.ts     — Static analysis of migration files
 * - certificate.ts        — Generates release certificates
 *
 * Supporting documentation:
 * - RELEASE_GATE_V2.md    — Human-readable release gate contract
 * - WAAIIO_ENGINEERING_OPERATING_ORDER.md — Governance reference
 *
 * Test files:
 * - lib/__tests__/release-gate-diff-engine.test.ts       — Diff engine (synthetic baselines)
 * - lib/__tests__/release-gate-invariants-db.test.ts     — DB invariants (real PostgreSQL)
 * - lib/__tests__/release-gate-migration-lint.test.ts    — Migration lint
 * - lib/__tests__/release-gate-sha-guard.test.ts         — SHA freshness + stale evidence
 * - lib/__tests__/release-gate-orchestration.test.ts     — Full 3-phase gate orchestration
 *
 * @see RELEASE_GATE_V2.md
 */

export type {
  BaselineSnapshot,
  FunctionCatalog,
  FunctionGrant,
  RlsPolicy,
  TableRls,
  Extension,
  Constraint,
  TriggerEntry,
  CronJob,
  MigrationRecord,
  InvariantResult,
  JourneyResult,
  JourneyCheckpoint,
  ReleaseManifest,
  ExpectedChange,
  StateDiffEntry,
  StateDiffResult,
  DiffClassification,
  ReleaseCertificate,
  ProviderCheck,
  InvariantDefinition,
  ProtectedObject,
} from './types';

export {
  INVARIANTS,
  PROTECTED_OBJECTS,
  getInvariant,
  getCriticalInvariants,
  getProtectedObjectsForInvariant,
} from './invariant-registry';

export { captureBaseline } from './baseline-capture';
export { computeStateDiff } from './diff-engine';
export {
  validateBaselineSha,
  validateDiffShas,
  validateCertificateSha,
  validateEvidenceChain,
} from './sha-guard';
export { executeGate } from './gate';
export type { GateResult, GateInput } from './gate';
export { lintMigration, lintMigrationDirectory, HISTORICAL_EXCEPTIONS } from './migration-lint';
export { parseMigrationDiffNul, parseMigrationDiffLines } from './migration-diff-parser';
export { generateCertificate, formatCertificate } from './certificate';
