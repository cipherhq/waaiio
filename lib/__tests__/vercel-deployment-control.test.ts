import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Vercel deployment control', () => {
  it('requires explicit deployments instead of Git-triggered auto-deploys', () => {
    const configPath = resolve(process.cwd(), 'vercel.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8')) as {
      git?: { deploymentEnabled?: boolean };
      ignoreCommand?: string;
    };

    expect(config.git?.deploymentEnabled).toBe(false);
    expect(config.ignoreCommand).toBeUndefined();
  });
});
