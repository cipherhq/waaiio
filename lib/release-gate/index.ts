/**
 * Release Gate V2 — Module Index
 *
 * This module provides the executable release-safety infrastructure:
 *
 * - types.ts          — Schema definitions (baseline, manifest, diff, certificate)
 * - invariant-registry.ts — Machine-readable invariant + protected object registry
 * - baseline-capture.ts   — Captures DB catalog state from a live database
 * - diff-engine.ts        — Compares baselines, classifies differences
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
export { lintMigration, lintMigrationDirectory } from './migration-lint';
export { generateCertificate, formatCertificate } from './certificate';
