/**
 * In-memory session cache for middleware validation.
 * Avoids DB queries on every request. 5-minute TTL.
 */

const CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const TOUCH_DEBOUNCE = 60 * 1000; // Only update last_seen_at every 60s
const MAX_ENTRIES = 10_000;

interface CachedSession {
  ip: string;
  uaHash: string;
  fetchedAt: number;
  lastTouched: number;
}

const cache = new Map<string, CachedSession>();

/**
 * Fast non-crypto hash for middleware (djb2).
 * Only used for in-memory comparison — SHA-256 is used for storage.
 */
export function fastHash(str: string): string {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) & 0x7fffffff;
  }
  return hash.toString(36);
}

export function getCachedSession(sessionId: string): CachedSession | null {
  const entry = cache.get(sessionId);
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt > CACHE_TTL) {
    cache.delete(sessionId);
    return null;
  }
  return entry;
}

export function setCachedSession(sessionId: string, ip: string, uaHash: string): void {
  // Evict oldest if full
  if (cache.size >= MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest) cache.delete(oldest);
  }
  cache.set(sessionId, { ip, uaHash, fetchedAt: Date.now(), lastTouched: Date.now() });
}

export function shouldTouch(sessionId: string): boolean {
  const entry = cache.get(sessionId);
  if (!entry) return true;
  if (Date.now() - entry.lastTouched > TOUCH_DEBOUNCE) {
    entry.lastTouched = Date.now();
    return true;
  }
  return false;
}

export function invalidateSession(sessionId: string): void {
  cache.delete(sessionId);
}
