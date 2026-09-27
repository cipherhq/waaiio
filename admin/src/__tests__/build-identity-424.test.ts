import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
  normalizeAdminBuildIdentity,
  shortBuildId,
} from '@/lib/buildIdentity';

describe('#424 Admin build identity contract', () => {
  it('uses explicit Waaiio staging identity even when Vercel target is production', () => {
    const identity = normalizeAdminBuildIdentity({
      logicalEnvironment: 'staging',
      vercelTarget: 'production',
      commitSha: 'abcdef1234567890',
      deploymentId: 'dpl_123456789',
      projectId: 'prj_staging123',
      apiUrl: 'https://staging.waaiio.example/api/path',
    });

    expect(identity.logicalEnvironment).toBe('staging');
    expect(identity.verified).toBe(true);
    expect(identity.vercelTarget).toBe('production');
    expect(identity.apiOrigin).toBe('https://staging.waaiio.example');
  });

  it('uses explicit production identity when configured', () => {
    const identity = normalizeAdminBuildIdentity({
      logicalEnvironment: 'PRODUCTION',
      vercelTarget: 'production',
      commitSha: '1234567890abcdef',
      apiUrl: 'https://www.waaiio.com',
    });

    expect(identity.logicalEnvironment).toBe('production');
    expect(identity.verified).toBe(true);
    expect(identity.commitSha).toBe('1234567890abcdef');
    expect(identity.apiOrigin).toBe('https://www.waaiio.com');
  });

  it('fails visibly to unverified when the logical environment is missing', () => {
    const identity = normalizeAdminBuildIdentity({
      vercelTarget: 'production',
      projectId: 'prj_some_project',
    });

    expect(identity.logicalEnvironment).toBe('unverified');
    expect(identity.verified).toBe(false);
    expect(identity.vercelTarget).toBe('production');
  });

  it('fails visibly to unverified for an unsupported logical environment', () => {
    const identity = normalizeAdminBuildIdentity({
      logicalEnvironment: 'prod-ish',
      vercelTarget: 'production',
    });

    expect(identity.logicalEnvironment).toBe('unverified');
    expect(identity.verified).toBe(false);
  });

  it('does not expose a malformed API URL as an origin', () => {
    const identity = normalizeAdminBuildIdentity({
      logicalEnvironment: 'development',
      apiUrl: 'not-a-url',
    });

    expect(identity.apiOrigin).toBeNull();
  });

  it('shortens long build IDs deterministically', () => {
    expect(shortBuildId('abcdef1234567890')).toBe('abcdef1234');
    expect(shortBuildId('short')).toBe('short');
    expect(shortBuildId(null)).toBe('unknown');
  });

  it('build config requires explicit Waaiio environment and does not infer from browser hostname', () => {
    const config = readFileSync(resolve(__dirname, '../../vite.config.js'), 'utf-8');

    expect(config).toContain('WAAIIO_ENVIRONMENT');
    expect(config).toContain('VITE_WAAIIO_ENVIRONMENT');
    expect(config).toContain("'unverified'");
    expect(config).not.toContain('window.location.hostname');
  });
});
