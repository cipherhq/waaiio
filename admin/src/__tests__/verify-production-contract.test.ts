/**
 * Verify-production script contract test (#292)
 *
 * Proves the committed verifier module exists, is importable from the
 * admin package, and has deterministic success/failure semantics.
 * Does NOT launch a real browser — that happens during deployment.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';

const SCRIPT_PATH = resolve(__dirname, '../../scripts/verify-production.mjs');

describe('verify-production contract (#292)', () => {
  it('script file exists and is committed', () => {
    expect(existsSync(SCRIPT_PATH)).toBe(true);
  });

  it('script imports playwright from package dependency, not ambient', () => {
    const source = readFileSync(SCRIPT_PATH, 'utf-8');
    expect(source).toContain("import { chromium } from 'playwright'");
    // Must NOT use /tmp or mktemp
    expect(source).not.toContain('mktemp');
    expect(source).not.toContain('/tmp/');
  });

  it('script checks for Supabase initialization crash patterns', () => {
    const source = readFileSync(SCRIPT_PATH, 'utf-8');
    expect(source).toContain('Invalid supabaseUrl');
    expect(source).toContain('supabaseUrl is required');
    expect(source).toContain('supabaseUrl: Must be a valid');
  });

  it('script waits for SPA mount (#root > *)', () => {
    const source = readFileSync(SCRIPT_PATH, 'utf-8');
    expect(source).toContain('#root > *');
  });

  it('script exits non-zero on failure paths', () => {
    const source = readFileSync(SCRIPT_PATH, 'utf-8');
    // Count process.exit(1) calls — must have multiple failure paths
    const exitCalls = (source.match(/process\.exit\(1\)/g) || []).length;
    expect(exitCalls).toBeGreaterThanOrEqual(4); // HTTP, mount, supabase errors, content
  });

  it('playwright is declared in admin package.json devDependencies', () => {
    const pkgPath = resolve(__dirname, '../../package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    expect(pkg.devDependencies).toHaveProperty('playwright');
  });

  it('deploy script uses committed verifier, not /tmp inline', () => {
    const deployPath = resolve(__dirname, '../../scripts/deploy-production.sh');
    const deploy = readFileSync(deployPath, 'utf-8');
    expect(deploy).toContain('verify-production.mjs');
    expect(deploy).not.toContain('mktemp /tmp/admin-smoke');
  });

  it('deploy script installs Chromium in pre-deploy preflight, not post-promotion', () => {
    const deployPath = resolve(__dirname, '../../scripts/deploy-production.sh');
    const deploy = readFileSync(deployPath, 'utf-8');
    // Chromium install + preflight check before deployment section
    const chromiumIdx = deploy.indexOf('playwright install chromium');
    const deployIdx = deploy.indexOf('Deploying to production');
    expect(chromiumIdx).toBeGreaterThan(-1);
    expect(deployIdx).toBeGreaterThan(chromiumIdx);
  });

  it('verify:production script uses && (fail-closed), not ; (continue on failure)', () => {
    const pkgPath = resolve(__dirname, '../../package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    const cmd = pkg.scripts['verify:production'];
    expect(cmd).toContain('&&');
    expect(cmd).not.toContain(';');
  });
});
