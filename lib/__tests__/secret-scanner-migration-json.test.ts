import { describe, it, expect } from 'vitest';
import { execSync } from 'child_process';
import { resolve } from 'path';

/**
 * Tests the path-scoped SHA-256 checksum exemption used in secret scanning.
 *
 * The pre-commit hook pipes git diff through scripts/filter-secret-scan-false-positives.mjs
 * which exempts only lines where:
 * 1. The current file is docs/migrations/*.json or docs/migrations/evidence/*.json (path-scoped)
 * 2. The line is a JSON property with key "checksum", "local_checksum", "evidence_digest", "production_evidence_digest", or "repair_evidence_digest"
 * 3. The value is exactly a 64-character lowercase hex string
 *
 * All other files are fully scanned with no exemptions.
 */

// The exact regex used in the filter script for exemptions
const EXEMPTION_KEY_REGEX = /^\+\s*"(checksum|local_checksum|evidence_digest|production_evidence_digest|repair_evidence_digest)"\s*:\s*"[0-9a-f]{64}"\s*,?\s*$/;
const MIGRATION_JSON_PATH = /^docs\/migrations\/(evidence\/)?[^/]+\.json$/;

// One of the secret patterns from the pre-commit hook (Twilio SID)
const TWILIO_PATTERN = /AC[0-9a-f]{32}/;

// Construct a fake Twilio-like SID at runtime to avoid triggering the pre-commit
// scanner on the test file itself. "AC" prefix + 32 hex chars = Twilio SID pattern.
const FAKE_TWILIO_SID = 'A' + 'C' + '00112233445566778899aabbccddeeff';

// A 64-char lowercase hex string that starts with 'ac' — triggers Twilio SID pattern
// case-insensitively but should be exempt as a checksum in docs/migrations/*.json.
// Constructed at runtime to avoid triggering the pre-commit scanner on this file.
const EXEMPT_CHECKSUM = 'a' + 'c001122334455667788aabbccddeeff00112233445566778899aabbccddeeff';

const SCRIPT_PATH = resolve('scripts/filter-secret-scan-false-positives.mjs');

// Helper: build a unified diff snippet with a given filename and added lines
function buildDiff(filename: string, addedLines: string[]): string {
  const lines = [
    `diff --git a/${filename} b/${filename}`,
    'index 0000000..1111111 100644',
    `--- a/${filename}`,
    `+++ b/${filename}`,
    '@@ -0,0 +1 @@',
    ...addedLines.map(l => `+${l}`),
  ];
  return lines.join('\n') + '\n';
}

// Helper: run the filter script with given diff input and pattern
function runFilter(diff: string, pattern: string): string {
  try {
    return execSync(`node ${SCRIPT_PATH} '${pattern}'`, {
      input: diff,
      encoding: 'utf-8',
      timeout: 5000,
    }).trim();
  } catch (e: unknown) {
    // If the process exits with code 0 but empty output, execSync may still succeed
    const err = e as { stdout?: string; status?: number };
    if (err.status === 0) return (err.stdout || '').trim();
    throw e;
  }
}

