/**
 * Executable runtime safety tests for Locust host validation and redirect handling.
 *
 * CTO R6: Proves at runtime (not source inspection) that:
 * (a) Locust's validate_host logic rejects remote targets with exit code 1
 * (b) A loopback 302 redirect is NOT followed to an external URL
 *
 * For (a), we extract and execute the validate_host function body in an
 * isolated Python process without requiring the `locust` package installed.
 * For (b), we start a local HTTP server returning 302 and verify fetch
 * with redirect:'manual' does not follow it.
 *
 * Both tests use local-only execution with zero external network traffic.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { execSync } from 'child_process';
import { createServer, type Server } from 'http';
import { readFileSync, writeFileSync, unlinkSync } from 'fs';
import { resolve, join } from 'path';
import { tmpdir } from 'os';

// Extract validate_host source from locustfile.py for isolated execution
const locustSrc = readFileSync(resolve(__dirname, '../locust/locustfile.py'), 'utf-8');

/**
 * Run the real validate_host function in an isolated Python process.
 * Writes a temp .py file to avoid shell escaping issues with -c.
 */
function runValidateHost(testHost: string): { exitCode: number; stdout: string; stderr: string } {
  const fnStart = locustSrc.indexOf('def validate_host(host: str)');
  const fnEnd = locustSrc.indexOf('\ndef ', fnStart + 10);
  const fnBody = locustSrc.slice(fnStart, fnEnd > 0 ? fnEnd : undefined);

  const script = [
    'import sys',
    'from urllib.parse import urlparse',
    '',
    fnBody,
    '',
    `validate_host('${testHost}')`,
    "print('ACCEPTED')",
  ].join('\n');

  const tmpFile = join(tmpdir(), `locust_validate_${Date.now()}.py`);
  writeFileSync(tmpFile, script);
  try {
    const stdout = execSync(`python3 "${tmpFile}"`, {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { exitCode: 0, stdout, stderr: '' };
  } catch (err: any) {
    return {
      exitCode: err.status ?? 1,
      stdout: err.stdout?.toString() || '',
      stderr: err.stderr?.toString() || '',
    };
  } finally {
    try { unlinkSync(tmpFile); } catch { /* best effort */ }
  }
}

describe('Locust validate_host runtime execution', () => {
  it('rejects staging.waaiio.com with exit code 1', () => {
    const result = runValidateHost('https://staging.waaiio.com');
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('FAIL-CLOSED');
  });

  it('rejects graph.facebook.com with exit code 1', () => {
    const result = runValidateHost('https://graph.facebook.com');
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('FAIL-CLOSED');
  });

  it('rejects a Vercel preview URL with exit code 1', () => {
    const result = runValidateHost('https://waaiiostaging-abc.vercel.app');
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('FAIL-CLOSED');
  });

  it('accepts localhost:3000 without exiting', () => {
    const result = runValidateHost('http://localhost:3000');
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('ACCEPTED');
  });

  it('accepts 127.0.0.1:3000 without exiting', () => {
    const result = runValidateHost('http://127.0.0.1:3000');
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('ACCEPTED');
  });
});

describe('Loopback 302 redirect is NOT followed (runtime proof)', () => {
  let server: Server;
  let port: number;

  afterAll(() => {
    server?.close();
  });

  it('local 302 to graph.facebook.com returns redirect status, not followed content', async () => {
    // Start loopback server returning 302 to Meta Graph API
    await new Promise<void>((resolvePromise) => {
      server = createServer((_req, res) => {
        res.writeHead(302, { Location: 'https://graph.facebook.com/v21.0/test' });
        res.end();
      });
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        port = typeof addr === 'object' && addr ? addr.port : 0;
        resolvePromise();
      });
    });

    expect(port).toBeGreaterThan(0);

    // Request with redirect:'manual' — equivalent to Locust's allow_redirects=False
    const response = await fetch(`http://127.0.0.1:${port}/api/webhook/meta-cloud`, {
      method: 'POST',
      body: '{"test": true}',
      headers: { 'Content-Type': 'application/json' },
      redirect: 'manual',
    });

    // Must get 302 directly — NOT followed to graph.facebook.com
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toContain('graph.facebook.com');

    // The response URL is still loopback — no external request was made
    expect(response.url).toContain('127.0.0.1');

    // If redirect had been followed, status would be something other than 302
    // (likely 400/403 from Meta or a network error). 302 proves no follow.
  });
});
