/**
 * Keep private link tokens out of Sentry (#963 client intake).
 *
 * The intake page (/intake/{token}) and its API (/api/intake/{token}) carry a
 * single-use secret in the URL path. Sentry records URLs in errors,
 * transactions, spans (url.full, url.path) and breadcrumbs, and its query-param
 * filter does not cover path segments, so every outgoing item is scrubbed here:
 * the token becomes "[token]".
 *
 * Scrubbing works on copies: breadcrumbs carry the app's own logged objects
 * (console arguments), which must never be changed.
 */

// Tokens are 32+ base64url characters (the route accepts [A-Za-z0-9_-]{32,256}),
// so code paths such as lib/intake/answers.ts are not touched. The greedy match
// ends at the token, whatever follows it (/, ?, ), ., comma, &, % ...).
const PRIVATE_LINK = /(\/(?:api\/)?intake\/)[A-Za-z0-9_-]{32,}/g;

export function redactPrivateLinkPath(value: string): string {
  return value.replace(PRIVATE_LINK, '$1[token]');
}

function isPlainObject(value: object): value is Record<string, unknown> {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Returns a copy of a Sentry item with every string scrubbed. Arrays and plain
 * objects are copied; other objects (class instances, live SDK state) are kept
 * as they are and never modified.
 */
export function scrubPrivateLinks<T>(item: T): T {
  const copies = new WeakMap<object, unknown>();
  const walk = (node: unknown, depth: number): unknown => {
    if (typeof node === 'string') return redactPrivateLinkPath(node);
    if (!node || typeof node !== 'object' || depth > 12) return node;
    if (copies.has(node)) return copies.get(node);
    if (Array.isArray(node)) {
      const copy: unknown[] = [];
      copies.set(node, copy);
      for (const value of node) copy.push(walk(value, depth + 1));
      return copy;
    }
    if (!isPlainObject(node)) return node;
    const copy: Record<string, unknown> = {};
    copies.set(node, copy);
    for (const key of Object.keys(node)) copy[key] = walk(node[key], depth + 1);
    return copy;
  };
  return walk(item, 0) as T;
}

/**
 * Events built by reportFailure() (lib/observability/report-failure.ts) carry
 * only its validated tags. Strip everything else Sentry would attach: console
 * breadcrumbs (they hold whatever the app logged), request body, query string
 * and cookies, user and extra. Other events pass through unchanged.
 */
export function scrubFailureReport<T>(event: T): T {
  const ev = event as unknown as {
    tags?: Record<string, unknown>;
    request?: { url?: unknown; method?: unknown };
  } & Record<string, unknown>;
  if (!ev || typeof ev !== 'object' || ev.tags?.failure_report !== '1') return event;
  const { breadcrumbs: _b, extra: _e, user: _u, request, ...rest } = ev;
  const out: Record<string, unknown> = { ...rest, breadcrumbs: [] };
  if (request && typeof request === 'object') {
    const url = typeof request.url === 'string' ? request.url.split('?')[0].split('#')[0] : undefined;
    out.request = { ...(url ? { url } : {}), ...(typeof request.method === 'string' ? { method: request.method } : {}) };
  }
  return out as T;
}

/**
 * Spread into every Sentry.init (client, server, edge). Sentry 11 streams spans
 * by default, so spans go through beforeSendSpan; beforeSendTransaction is not
 * set because it is ignored there and makes Sentry log a warning on each start.
 */
export const privateLinkScrubbers = {
  beforeSend: <T>(event: T): T => scrubFailureReport(scrubPrivateLinks(event)),
  beforeSendSpan: scrubPrivateLinks,
  beforeBreadcrumb: scrubPrivateLinks,
};
