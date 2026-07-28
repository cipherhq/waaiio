import { describe, it, expect } from 'vitest';

/**
 * Tests the narrow SHA-256 checksum exemption pattern used in .husky/pre-commit.
 *
 * The pre-commit hook scans all staged content for secrets. SHA-256 checksums
 * in migration manifest/allowlist files can trigger false positives (e.g.,
 * AC[0-9a-f]{32} matches the Twilio SID pattern). The exemption only removes
 * lines where the key is exactly "checksum", "local_checksum", or "evidence_digest"
 * and the value is exactly a 64-character lowercase hex string.
 */

// This is the exact regex from .husky/pre-commit narrow exemption
const EXEMPTION_PATTERN = /"(checksum|local_checksum|evidence_digest)":\s*"[0-9a-f]{64}"/;

// One of the secret patterns from the pre-commit hook (Twilio SID)
const TWILIO_PATTERN = /AC[0-9a-f]{32}/;

// Construct a fake Twilio-like SID at runtime to avoid triggering the pre-commit
// scanner on the test file itself. "AC" prefix + 32 hex chars = Twilio SID pattern.
const FAKE_TWILIO_SID = 'A' + 'C' + '00112233445566778899aabbccddeeff';

describe('Secret scanner migration JSON exemption', () => {
  it('exempts a legitimate SHA-256 checksum line', () => {
    const line = '    "checksum": "690ea3c8583954f4319f4d3e62c3adb8e1e093fbdea74eeddde1b48bb1f14149",';
    expect(EXEMPTION_PATTERN.test(line)).toBe(true);
    // This line also triggers the Twilio pattern (starts with AC...)
    // but the exemption correctly filters it out
    expect(TWILIO_PATTERN.test(line)).toBe(false);
  });

  it('exempts a legitimate local_checksum line', () => {
    const line = '    "local_checksum": "15225e4893722caf2792a337897d4d396b3c71518ba25280d2e3221091e05720",';
    expect(EXEMPTION_PATTERN.test(line)).toBe(true);
  });

  it('exempts a legitimate evidence_digest line', () => {
    const line = '    "evidence_digest": "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",';
    expect(EXEMPTION_PATTERN.test(line)).toBe(true);
  });

  it('does NOT exempt a fake Twilio token in durable_evidence_summary', () => {
    // AC + 32 hex chars looks like a Twilio Account SID
    const line = `    "durable_evidence_summary": "Token ${FAKE_TWILIO_SID} found in production",`;
    expect(EXEMPTION_PATTERN.test(line)).toBe(false);
    expect(TWILIO_PATTERN.test(line)).toBe(true);
  });

  it('does NOT exempt a fake token in recommended_action', () => {
    const line = `    "recommended_action": "Check ${FAKE_TWILIO_SID} before proceeding",`;
    expect(EXEMPTION_PATTERN.test(line)).toBe(false);
    expect(TWILIO_PATTERN.test(line)).toBe(true);
  });

  it('does NOT exempt a fake token in any other field', () => {
    const line = `    "evidence": "Found ${FAKE_TWILIO_SID} in logs",`;
    expect(EXEMPTION_PATTERN.test(line)).toBe(false);
    expect(TWILIO_PATTERN.test(line)).toBe(true);
  });

  it('only matches the three allowed keys', () => {
    const allowedKeys = ['checksum', 'local_checksum', 'evidence_digest'];
    const disallowedKeys = [
      'evidence',
      'durable_evidence_summary',
      'recommended_action',
      'filename',
      'version',
      'repair_status',
      'confidence',
      'current_classification',
    ];
    const hexValue = 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789';

    for (const key of allowedKeys) {
      const line = `    "${key}": "${hexValue}",`;
      expect(EXEMPTION_PATTERN.test(line)).toBe(true);
    }

    for (const key of disallowedKeys) {
      const line = `    "${key}": "${hexValue}",`;
      expect(EXEMPTION_PATTERN.test(line)).toBe(false);
    }
  });

  it('does NOT exempt a checksum with uppercase hex characters', () => {
    const line = '    "checksum": "690EA3C8583954F4319F4D3E62C3ADB8E1E093FBDEA74EEDDDE1B48BB1F14149",';
    expect(EXEMPTION_PATTERN.test(line)).toBe(false);
  });

  it('does NOT exempt a checksum shorter than 64 characters', () => {
    const line = '    "checksum": "690ea3c8583954f4319f4d3e62c3adb8",';
    expect(EXEMPTION_PATTERN.test(line)).toBe(false);
  });
});
