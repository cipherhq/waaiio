import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Vercel deployment control', () => {
  it('delegates deployment gating to per-project dashboard Ignored Build Step', () => {
    const configPath = resolve(process.cwd(), 'vercel.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8')) as {
      git?: { deploymentEnabled?: boolean };
      ignoreCommand?: string;
    };

    // vercel.json must NOT contain git.deploymentEnabled or ignoreCommand.
    // Both settings override ALL projects sharing this root directory and
    // cannot distinguish git-triggered from manual deploys. Per-project
    // Ignored Build Step in the Vercel dashboard is the correct mechanism.
    // See PR #614 for the full rationale.
    expect(config.git?.deploymentEnabled).toBeUndefined();
    expect(config.ignoreCommand).toBeUndefined();
  });
});