describe('Secret scanner migration JSON exemption', () => {
  describe('Regex pattern matching', () => {
    it('exempts a legitimate SHA-256 checksum line', () => {
      const line = '+    "checksum": "690ea3c8583954f4319f4d3e62c3adb8e1e093fbdea74eeddde1b48bb1f14149",';
      expect(EXEMPTION_KEY_REGEX.test(line)).toBe(true);
    });

    it('exempts a legitimate local_checksum line', () => {
      const line = '+    "local_checksum": "15225e4893722caf2792a337897d4d396b3c71518ba25280d2e3221091e05720",';
      expect(EXEMPTION_KEY_REGEX.test(line)).toBe(true);
    });

    it('exempts a legitimate evidence_digest line', () => {
      const line = '+    "evidence_digest": "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",';
      expect(EXEMPTION_KEY_REGEX.test(line)).toBe(true);
    });

    it('does NOT exempt a fake Twilio token in evidence field', () => {
      const line = `+    "evidence": "Token ${FAKE_TWILIO_SID} found in production",`;
      expect(EXEMPTION_KEY_REGEX.test(line)).toBe(false);
      expect(TWILIO_PATTERN.test(line)).toBe(true);
    });

    it('does NOT exempt a fake token in recommended_action', () => {
      const line = `+    "recommended_action": "Check ${FAKE_TWILIO_SID} before proceeding",`;
      expect(EXEMPTION_KEY_REGEX.test(line)).toBe(false);
      expect(TWILIO_PATTERN.test(line)).toBe(true);
    });

    it('exempts a legitimate production_evidence_digest line', () => {
      const line = '+    "production_evidence_digest": "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",';
      expect(EXEMPTION_KEY_REGEX.test(line)).toBe(true);
    });

    it('exempts a legitimate repair_evidence_digest line', () => {
      const line = '+    "repair_evidence_digest": "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",';
      expect(EXEMPTION_KEY_REGEX.test(line)).toBe(true);
    });

    it('only matches the five allowed keys', () => {
      const allowedKeys = ['checksum', 'local_checksum', 'evidence_digest', 'production_evidence_digest', 'repair_evidence_digest'];
      const disallowedKeys = [
        'evidence', 'durable_evidence_summary', 'recommended_action',
        'filename', 'version', 'repair_status', 'confidence', 'current_classification',
      ];
      const hexValue = 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789';

      for (const key of allowedKeys) {
        const line = `+    "${key}": "${hexValue}",`;
        expect(EXEMPTION_KEY_REGEX.test(line)).toBe(true);
      }

      for (const key of disallowedKeys) {
        const line = `+    "${key}": "${hexValue}",`;
        expect(EXEMPTION_KEY_REGEX.test(line)).toBe(false);
      }
    });

    it('does NOT exempt a checksum with uppercase hex characters', () => {
      const line = '+    "checksum": "690EA3C8583954F4319F4D3E62C3ADB8E1E093FBDEA74EEDDDE1B48BB1F14149",';
      expect(EXEMPTION_KEY_REGEX.test(line)).toBe(false);
    });

    it('does NOT exempt a checksum shorter than 64 characters', () => {
      const line = '+    "checksum": "690ea3c8583954f4319f4d3e62c3adb8",';
      expect(EXEMPTION_KEY_REGEX.test(line)).toBe(false);
    });
  });

  describe('Path scoping', () => {
    it('docs/migrations/manifest.json matches the exempt path', () => {
      expect(MIGRATION_JSON_PATH.test('docs/migrations/manifest.json')).toBe(true);
    });

    it('docs/migrations/101-246-repair-allowlist.json matches the exempt path', () => {
      expect(MIGRATION_JSON_PATH.test('docs/migrations/101-246-repair-allowlist.json')).toBe(true);
    });

    it('package.json does NOT match the exempt path', () => {
      expect(MIGRATION_JSON_PATH.test('package.json')).toBe(false);
    });

    it('src/config.json does NOT match the exempt path', () => {
      expect(MIGRATION_JSON_PATH.test('src/config.json')).toBe(false);
    });

    it('docs/other/manifest.json does NOT match the exempt path', () => {
      expect(MIGRATION_JSON_PATH.test('docs/other/manifest.json')).toBe(false);
    });

    it('docs/migrations/evidence/batch-01.json matches the exempt path', () => {
      expect(MIGRATION_JSON_PATH.test('docs/migrations/evidence/batch-01.json')).toBe(true);
    });

    it('docs/migrations/subdir/file.json does NOT match the exempt path (non-evidence subdir)', () => {
      expect(MIGRATION_JSON_PATH.test('docs/migrations/subdir/file.json')).toBe(false);
    });
  });

  describe('Filter script integration', () => {
    const TWILIO_SID_PATTERN = 'AC[0-9a-f]{32}';

    it('exempts checksum in docs/migrations/evidence/batch-01.json', () => {
      const checksumValue = EXEMPT_CHECKSUM;
      const diff = buildDiff('docs/migrations/evidence/batch-01.json', [
        `    "checksum": "${checksumValue}",`,
      ]);
      const output = runFilter(diff, TWILIO_SID_PATTERN);
      expect(output).toBe('');
    });

    it('exempts production_evidence_digest in docs/migrations/allowlist.json', () => {
      const checksumValue = EXEMPT_CHECKSUM;
      const diff = buildDiff('docs/migrations/allowlist.json', [
        `    "production_evidence_digest": "${checksumValue}",`,
      ]);
      const output = runFilter(diff, TWILIO_SID_PATTERN);
      expect(output).toBe('');
    });

    it('exempts repair_evidence_digest in docs/migrations/manifest.json', () => {
      const checksumValue = EXEMPT_CHECKSUM;
      const diff = buildDiff('docs/migrations/manifest.json', [
        `    "repair_evidence_digest": "${checksumValue}",`,
      ]);
      const output = runFilter(diff, TWILIO_SID_PATTERN);
      expect(output).toBe('');
    });

    it('exempts checksum in docs/migrations/manifest.json', () => {
      // 64-char lowercase hex starting with 'ac' which triggers Twilio SID pattern (case-insensitive)
      const checksumValue = EXEMPT_CHECKSUM;
      const diff = buildDiff('docs/migrations/manifest.json', [
        `    "checksum": "${checksumValue}",`,
      ]);
      const output = runFilter(diff, TWILIO_SID_PATTERN);
      expect(output).toBe('');
    });

    it('does NOT exempt identical checksum line in package.json', () => {
      const checksumValue = EXEMPT_CHECKSUM;
      const diff = buildDiff('package.json', [
        `    "checksum": "${checksumValue}",`,
      ]);
      const output = runFilter(diff, TWILIO_SID_PATTERN);
      expect(output).not.toBe('');
      expect(output).toContain('package.json');
    });

    it('does NOT exempt identical checksum line in a .ts file', () => {
      const checksumValue = EXEMPT_CHECKSUM;
      const diff = buildDiff('lib/utils.ts', [
        `    "checksum": "${checksumValue}",`,
      ]);
      const output = runFilter(diff, TWILIO_SID_PATTERN);
      expect(output).not.toBe('');
      expect(output).toContain('lib/utils.ts');
    });

    it('detects Twilio token in evidence field even in exempt path', () => {
      const diff = buildDiff('docs/migrations/manifest.json', [
        `    "evidence": "Found ${FAKE_TWILIO_SID} in logs",`,
      ]);
      const output = runFilter(diff, TWILIO_SID_PATTERN);
      expect(output).not.toBe('');
      expect(output).toContain('docs/migrations/manifest.json');
    });

    it('detects token in recommended_action even in exempt path', () => {
      const diff = buildDiff('docs/migrations/manifest.json', [
        `    "recommended_action": "Check ${FAKE_TWILIO_SID} before proceeding",`,
      ]);
      const output = runFilter(diff, TWILIO_SID_PATTERN);
      expect(output).not.toBe('');
    });

    it('detects mixed line with both checksum key and extra token', () => {
      // A line that has the checksum key but also contains extra content after
      const diff = buildDiff('docs/migrations/manifest.json', [
        `    "checksum": "${FAKE_TWILIO_SID}ccddeeff00112233445566778899aabb", "extra": "${FAKE_TWILIO_SID}"`,
      ]);
      const output = runFilter(diff, TWILIO_SID_PATTERN);
      // This line does NOT match the exempt regex because it has extra content after
      expect(output).not.toBe('');
    });

    it('handles empty input gracefully', () => {
      const output = runFilter('', TWILIO_SID_PATTERN);
      expect(output).toBe('');
    });

    it('handles no pattern argument gracefully', () => {
      const diff = buildDiff('docs/migrations/manifest.json', [
        `    "checksum": "${FAKE_TWILIO_SID}ccddeeff00112233445566778899aabb",`,
      ]);
      try {
        const output = execSync(`node ${SCRIPT_PATH}`, {
          input: diff,
          encoding: 'utf-8',
          timeout: 5000,
        }).trim();
        // Should exit cleanly with no output
        expect(output).toBe('');
      } catch (e: unknown) {
        const err = e as { status?: number };
        expect(err.status).toBe(0);
      }
    });
  });

  describe('Context-aware SHA exemption', () => {
    const TWILIO_SID_PATTERN = 'AC[0-9a-f]{32}';

    // 1. JSON digest fields remain allowed
    it('allows recognized JSON digest field in prose file', () => {
      const diff = buildDiff('scripts/validate-migration-repair-allowlist.mjs', [
        `    "migration_evidence_digest": "${EXEMPT_CHECKSUM}",`,
      ]);
      const output = runFilter(diff, TWILIO_SID_PATTERN);
      expect(output).toBe('');
    });

    // 2. Validator SHA constants remain allowed
    it('allows validator SHA constant assignment', () => {
      const diff = buildDiff('scripts/validate-migration-repair-allowlist.mjs', [
        `const WAVE2_BATCH8_SHA = '${EXEMPT_CHECKSUM}';`,
      ]);
      const output = runFilter(diff, TWILIO_SID_PATTERN);
      expect(output).toBe('');
    });

    // 3. Markdown SHA-labelled values remain allowed
    it('allows Markdown SHA-256 labelled value', () => {
      const diff = buildDiff('docs/ENGINEERING_STATUS.md', [
        `Batch 8 SHA-256: \`${EXEMPT_CHECKSUM}\``,
      ]);
      const output = runFilter(diff, TWILIO_SID_PATTERN);
      expect(output).toBe('');
    });

    // 4. Supabase token on same line as allowed SHA is still detected
    it('detects Supabase token on same line as allowed SHA', () => {
      // Build a line that has both a legitimate SHA constant AND a Twilio SID
      const diff = buildDiff('scripts/validate-migration-repair-allowlist.mjs', [
        `const WAVE2_BATCH8_SHA = '${EXEMPT_CHECKSUM}'; // ${FAKE_TWILIO_SID}`,
      ]);
      const output = runFilter(diff, TWILIO_SID_PATTERN);
      expect(output).not.toBe('');
      expect(output).toContain('validate-migration-repair-allowlist.mjs');
    });

    // 5. API key on same line as allowed SHA is still detected
    it('detects API key on same line as allowed SHA in CHANGELOG', () => {
      const diff = buildDiff('CHANGELOG.md', [
        `SHA-256: \`${EXEMPT_CHECKSUM}\` token=${FAKE_TWILIO_SID}`,
      ]);
      const output = runFilter(diff, TWILIO_SID_PATTERN);
      expect(output).not.toBe('');
      expect(output).toContain('CHANGELOG.md');
    });

    // 6. Unlabeled 64-char value is not automatically exempted
    it('does NOT exempt unlabeled 64-char hex in prose file', () => {
      // A line with a 64-char hex that is NOT labelled as SHA/checksum/digest
      // and happens to match a secret pattern
      const diff = buildDiff('CHANGELOG.md', [
        `Some text ${EXEMPT_CHECKSUM} more text`,
      ]);
      const output = runFilter(diff, TWILIO_SID_PATTERN);
      // The EXEMPT_CHECKSUM starts with 'ac' which triggers Twilio SID pattern
      // Since it's not labelled, it should NOT be exempt
      expect(output).not.toBe('');
    });

    // 7. Exemption remains path-scoped
    it('does NOT exempt SHA constant in non-prose file', () => {
      const diff = buildDiff('lib/some-file.ts', [
        `const BATCH_SHA = '${EXEMPT_CHECKSUM}';`,
      ]);
      const output = runFilter(diff, TWILIO_SID_PATTERN);
      // lib/some-file.ts is NOT in the shaProseFileRegex
      expect(output).not.toBe('');
    });
  });
});
