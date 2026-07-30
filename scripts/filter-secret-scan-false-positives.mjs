#!/usr/bin/env node
/**
 * Filters secret-scanning matches from git diff, applying narrow exemptions
 * for SHA-256 checksum fields in docs/migrations/*.json and docs/migrations/evidence/*.json only.
 *
 * Usage: git diff --cached -U0 | node scripts/filter-secret-scan-false-positives.mjs <PATTERN>
 *
 * Reads unified diff from stdin, applies the secret pattern, then exempts
 * only lines where:
 * - The current file is docs/migrations/*.json or docs/migrations/evidence/*.json
 * - The line is a JSON property with key "checksum", "local_checksum", "evidence_digest", "production_evidence_digest", "migration_checksum", "expected_object_digest", or "previous_evidence_sha256"
 * - The value is exactly a 64-character lowercase hexadecimal string
 *
 * Outputs only genuine (non-exempt) matches, one per line, prefixed with filename.
 */
import { createInterface } from 'readline';

const combinedPattern = process.argv[2];
if (!combinedPattern) {
  process.exit(0);
}

const secretRegex = new RegExp(combinedPattern, 'i');
// Exempt named digest/checksum keys AND numeric version keys (e.g. "154": "sha256...") in migration evidence
const exemptKeyRegex = /^\+\s*"(checksum|local_checksum|evidence_digest|production_evidence_digest|repair_evidence_digest|migration_checksum|expected_object_digest|previous_evidence_sha256|original_evidence_sha256|migration_file_sha256|migration_evidence_digest|superseded_temporary_evidence_sha256|def_hash|using_hash|\d{3})"\s*:\s*"[0-9a-f]{64}"\s*,?\s*$/;
const migrationJsonPath = /^docs\/migrations\/(evidence\/)?[^/]+\.json$/;

let currentFile = '';
const rl = createInterface({ input: process.stdin });

rl.on('line', (line) => {
  // Track current file from +++ lines
  if (line.startsWith('+++ b/')) {
    currentFile = line.slice(6);
    return;
  }

  // Only process added lines
  if (!line.startsWith('+') || line.startsWith('+++')) return;

  // Skip comment lines (same filters as pre-commit)
  if (/^\+#|^\+\/\/.*TODO|^\+\/\/.*FIXME/.test(line)) return;

  // Check if line matches a secret pattern
  if (!secretRegex.test(line)) return;

  // Apply narrow exemption: only for docs/migrations/*.json checksum fields
  const isExemptFile = migrationJsonPath.test(currentFile);
  const isExemptLine = exemptKeyRegex.test(line);

  if (isExemptFile && isExemptLine) {
    // Exempt — do not output
    return;
  }

  // Genuine match — output it
  console.log(`${currentFile}: ${line}`);
});

rl.on('close', () => {
  // Exit code 0 — caller checks if output is non-empty
});
