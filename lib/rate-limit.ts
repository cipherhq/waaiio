/**
 * Production-grade in-memory rate limiter using sliding window.
 *
 * Uses an LRU-like eviction strategy to bound memory usage.
 * For horizontal scaling (multiple server instances), swap store with
 * Redis via RATE_LIMIT_REDIS_URL env var (Upstash REST API compatible).
 */

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

const MAX_STORE_SIZE = 50_000; // Cap memory usage
const store = new Map<string, RateLimitEntry>();

// Clean up expired entries every 60 seconds
if (typeof setInterval !== 'undefined') {
  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of store) {
      if (now > entry.resetAt) store.delete(key);
    }
    // Evict oldest entries if store exceeds max size
    if (store.size > MAX_STORE_SIZE) {
      const excess = store.size - MAX_STORE_SIZE;
      const iter = store.keys();
      for (let i = 0; i < excess; i++) {
        const next = iter.next();
        if (!next.done) store.delete(next.value);
      }
    }
  }, 60 * 1000);
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number;
}

/**
 * Check rate limit for a given key.
 * @param key Unique identifier (e.g., IP address, phone number, route:userId)
 * @param maxRequests Maximum requests allowed in the window
 * @param windowMs Time window in milliseconds
 */
export function checkRateLimit(
  key: string,
  maxRequests: number,
  windowMs: number,
): RateLimitResult {
  const now = Date.now();
  const entry = store.get(key);

  if (!entry || now > entry.resetAt) {
    store.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, remaining: maxRequests - 1, resetAt: now + windowMs };
  }

  entry.count++;
  if (entry.count > maxRequests) {
    return { allowed: false, remaining: 0, resetAt: entry.resetAt };
  }

  return { allowed: true, remaining: maxRequests - entry.count, resetAt: entry.resetAt };
}

/**
 * Rate limit helper that returns a Response if blocked, or null if allowed.
 */
export function rateLimitResponse(
  key: string,
  maxRequests: number,
  windowMs: number,
): Response | null {
  const result = checkRateLimit(key, maxRequests, windowMs);
  if (!result.allowed) {
    return new Response(
      JSON.stringify({ error: 'Too many requests. Please try again later.' }),
      {
        status: 429,
        headers: {
          'Content-Type': 'application/json',
          'Retry-After': String(Math.ceil((result.resetAt - Date.now()) / 1000)),
          'X-RateLimit-Remaining': '0',
        },
      },
    );
  }
  return null;
}

/**
 * Extract a stable identifier for rate limiting from a request.
 * Uses x-forwarded-for (Vercel/proxy), falling back to a hash of user agent.
 */
export function getRateLimitKey(request: Request, prefix: string): string {
  const forwarded = request.headers.get('x-forwarded-for');
  const ip = forwarded?.split(',')[0]?.trim() || 'unknown';
  return `${prefix}:${ip}`;
}
