/**
 * Rate limiter with Upstash Redis support for production (Vercel serverless).
 * Falls back to in-memory store when UPSTASH_REDIS_REST_URL is not configured.
 *
 * In-memory mode works per-instance only — each Vercel Lambda has its own Map.
 * Redis mode shares state across all instances for true global rate limiting.
 */

import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';

// ── Redis-backed rate limiter (production) ──

const redisUrl = process.env.UPSTASH_REDIS_REST_URL;
const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;
const useRedis = !!(redisUrl && redisToken);

let redis: Redis | null = null;
if (useRedis) {
  redis = new Redis({ url: redisUrl!, token: redisToken! });
}

// Cache Ratelimit instances by config key to avoid re-creating
const rlCache = new Map<string, Ratelimit>();

function getRedisLimiter(maxRequests: number, windowMs: number): Ratelimit {
  const key = `${maxRequests}:${windowMs}`;
  let rl = rlCache.get(key);
  if (!rl) {
    rl = new Ratelimit({
      redis: redis!,
      limiter: Ratelimit.slidingWindow(maxRequests, `${windowMs} ms`),
      prefix: 'rl',
    });
    rlCache.set(key, rl);
  }
  return rl;
}

// ── In-memory fallback (dev / when Redis not configured) ──

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

const MAX_STORE_SIZE = 50_000;
const store = new Map<string, RateLimitEntry>();

if (typeof setInterval !== 'undefined') {
  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of store) {
      if (now > entry.resetAt) store.delete(key);
    }
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

function checkInMemory(key: string, maxRequests: number, windowMs: number): RateLimitResult {
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
 * Check rate limit for a given key.
 */
export function checkRateLimit(
  key: string,
  maxRequests: number,
  windowMs: number,
): RateLimitResult {
  // In-memory path (sync) — used when Redis not configured or for sync callers
  return checkInMemory(key, maxRequests, windowMs);
}

/**
 * Rate limit helper that returns a Response if blocked, or null if allowed.
 * Uses Redis when available for cross-instance rate limiting.
 */
export async function rateLimitResponseAsync(
  key: string,
  maxRequests: number,
  windowMs: number,
): Promise<Response | null> {
  if (useRedis) {
    const rl = getRedisLimiter(maxRequests, windowMs);
    const { success, remaining, reset } = await rl.limit(key);
    if (!success) {
      return new Response(
        JSON.stringify({ error: 'Too many requests. Please try again later.' }),
        {
          status: 429,
          headers: {
            'Content-Type': 'application/json',
            'Retry-After': String(Math.ceil((reset - Date.now()) / 1000)),
            'X-RateLimit-Remaining': String(remaining),
          },
        },
      );
    }
    return null;
  }

  // Fallback to in-memory
  return rateLimitResponse(key, maxRequests, windowMs);
}

/**
 * Synchronous rate limit helper (in-memory only).
 * Use rateLimitResponseAsync for Redis-backed limiting.
 */
export function rateLimitResponse(
  key: string,
  maxRequests: number,
  windowMs: number,
): Response | null {
  const result = checkInMemory(key, maxRequests, windowMs);
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
 */
export function getRateLimitKey(request: Request, prefix: string): string {
  const forwarded = request.headers.get('x-forwarded-for');
  const ip = forwarded?.split(',')[0]?.trim() || 'unknown';
  return `${prefix}:${ip}`;
}
