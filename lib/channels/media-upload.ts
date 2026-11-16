/**
 * Server-side media fetch for WhatsApp uploads (#1070).
 *
 * Images and documents sent by `link` are fetched by Meta asynchronously, so a
 * later text message can reach the phone first. Uploading the file first and
 * sending it by media id removes that delay. This module decides which URLs the
 * server may fetch for that upload and fetches them with strict bounds.
 *
 * SSRF boundary: only https URLs on this app's own host (NEXT_PUBLIC_APP_URL,
 * plus its www/apex twin) or this project's Supabase Storage paths are ever
 * fetched. Merchant-supplied URLs on any other host are never fetched here;
 * they keep the existing `link` send. Redirects are followed manually and only
 * to another allowlisted URL. Any failure returns null and the caller falls
 * back to the `link` send.
 */

export type UploadMediaKind = 'image' | 'document';

/** WhatsApp Cloud API image limit is 5 MB. */
export const MAX_IMAGE_UPLOAD_BYTES = 5 * 1024 * 1024;
/** WhatsApp allows 100 MB documents; our receipts/tickets are small, so cap well below. */
export const MAX_DOCUMENT_UPLOAD_BYTES = 16 * 1024 * 1024;
/** One budget for fetch + upload together; past it the `link` send is used. */
export const MEDIA_UPLOAD_BUDGET_MS = 6000;
/**
 * Total upload time allowed per MetaCloudService (one per resolved request). Uploads run
 * inside ticket emission windows on 60 s payment webhooks, so a large party must never
 * spend unbounded time uploading; past this every send uses `link` immediately.
 */
export const MEDIA_UPLOAD_TOTAL_BUDGET_MS = 10_000;
/** Below this remaining allowance an upload is not attempted. */
const MIN_UPLOAD_SLICE_MS = 1000;
export function nextUploadSliceMs(spentMs: number): number {
  const remaining = MEDIA_UPLOAD_TOTAL_BUDGET_MS - spentMs;
  return remaining < MIN_UPLOAD_SLICE_MS ? 0 : Math.min(MEDIA_UPLOAD_BUDGET_MS, remaining);
}

const MAX_REDIRECTS = 2;
const SUPABASE_STORAGE_PREFIX = '/storage/v1/object/';

const IMAGE_TYPES = new Set(['image/jpeg', 'image/png']);
const DOCUMENT_TYPES = new Set([
  'application/pdf',
  'text/plain',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
]);

function httpsHost(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:') return null;
    return url.hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** This app's host and its www/apex twin (www.waaiio.com <-> waaiio.com). */
function appHosts(): Set<string> {
  const hosts = new Set<string>();
  const app = httpsHost(process.env.NEXT_PUBLIC_APP_URL);
  if (!app) return hosts;
  hosts.add(app);
  if (app.startsWith('www.')) hosts.add(app.slice(4));
  else if (app.includes('.')) hosts.add(`www.${app}`);
  return hosts;
}

/** True only for URLs the server may fetch to upload to WhatsApp. */
export function isUploadSourceAllowed(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  if (url.username || url.password) return false;
  if (url.port && url.port !== '443') return false;
  const host = url.hostname.toLowerCase();
  const supabaseHost = httpsHost(process.env.NEXT_PUBLIC_SUPABASE_URL);
  if (supabaseHost && host === supabaseHost) return url.pathname.startsWith(SUPABASE_STORAGE_PREFIX);
  return appHosts().has(host);
}

export interface UploadSource {
  data: Uint8Array<ArrayBuffer>;
  mimeType: string;
}

function allowedType(kind: UploadMediaKind, mimeType: string): boolean {
  return kind === 'image' ? IMAGE_TYPES.has(mimeType) : DOCUMENT_TYPES.has(mimeType);
}

async function readCapped(res: Response, cap: number): Promise<Uint8Array<ArrayBuffer> | null> {
  const declared = Number(res.headers.get('content-length') || 0);
  if (declared > cap) {
    await res.body?.cancel().catch(() => undefined);
    return null;
  }
  if (!res.body) return null;
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  if (total === 0) return null;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/**
 * Fetch an allowlisted URL for upload. Returns null (never throws for an
 * ordinary refusal) when the URL is not allowlisted, redirects elsewhere, is
 * not a WhatsApp-supported type, is too large, or the response is not 2xx.
 * Abort/timeout errors propagate so the caller can tell them apart.
 */
export async function fetchUploadSource(
  raw: string,
  kind: UploadMediaKind,
  signal: AbortSignal,
): Promise<UploadSource | null> {
  let current = raw;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!isUploadSourceAllowed(current)) return null;
    const res = await fetch(current, { method: 'GET', redirect: 'manual', cache: 'no-store', signal });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      await res.body?.cancel().catch(() => undefined);
      if (!location) return null;
      try {
        current = new URL(location, current).toString();
      } catch {
        return null;
      }
      continue;
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      return null;
    }
    const mimeType = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!allowedType(kind, mimeType)) {
      await res.body?.cancel().catch(() => undefined);
      return null;
    }
    const data = await readCapped(res, kind === 'image' ? MAX_IMAGE_UPLOAD_BYTES : MAX_DOCUMENT_UPLOAD_BYTES);
    return data ? { data, mimeType } : null;
  }
  return null;
}
