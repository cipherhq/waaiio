/**
 * Executable browser verifier proof (#292)
 *
 * Proves verify-production.mjs can distinguish a healthy page from
 * a broken one by running it against a local test server.
 * Uses async child_process to avoid blocking the event loop (the test
 * server must accept connections while the verifier runs).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'child_process';
import { createServer, type Server } from 'http';
import { resolve } from 'path';

const VERIFIER = resolve(__dirname, '../../scripts/verify-production.mjs');
const ADMIN_DIR = resolve(__dirname, '../..');

const HEALTHY_HTML = `<!DOCTYPE html><html><head><title>Admin</title></head><body>
<div id="root"><div class="app"><h1>Waaiio Admin</h1>
<form><input type="email" placeholder="Email"/><input type="password" placeholder="Password"/>
<button type="submit">Sign In</button></form>
<p>Platform administration console for managing businesses, payments, subscriptions, and operations.</p>
</div></div></body></html>`;

const BROKEN_HTML = `<!DOCTYPE html><html><head><title>Admin</title></head><body>
<div id="root"></div>
<script>
setTimeout(function() {
  throw new Error("Invalid supabaseUrl: Must be a valid HTTP or HTTPS URL.");
}, 50);
</script></body></html>`;

let healthyServer: Server;
let brokenServer: Server;
let healthyPort: number;
let brokenPort: number;

function startServer(html: string): Promise<{ server: Server; port: number }> {
  return new Promise((res) => {
    const server = createServer((req, resp) => {
      resp.writeHead(200, { 'Content-Type': 'text/html' });
      resp.end(html);
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      res({ server, port });
    });
  });
}

function runVerifier(url: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((res) => {
    execFile('node', [VERIFIER, url], { cwd: ADMIN_DIR, timeout: 25000 }, (err, stdout, stderr) => {
      res({ code: err ? (err as { code?: number }).code || 1 : 0, stdout, stderr });
    });
  });
}

// Check if Playwright + Chromium are available
let canRunBrowser = false;
try {
  const { execSync } = await import('child_process');
  execSync(
    'node -e "import(\'playwright\').then(async p => { const b = await p.chromium.launch({headless:true}); await b.close(); })"',
    { cwd: ADMIN_DIR, timeout: 15000, stdio: 'pipe' },
  );
  canRunBrowser = true;
} catch {
  // Skip
}

describe.skipIf(!canRunBrowser)('verify-production.mjs executable proof (#292)', () => {
  beforeAll(async () => {
    const h = await startServer(HEALTHY_HTML);
    healthyServer = h.server;
    healthyPort = h.port;

    const b = await startServer(BROKEN_HTML);
    brokenServer = b.server;
    brokenPort = b.port;
  });

  afterAll(() => {
    healthyServer?.close();
    brokenServer?.close();
  });

  it('exits 0 for a healthy SPA page', async () => {
    const result = await runVerifier(`http://127.0.0.1:${healthyPort}`);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('PASS');
  }, 30000);

  it('exits non-zero for a broken page (empty root + Supabase crash)', async () => {
    const result = await runVerifier(`http://127.0.0.1:${brokenPort}`);
    expect(result.code).not.toBe(0);
  }, 30000);
});
