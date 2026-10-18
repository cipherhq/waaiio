/**
 * Pre-commit secret scanner pattern tests.
 *
 * Feeds synthetic lines through the filter script's combined regex
 * and verifies: real secrets are flagged, common code patterns are not.
 */

import { describe, it, expect } from 'vitest';
import { execSync } from 'child_process';
import { resolve } from 'path';

const SCRIPT = resolve(__dirname, '../../scripts/filter-secret-scan-false-positives.mjs');

/**
 * Build the combined regex from .husky/pre-commit's SECRET_PATTERNS.
 * Read the file and extract patterns between the parentheses.
 */
function loadCombinedPattern(): string {
  const fs = require('fs');
  const hookPath = resolve(__dirname, '../../.husky/pre-commit');
  const content = fs.readFileSync(hookPath, 'utf-8');
  const match = content.match(/SECRET_PATTERNS=\(\n([\s\S]*?)\n\)/);
  if (!match) throw new Error('Could not parse SECRET_PATTERNS from .husky/pre-commit');
  const patterns = match[1]
    .split('\n')
    .map((line: string) => line.trim().replace(/^'|'$/g, ''))
    .filter((p: string) => p.length > 0);
  return patterns.join('|');
}

/**
 * Run the filter script with a fake diff and return flagged lines.
 */
function scanLines(lines: string[], pattern: string): string[] {
  const diff = [
    '+++ b/test-file.ts',
    ...lines.map(l => `+${l}`),
  ].join('\n');

  try {
    const output = execSync(
      `echo "${diff.replace(/"/g, '\\"')}" | node "${SCRIPT}" '${pattern}'`,
      { encoding: 'utf-8', timeout: 5000 },
    );
    return output.trim().split('\n').filter(l => l.length > 0);
  } catch (err: any) {
    // Script exits 0 even with no output; execSync throws on non-zero
    if (err.stdout) return err.stdout.trim().split('\n').filter((l: string) => l.length > 0);
    return [];
  }
}

describe('Pre-commit secret scanner patterns', () => {
  const pattern = loadCombinedPattern();

  it('flags a synthetic SendGrid-format key', () => {
    // Build from parts so this file itself does not contain a key-shaped string
    const prefix = 'SG';
    const seg1 = 'abcdefghij_klmnopqrstu'; // 22 chars
    const seg2 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopq'; // 43 chars
    const syntheticKey = `${prefix}.${seg1}.${seg2}`;
    const flagged = scanLines([`const key = '${syntheticKey}';`], pattern);
    expect(flagged.length).toBe(1);
  });

  it('does NOT flag msg.body.slice, msg.items.map, msg.to', () => {
    const lines = [
      'const truncatedBody = msg.body.slice(0, 1024);',
      'rows: msg.items.map(item => ({',
      '{ recipientPhone: msg.to },',
    ];
    const flagged = scanLines(lines, pattern);
    expect(flagged).toEqual([]);
  });

  it('still flags a Stripe live key line', () => {
    // Build from parts so this file doesn't contain a scannable pattern
    const prefix = ['sk', 'live'].join('_');
    const line = `const key = '${prefix}_abcdef1234567890';`;
    const flagged = scanLines([line], pattern);
    expect(flagged.length).toBe(1);
  });
});
