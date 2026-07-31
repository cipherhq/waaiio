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
 * For prose/evidence files (matched by shaProseFileRegex), a context-aware approach
 * is used instead of a blanket exemption: recognized SHA values are redacted from the
 * line (JS constant assignments, JSON digest/checksum key values, Markdown-labelled
 * SHA values), and the remainder is re-tested against the secret pattern. Only if no
 * secret pattern remains after redaction is the line exempted. This prevents a real
 * secret embedded alongside a SHA from being silently ignored.
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
const exemptKeyRegex = /^\+\s*"(checksum|local_checksum|evidence_digest|production_evidence_digest|repair_evidence_digest|migration_checksum|expected_object_digest|previous_evidence_sha256|original_evidence_sha256|migration_file_sha256|migration_evidence_digest|superseded_temporary_evidence_sha256|def_hash|def_sha256|using_hash|using_sha256|body_hash|batch_\d+_evidence_sha256|\d{3})"\s*:\s*"[0-9a-f]{64}"\s*,?\s*$/;
const migrationJsonPath = /^docs\/migrations\/(evidence\/)?[^/]+\.json$/;
// Files that legitimately contain SHA-256 values in prose text (evidence summaries, runbooks, registries, validators, changelogs, engineering status)
const shaProseFileRegex = /^(docs\/(migrations\/(evidence\/)?[^/]+\.(json|md)|MIGRATION_REGISTRY\.md|ENGINEERING_STATUS\.md|engineering-status\.json|migrations\/101-246-repair-runbook\.md)|scripts\/validate-migration-repair-allowlist\.mjs|CHANGELOG\.md)$/;
// A line containing a 64-char hex string that looks like a SHA-256 hash (not a key=value secret pattern)
const sha256InlineRegex = /\b[0-9a-f]{64}\b/;

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

  // Context-aware SHA exemption for prose/evidence files: redact only recognized SHA
  // values, then re-test the remainder. A line is exempt only if no secret pattern
  // remains after all recognized SHAs are removed.
  if (shaProseFileRegex.test(currentFile) && sha256InlineRegex.test(line)) {
    let remainder = line;

    // Redact JS constant SHA assignments (e.g. const FOO_SHA256 = '...')
    remainder = remainder.replace(/(?:const|let|var)\s+\w+(?:_SHA|_SHA256)\s*=\s*'[0-9a-f]{64}'/g, '');

    // Redact JS object property hash assignments (e.g. expectedHash: '...', verifiedHash: '...')
    remainder = remainder.replace(/\w*(?:Hash|Sha256|SHA|sha256|_sha256|_hash|digest|checksum)\s*:\s*'[0-9a-f]{64}'/g, '');

    // Redact recognized JSON digest/checksum key values
    remainder = remainder.replace(/"(?:checksum|local_checksum|evidence_digest|production_evidence_digest|repair_evidence_digest|migration_checksum|expected_object_digest|previous_evidence_sha256|original_evidence_sha256|migration_file_sha256|migration_evidence_digest|superseded_temporary_evidence_sha256|def_hash|def_sha256|using_hash|using_sha256|body_hash|batch_\d+_evidence_sha256|repository_definition_sha256|production_definition_sha256|normalized_executable_sha256|normalized_repository_hash|normalized_production_hash|repository_derived_candidate_definition_sha256|production_observed_definition_sha256|normalized_executable_sha256_current|normalized_executable_sha256_deployed_candidate|superseded_v1_sha256|superseded_v2_sha256|source_commit_sha|source_blob_sha|current_repository_commit_sha|\d{3})"\s*:\s*"[0-9a-f]{64}"/g, '');

    // Redact Markdown/prose labelled SHA values (SHA-256: `<hex>` or SHA: <hex>)
    remainder = remainder.replace(/(?:SHA|SHA-256|SHA256|checksum|digest|hash)[:\s]*`[0-9a-f]{64}`/gi, '');
    remainder = remainder.replace(/(?:SHA|SHA-256|SHA256|checksum|digest|hash)[:\s]*\b[0-9a-f]{64}\b/gi, '');

    // If no secret pattern remains after redaction, exempt the line
    if (!secretRegex.test(remainder)) {
      return;
    }
    // Otherwise fall through to report as genuine finding
  }

  // Genuine match — output it
  console.log(`${currentFile}: ${line}`);
});

rl.on('close', () => {
  // Exit code 0 — caller checks if output is non-empty
});
