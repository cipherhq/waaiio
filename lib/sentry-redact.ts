/**
 * Keep private link tokens out of Sentry (#963 client intake).
 *
 * The intake page (/intake/{token}) and its API (/api/intake/{token}) carry a
 * single-use secret in the URL path. Sentry records URLs in errors,
 * transactions, spans (url.full, url.path) and breadcrumbs, and its query-param
 * filter does not cover path segments, so every outgoing item is scrubbed here:
 * the token becomes "[token]".
 */

const PRIVATE_LINK = /(\/(?:api\/)?intake\/)[^/?#\s"'<>]+/g;

export function redactPrivateLinkPath(value: string): string {
  return value.replace(PRIVATE_LINK, '$1[token]');
}

/** Rewrites every string inside a Sentry item in place, and returns the item. */
export function scrubPrivateLinks<T>(item: T): T {
  const seen = new WeakSet<object>();
  const walk = (node: unknown, depth: number): unknown => {
    if (typeof node === 'string') return redactPrivateLinkPath(node);
    if (!node || typeof node !== 'object' || depth > 12 || seen.has(node)) return node;
    seen.add(node);
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) node[i] = walk(node[i], depth + 1);
    } else {
      const record = node as Record<string, unknown>;
      for (const key of Object.keys(record)) record[key] = walk(record[key], depth + 1);
    }
    return node;
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
