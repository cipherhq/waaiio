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
// so code paths such as lib/intake/answers.ts are not touched.
const PRIVATE_LINK = /(\/(?:api\/)?intake\/)[A-Za-z0-9_-]{32,}(?=[/?#\s"'<>]|$)/g;

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

/** Spread into every Sentry.init (client, server, edge). */
export const privateLinkScrubbers = {
  beforeSend: scrubPrivateLinks,
  beforeSendTransaction: scrubPrivateLinks,
  beforeSendSpan: scrubPrivateLinks,
  beforeBreadcrumb: scrubPrivateLinks,
};
