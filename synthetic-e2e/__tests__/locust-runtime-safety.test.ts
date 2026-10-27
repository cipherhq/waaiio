/**
 * Executable runtime safety tests for Locust host validation and redirect handling.
 *
 * CTO R7: Proves at runtime that:
 * (a) Locust's validate_host rejects remote targets (Python subprocess)
 * (b) SyntheticCustomer._send_text passes allow_redirects=False and a
 *     loopback 302 redirect is not followed (Python subprocess with
 *     extracted _send_text, loopback 302 server, spy client)
 *
 * Both tests run entirely in Python subprocesses. Zero external traffic.
 */

import { describe, it, expect } from 'vitest';
import { execSync } from 'child_process';
import { readFileSync, writeFileSync, unlinkSync } from 'fs';
import { resolve, join } from 'path';
import { tmpdir } from 'os';

const locustSrc = readFileSync(resolve(__dirname, '../locust/locustfile.py'), 'utf-8');

/** Extract a Python function from locustfile.py source by name. */
function extractPythonFn(name: string): string {
  const start = locustSrc.indexOf(`def ${name}(`);
  if (start === -1) throw new Error(`Function ${name} not found`);
  // Find end: next top-level def, class, or decorator (@)
  let end = -1;
  for (const marker of ['\ndef ', '\nclass ', '\n@']) {
    const idx = locustSrc.indexOf(marker, start + 10);
    if (idx !== -1 && (end === -1 || idx < end)) end = idx;
  }
  if (end === -1) end = locustSrc.length;
  return locustSrc.slice(start, end).trimEnd();
}

/** Run a Python script via temp file, return exit/stdout/stderr. */
function runPython(script: string): { exitCode: number; stdout: string; stderr: string } {
  const tmpFile = join(tmpdir(), `locust_test_${Date.now()}_${Math.random().toString(36).slice(2,6)}.py`);
  writeFileSync(tmpFile, script);
  try {
    const stdout = execSync(`python3 "${tmpFile}"`, {
      encoding: 'utf-8',
      timeout: 10000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { exitCode: 0, stdout, stderr: '' };
  } catch (err: any) {
    return { exitCode: err.status ?? 1, stdout: err.stdout?.toString() || '', stderr: err.stderr?.toString() || '' };
  } finally {
    try { unlinkSync(tmpFile); } catch { /* best effort */ }
  }
}

// ── validate_host runtime tests ──

describe('Locust validate_host runtime execution', () => {
  const validateHostFn = extractPythonFn('validate_host');

  function runValidateHost(host: string) {
    return runPython([
      'import sys',
      'from urllib.parse import urlparse',
      '',
      validateHostFn,
      '',
      `validate_host('${host}')`,
      "print('ACCEPTED')",
    ].join('\n'));
  }

  it('rejects staging.waaiio.com with exit 1', () => {
    const r = runValidateHost('https://staging.waaiio.com');
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('FAIL-CLOSED');
  });

  it('rejects graph.facebook.com with exit 1', () => {
    const r = runValidateHost('https://graph.facebook.com');
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('FAIL-CLOSED');
  });

  it('rejects Vercel preview with exit 1', () => {
    const r = runValidateHost('https://waaiiostaging-abc.vercel.app');
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('FAIL-CLOSED');
  });

  it('accepts localhost:3000', () => {
    const r = runValidateHost('http://localhost:3000');
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('ACCEPTED');
  });

  it('accepts 127.0.0.1:3000', () => {
    const r = runValidateHost('http://127.0.0.1:3000');
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('ACCEPTED');
  });
});

// ── _send_text 302 redirect runtime test ──

describe('SyntheticCustomer._send_text 302 redirect proof', () => {

  it('_send_text passes allow_redirects=False; loopback 302 not followed; one request', () => {
    // Extract _send_text, build_text_message, sign_payload from source.
    // Run in Python: loopback 302 server + spy client + extracted _send_text.
    const sendTextFn = extractPythonFn('_send_text');
    const buildMsgFn = extractPythonFn('build_text_message');
    const signFn = extractPythonFn('sign_payload');

    // Indent _send_text for use inside a class
    const indentedSendText = sendTextFn.split('\n').map(line => '    ' + line).join('\n');

    const script = `
import sys, json, types, threading, hashlib, hmac, time, uuid
from http.server import HTTPServer, BaseHTTPRequestHandler
import http.client as hc

# ── Loopback 302 server ──
request_log = []
class H(BaseHTTPRequestHandler):
    def do_POST(self):
        cl = int(self.headers.get('Content-Length', 0))
        self.rfile.read(cl)
        request_log.append(self.path)
        self.send_response(302)
        self.send_header('Location', 'https://graph.facebook.com/v21.0/test')
        self.end_headers()
    def log_message(self, *a): pass

srv = HTTPServer(('127.0.0.1', 0), H)
port = srv.server_address[1]
t = threading.Thread(target=srv.handle_request, daemon=True)
t.start()

# ── Extracted functions ──
${buildMsgFn}

${signFn}

# ── Spy client (http.client never auto-follows redirects) ──
class SpyClient:
    def __init__(self, host, port):
        self._h, self._p = host, port
        self.calls = []
    def post(self, path, **kw):
        self.calls.append({
            'path': path,
            'allow_redirects': kw.get('allow_redirects'),
        })
        conn = hc.HTTPConnection(self._h, self._p, timeout=3)
        body = kw.get('data', b'')
        if isinstance(body, str): body = body.encode()
        conn.request('POST', path, body=body, headers=kw.get('headers', {}))
        r = conn.getresponse(); r.read(); s = r.status; conn.close()
        return types.SimpleNamespace(status_code=s)

# ── Globals required by _send_text ──
_request_count = 0
_start_time = None
MAX_RPS = 5

# ── Class with extracted _send_text ──
class TestCustomer:
    def __init__(self):
        self.meta_app_secret = 'test_secret'
        self.phone_number_id = '123456789'
        self.from_phone = '15550009999'
        self.message_count = 0
        self.client = SpyClient('127.0.0.1', port)
${indentedSendText}

c = TestCustomer()
c._send_text('Hi')
t.join(timeout=2)
srv.server_close()

# ── Assertions ──
r = {'passed': True, 'failures': []}
if len(c.client.calls) != 1:
    r['passed'] = False; r['failures'].append(f'calls={len(c.client.calls)}')
elif c.client.calls[0]['allow_redirects'] is not False:
    r['passed'] = False; r['failures'].append(f'allow_redirects={c.client.calls[0]["allow_redirects"]}')
elif c.client.calls[0]['path'] != '/api/webhook/meta-cloud':
    r['passed'] = False; r['failures'].append(f'path={c.client.calls[0]["path"]}')
if len(request_log) != 1:
    r['passed'] = False; r['failures'].append(f'server_reqs={len(request_log)}')
if c.message_count != 1:
    r['passed'] = False; r['failures'].append(f'mc={c.message_count}')
print(json.dumps(r))
`;

    const result = runPython(script);

    if (result.exitCode !== 0) {
      throw new Error(`Python _send_text test failed (exit ${result.exitCode}): ${result.stderr}`);
    }

    const assertions = JSON.parse(result.stdout.trim());
    if (!assertions.passed) {
      throw new Error(`_send_text 302 failures: ${assertions.failures.join('; ')}`);
    }
    expect(assertions.passed).toBe(true);
  });
});
