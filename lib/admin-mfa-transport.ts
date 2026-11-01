import { Agent, request } from 'node:https';
import type { TLSSocket } from 'node:tls';

interface MfaPairOptions {
  supabaseUrl: string;
  anonKey: string;
  bearerToken: string;
  factorId: string;
  code: string;
  bindChallenge: (id: string) => Promise<void>;
}

/** Server-only, one attempt and one TLS connection. Never shares user sessions.
 * A replacement socket is rejected before HTTP headers or code are written.
 * TLS certificate/hostname validation uses Node's normal trust configuration.
 */
export async function verifyTotpOnSingleConnection(options: MfaPairOptions): Promise<{
  access_token: string; refresh_token: string;
}> {
  const origin = new URL(options.supabaseUrl);
  if (origin.protocol !== 'https:' || origin.username || origin.password ||
      origin.pathname !== '/' || origin.search || origin.hash) throw new Error('Invalid Auth origin');
  const agent = new Agent({ keepAlive: true, maxSockets: 1, maxFreeSockets: 1 });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  let challengeSocket: TLSSocket | undefined;
  const post = (path: string, body: object, verify: boolean): Promise<Record<string, unknown>> =>
    new Promise((resolve, reject) => {
      if (controller.signal.aborted) return reject(new Error('MFA attempt timed out'));
      const req = request(new URL(path, origin), {
        method: 'POST', agent, signal: controller.signal,
        headers: { Authorization: `Bearer ${options.bearerToken}`, apikey: options.anonKey,
          'Content-Type': 'application/json' },
      }, res => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', chunk => {
          size += chunk.length;
          if (size > 64 * 1024) { res.destroy(new Error('MFA response too large')); return; }
          chunks.push(Buffer.from(chunk));
        });
        res.on('error', reject);
        res.on('end', () => {
          if (res.statusCode !== 200) return reject(new Error('MFA request failed'));
          try {
            const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
            resolve(value);
          } catch { reject(new Error('Invalid MFA response')); }
        });
      });
      req.on('error', reject);
      req.on('socket', socket => {
        const tlsSocket = socket as TLSSocket;
        if (verify && (!challengeSocket || socket !== challengeSocket || socket.destroyed ||
            !req.reusedSocket || !tlsSocket.authorized)) {
          req.destroy(new Error('MFA connection changed'));
          return;
        }
        if (!verify) challengeSocket = tlsSocket;
        // No write/end/flushHeaders occurs before the socket identity check.
        req.end(JSON.stringify(body));
      });
    });
  try {
    const path = `/auth/v1/factors/${encodeURIComponent(options.factorId)}`;
    const challenge = await post(`${path}/challenge`, {}, false);
    if (typeof challenge.id !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(challenge.id)) {
      throw new Error('Invalid MFA challenge');
    }
    // Deadline covers persistence as well as both network requests. A late DB
    // write may bind a non-consumable grant but must never start verification.
    await Promise.race([
      options.bindChallenge(challenge.id),
      new Promise<never>((_, reject) => {
        if (controller.signal.aborted) reject(new Error('MFA attempt timed out'));
        else controller.signal.addEventListener('abort', () => reject(new Error('MFA attempt timed out')), { once: true });
      }),
    ]);
    const session = await post(`${path}/verify`, { challenge_id: challenge.id, code: options.code }, true);
    if (typeof session.access_token !== 'string' || !session.access_token ||
        typeof session.refresh_token !== 'string' || !session.refresh_token) throw new Error('Missing MFA session');
    return { access_token: session.access_token, refresh_token: session.refresh_token };
  } finally {
    clearTimeout(timer);
    controller.abort();
    agent.destroy();
  }
}
