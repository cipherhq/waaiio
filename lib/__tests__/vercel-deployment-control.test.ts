import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Vercel deployment control', () => {
  it.each(['vercel.json', 'admin/vercel.json'])('preserves per-project deployment gating with only the approved tax, directory and admin review exceptions in %s', (file) => {
    const configPath = resolve(process.cwd(), file);
    const config = JSON.parse(readFileSync(configPath, 'utf8')) as {
      git?: { deploymentEnabled?: boolean | Record<string, boolean> };
      ignoreCommand?: string;
    };

    // Owner-approved CI-only branch exceptions (tax, directory, admin fixes). Reject
    // global switches, wildcard rules, and changes to any release branch. Unspecified
    // branches retain Vercel's default and their per-project Ignored Build Step (#614).
    expect(config.git?.deploymentEnabled).toEqual({
      'codex/merchant-tax-phase-a': false,
      'codex/directory-short-links': false,
      'codex/admin-audit-fixes': false,
    });
    expect(config.ignoreCommand).toBeUndefined();
  });
});
