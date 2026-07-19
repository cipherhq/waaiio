/**
 * OAuth State Management — cryptographic binding for provider callbacks.
 *
 * Uses a dedicated OAUTH_STATE_SECRET (not the service role key).
 * Includes a random nonce for replay prevention.
 * State must be persisted server-side and consumed atomically.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';

const EXPIRY_MS = 30 * 60 * 1000; // 30 minutes

function getSecret(): string {
  const secret = process.env.OAUTH_STATE_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV === 'production' || process.env.VERCEL) {
      throw new Error('OAUTH_STATE_SECRET is required in production');
    }
    return 'dev-only-oauth-state-secret-not-for-production';
  }
  return secret;
}

export interface OAuthStatePayload {
  userId: string;
  businessId: string;
  provider: string;
  accountId: string;
  nonce: string;
  expiresAt: number;
}

/** Generate a signed OAuth state token with random nonce */
export function generateOAuthState(
  userId: string,
  businessId: string,
  provider: string,
  accountId: string,
): { token: string; payload: OAuthStatePayload } {
  const secret = getSecret();
  const nonce = randomBytes(16).toString('hex');
  const expiresAt = Date.now() + EXPIRY_MS;
  const data = `${userId}|${businessId}|${provider}|${accountId}|${nonce}|${expiresAt}`;
  const sig = createHmac('sha256', secret).update(data).digest('hex');
  const token = `${data}|${sig}`;
  return {
    token,
    payload: { userId, businessId, provider, accountId, nonce, expiresAt },
  };
}

/** Verify a signed OAuth state token. Returns null if invalid/expired/tampered. */
export function verifyOAuthState(token: string): OAuthStatePayload | null {
  const parts = token.split('|');
  if (parts.length !== 7) return null;

  const [userId, businessId, provider, accountId, nonce, expiresStr, sig] = parts;
  const expiresAt = parseInt(expiresStr, 10);
  if (isNaN(expiresAt) || Date.now() > expiresAt) return null;

  const secret = getSecret();
  const data = `${userId}|${businessId}|${provider}|${accountId}|${nonce}|${expiresStr}`;
  const expectedSig = createHmac('sha256', secret).update(data).digest('hex');

  // Timing-safe comparison
  try {
    if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig))) return null;
  } catch {
    return null;
  }

  return { userId, businessId, provider, accountId, nonce, expiresAt };
}

/** Persist state nonce server-side for replay prevention */
export async function persistOAuthState(
  supabase: SupabaseClient,
  payload: OAuthStatePayload,
): Promise<void> {
  await supabase.from('platform_settings').upsert({
    key: `oauth_state:${payload.nonce}`,
    value: {
      userId: payload.userId,
      businessId: payload.businessId,
      provider: payload.provider,
      accountId: payload.accountId,
      expiresAt: payload.expiresAt,
      consumed: false,
    },
  }, { onConflict: 'key' });
}

/** Consume a state nonce atomically. Returns false if already consumed or not found. */
export async function consumeOAuthState(
  supabase: SupabaseClient,
  nonce: string,
): Promise<boolean> {
  // Atomic: only succeeds if consumed=false
  const { data } = await supabase
    .from('platform_settings')
    .select('key, value')
    .eq('key', `oauth_state:${nonce}`)
    .maybeSingle();

  if (!data) return false;
  const val = data.value as Record<string, unknown>;
  if (val.consumed === true) return false;

  // Mark consumed
  await supabase.from('platform_settings').update({
    value: { ...val, consumed: true, consumed_at: new Date().toISOString() },
  }).eq('key', `oauth_state:${nonce}`);

  return true;
}
