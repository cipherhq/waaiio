/**
 * Release Gate V2 — Blast-Radius Evaluator
 *
 * Compares base SHA → head SHA using `git diff`, maps changed files
 * to regression manifest domains, and reports affected domains with
 * their required test suites and related invariants.
 *
 * Used in CI as an advisory step (does not block merges yet).
 *
 * @see lib/release-gate/regression-manifest.ts
 * @see #406 (B2 — Blast-Radius Mapping)
 */

import { execSync } from 'child_process';
import {
  REGRESSION_MANIFEST,
  getAffectedDomains,
  getRequiredTestSuites,
  getRelatedInvariants,
  type DomainEntry,
} from './regression-manifest';

export interface BlastRadiusResult {
  baseSha: string;
  headSha: string;
  changedFiles: string[];
  affectedDomains: DomainEntry[];
  requiredTestSuites: string[];
  relatedInvariants: string[];
  unmappedFiles: string[];
}

/**
 * Get changed files between two SHAs using git diff.
 * Returns paths relative to repo root.
 */
export function getChangedFiles(baseSha: string, headSha: string): string[] {
  const output = execSync(
    `git diff --name-only --diff-filter=ACDMR ${baseSha}...${headSha}`,
    { encoding: 'utf-8' }
  ).trim();
  if (!output) return [];
  return output.split('\n').filter(Boolean);
}

/**
 * Determine which changed files are NOT covered by any manifest domain.
 */
export function getUnmappedFiles(changedFiles: string[], domains: DomainEntry[]): string[] {
  const allPatterns = domains.flatMap(d => d.pathPatterns);
  return changedFiles.filter(file =>
    !REGRESSION_MANIFEST.some(domain =>
      domain.pathPatterns.some(pattern => file.startsWith(pattern))
    )
  );
}

/**
 * Run the full blast-radius evaluation for a base→head diff.
 */
export function evaluateBlastRadius(baseSha: string, headSha: string): BlastRadiusResult {
  const changedFiles = getChangedFiles(baseSha, headSha);
  const affectedDomains = getAffectedDomains(changedFiles);
  const requiredTestSuites = getRequiredTestSuites(affectedDomains);
  const relatedInvariants = getRelatedInvariants(affectedDomains);
  const unmappedFiles = getUnmappedFiles(changedFiles, affectedDomains);

  return {
    baseSha,
    headSha,
    changedFiles,
    affectedDomains,
    requiredTestSuites,
    relatedInvariants,
    unmappedFiles,
  };
}

/**
 * Format blast-radius result for CI output.
 */
export function formatBlastRadiusReport(result: BlastRadiusResult): string {
  const lines: string[] = [];

  lines.push('═══════════════════════════════════════════════════════════');
  lines.push('  BLAST-RADIUS REPORT (advisory)');
  lines.push('═══════════════════════════════════════════════════════════');
  lines.push(`  Base SHA: ${result.baseSha.slice(0, 12)}`);
  lines.push(`  Head SHA: ${result.headSha.slice(0, 12)}`);
  lines.push(`  Changed files: ${result.changedFiles.length}`);
  lines.push('');

  if (result.affectedDomains.length === 0) {
    lines.push('  No launch-critical domains affected.');
    lines.push('  (Changed files are outside the regression manifest scope)');
  } else {
    lines.push('  AFFECTED DOMAINS:');
    for (const domain of result.affectedDomains) {
      lines.push(`    • ${domain.id}: ${domain.label}`);
    }
    lines.push('');
    lines.push(`  REQUIRED TEST SUITES: ${result.requiredTestSuites.length}`);
    for (const suite of result.requiredTestSuites) {
      lines.push(`    ✓ ${suite}`);
    }

    if (result.relatedInvariants.length > 0) {
      lines.push('');
      lines.push(`  RELATED INVARIANTS: ${result.relatedInvariants.join(', ')}`);
    }
  }

  if (result.unmappedFiles.length > 0) {
    lines.push('');
    lines.push(`  UNMAPPED FILES: ${result.unmappedFiles.length} (outside manifest scope)`);
    // Show first 10 to avoid flooding CI output
    for (const file of result.unmappedFiles.slice(0, 10)) {
      lines.push(`    ? ${file}`);
    }
    if (result.unmappedFiles.length > 10) {
      lines.push(`    ... and ${result.unmappedFiles.length - 10} more`);
    }
  }

  lines.push('═══════════════════════════════════════════════════════════');
  return lines.join('\n');
}
