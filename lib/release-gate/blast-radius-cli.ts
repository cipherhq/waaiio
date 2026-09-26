#!/usr/bin/env npx tsx
/**
 * Release Gate V2 — Blast-Radius CLI
 *
 * Usage in CI:
 *   npx tsx lib/release-gate/blast-radius-cli.ts <base_sha> <head_sha>
 *
 * Exits 0 always (advisory mode). Exits 1 only on tooling/parse errors.
 */

import { evaluateBlastRadius, formatBlastRadiusReport } from './blast-radius';

const baseSha = process.argv[2];
const headSha = process.argv[3];

if (!baseSha || !headSha) {
  console.error('Usage: blast-radius-cli.ts <base_sha> <head_sha>');
  process.exit(1);
}

try {
  const result = evaluateBlastRadius(baseSha, headSha);
  console.log(formatBlastRadiusReport(result));

  // Advisory: always exit 0 unless there's a tooling error
  // In future, this can be tightened to fail when mapped suites are not run
  process.exit(0);
} catch (error) {
  console.error('Blast-radius evaluation failed (tooling error):');
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
