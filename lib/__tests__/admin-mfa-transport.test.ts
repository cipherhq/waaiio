import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:https';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const trust = vi.hoisted(() => ({ ca: undefined as string | undefined }));
vi.mock('node:https', async importOriginal => {
  const actual = await importOriginal<typeof import('node:https')>();
  return { ...actual, Agent: class extends actual.Agent {
    constructor(options: import('node:https').AgentOptions) { super({ ...options, ca: trust.ca }); }
  } };
});
import { verifyTotpOnSingleConnection } from '../admin-mfa-transport';

const challengeId = '11111111-1111-4111-8111-111111111111';
let dir: string, key: string, cert: string;
let server: Server | undefined;
let requests: string[], sockets: unknown[];
let origin: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'mfa-tls-fixture-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem'), '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost'], { stdio: 'ignore' });
  key = readFileSync(join(dir, 'key.pem'), 'utf8'); cert = readFileSync(join(dir, 'cert.pem'), 'utf8');
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));
afterEach(async () => { if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())); server = undefined; } });
async function start(mode = 'ok') {
  trust.ca = cert; requests = []; sockets = [];
  server = createServer({ key, cert }, (req, res) => {
    requests.push(req.url!); sockets.push(req.socket);
    let body = ''; req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      if (req.url?.endsWith('/challenge')) {
        if (mode === 'close') res.setHeader('Connection', 'close');
        if (mode === 'hang') return;
        res.statusCode = mode === 'http-error' ? 422 : 200;
        res.end(mode === 'malformed' ? 'not-json' : JSON.stringify({ id: mode === 'bad-id' ? 'bad' : challengeId }));
      } else {
        expect(JSON.parse(body)).toEqual({ challenge_id: challengeId, code: '123456' });
        res.end(JSON.stringify(mode === 'missing-session' ? {} : { access_token: 'synthetic-access', refresh_token: 'synthetic-refresh' }));
      }
    });
  });
  await new Promise<void>((resolve, reject) => { server!.once('error', reject); server!.listen(0, '127.0.0.1', resolve); });
  origin = `https://localhost:${(server.address() as import('node:net').AddressInfo).port}`;
}
const options = () => ({ supabaseUrl: origin, anonKey: 'synthetic-public', bearerToken: 'synthetic-bearer', factorId: 'factor-one', code: '123456', bindChallenge: vi.fn(async () => {}) });

describe('request-scoped MFA pair over real local TLS (no live Auth)', () => {
  it('uses the exact same verified TLS socket and binds before sending verify', async () => {
    await start(); const input = options();
    input.bindChallenge.mockImplementation(async () => { expect(requests).toHaveLength(1); });
    await expect(verifyTotpOnSingleConnection(input)).resolves.toEqual({ access_token: 'synthetic-access', refresh_token: 'synthetic-refresh' });
    expect(input.bindChallenge).toHaveBeenCalledWith(challengeId);
    expect(requests).toHaveLength(2); expect(sockets[0]).toBe(sockets[1]);
  });
  it('rejects replacement connection before verify HTTP request reaches server', async () => {
    await start('close');
    await expect(verifyTotpOnSingleConnection(options())).rejects.toThrow('MFA connection changed');
    expect(requests).toEqual(['/auth/v1/factors/factor-one/challenge']);
  });
  it('rejects a socket closed while DB binding awaits, before sending any verify request', async () => {
    await start(); const input = options();
    input.bindChallenge.mockImplementation(async () => {
      await new Promise<void>(resolve => { const socket = sockets[0] as import('node:tls').TLSSocket; socket.once('close', () => resolve()); socket.destroy(); });
      await new Promise(resolve => setTimeout(resolve, 20));
    });
    await expect(verifyTotpOnSingleConnection(input)).rejects.toThrow('MFA connection changed');
    expect(requests).toEqual(['/auth/v1/factors/factor-one/challenge']);
  });
  it('does not send verify when binding fails (zero rows or concurrent loser)', async () => {
    await start(); const input = options(); input.bindChallenge.mockRejectedValue(new Error('zero rows'));
    await expect(verifyTotpOnSingleConnection(input)).rejects.toThrow('zero rows');
    expect(requests).toHaveLength(1);
  });
  it('rejects an untrusted certificate before any HTTP request', async () => {
    await start(); trust.ca = undefined;
    await expect(verifyTotpOnSingleConnection(options())).rejects.toThrow();
    expect(requests).toHaveLength(0);
  });
  it.each(['malformed', 'bad-id', 'http-error'])('rejects %s challenge evidence without binding or verification', async mode => {
    await start(mode); const input = options();
    await expect(verifyTotpOnSingleConnection(input)).rejects.toThrow();
    expect(input.bindChallenge).not.toHaveBeenCalled(); expect(requests).toHaveLength(1);
  });
  it('rejects missing rotated session', async () => {
    await start('missing-session'); await expect(verifyTotpOnSingleConnection(options())).rejects.toThrow('Missing MFA session');
  });
  it('deadline includes a stalled DB binding and never sends verification', async () => {
    await start(); const input = options(); input.bindChallenge.mockImplementation(() => new Promise(() => {}));
    await expect(verifyTotpOnSingleConnection(input)).rejects.toThrow('timed out');
    expect(requests).toHaveLength(1);
  }, 15_000);
});
