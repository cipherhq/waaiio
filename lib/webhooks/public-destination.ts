import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

const blocked = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) blocked.addSubnet(address, prefix, 'ipv4');
const globalV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');
for (const [address, prefix] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]] as const) {
  blocked.addSubnet(address, prefix, 'ipv6');
}

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !blocked.check(address, 'ipv4');
  return family === 6 && globalV6.check(address, 'ipv6') && !blocked.check(address, 'ipv6');
}

export async function validateWebhookDestination(value: unknown) {
  if (typeof value !== 'string') throw new Error('Webhook URL must be a public HTTP(S) URL');
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Webhook URL must be a public HTTP(S) URL');
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const family = isIP(hostname);
  const addresses = family ? [{ address: hostname, family }] : await lookup(hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) {
    throw new Error('Webhook destination is not public');
  }
  return { url, address: addresses[0].address, family: addresses[0].family };
}

/** Resolve and pin each hop: validation cannot be bypassed by a second DNS lookup. */
export async function sendPublicWebhook(value: string, headers: Record<string, string>, body: string) {
  const signal = AbortSignal.timeout(10_000);
  let target = value;
  let method = 'POST';
  for (let hop = 0; hop <= 20; hop++) {
    let onAbort: (() => void) | undefined;
    const destination = await Promise.race([
      validateWebhookDestination(target),
      new Promise<never>((_, reject) => {
        onAbort = () => reject(new Error('Webhook request timed out'));
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      }),
    ]).finally(() => { if (onAbort) signal.removeEventListener('abort', onAbort); });
    const result = await new Promise<{ status: number; location?: string; text: string }>((resolve, reject) => {
      const request = destination.url.protocol === 'https:' ? httpsRequest : httpRequest;
      const req = request(destination.url, {
        method, headers: method === 'POST' ? headers : {}, signal, agent: false,
        lookup: (_hostname, options, callback) => {
          // Node may request an array for autoSelectFamily. Never call DNS here.
          if (typeof options === 'object' && options.all) {
            callback(null, [{ address: destination.address, family: destination.family }]);
          } else callback(null, destination.address, destination.family);
        },
      }, (res) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        let finished = false;
        const finish = () => {
          if (finished) return;
          finished = true;
          resolve({ status: res.statusCode || 0, location: res.headers.location, text: Buffer.concat(chunks).toString('utf8') });
        };
        res.on('data', (chunk: Buffer) => {
          const remaining = 2000 - bytes;
          chunks.push(Buffer.from(chunk).subarray(0, remaining));
          bytes += Math.min(chunk.length, remaining);
          if (bytes >= 2000) { finish(); res.destroy(); }
        });
        res.on('end', finish);
        res.on('error', reject);
      });
      req.on('error', reject);
      req.end(method === 'POST' ? body : undefined);
    });
    if (![301, 302, 303, 307, 308].includes(result.status) || !result.location) return result;
    if (hop === 20) throw new Error('Too many webhook redirects');
    target = new URL(result.location, destination.url).href;
    if ([301, 302, 303].includes(result.status)) method = 'GET';
  }
  throw new Error('Too many webhook redirects');
}
