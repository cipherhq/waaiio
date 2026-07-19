/**
 * OAuth State Management — cryptographic binding for provider callbacks.
 *
 * Uses a dedicated OAUTH_STATE_SECRET (not the service role key).
 * Includes a random nonce for replay prevention.
 * State is persisted in the oauth_states table and consumed atomically
 * via a SECURITY DEFINER RPC that does UPDATE...WHERE consumed=false RETURNING.
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
  const { error } = await supabase.from('oauth_states').insert({
    nonce: payload.nonce,
    user_id: payload.userId,
    business_id: payload.businessId,
    provider: payload.provider,
    account_id: payload.accountId,
    expires_at: new Date(payload.expiresAt).toISOString(),
    consumed: false,
  });

  if (error) {
    throw new Error(`Failed to persist OAuth state: ${error.message}`);
  }
}

/**
 * Consume a state nonce atomically via RPC.
 * Returns the full state payload if consumption succeeded, or null if
 * already consumed, expired, or not found.
 *
 * The RPC does: UPDATE oauth_states SET consumed=true WHERE nonce=? AND consumed=false AND expires_at > NOW()
 * Only the first concurrent caller gets true.
 */
export async function consumeOAuthState(
  supabase: SupabaseClient,
  nonce: string,
): Promise<OAuthStatePayload | null> {
  // Atomic consume via RPC — only one caller wins
  const { data: consumed, error: rpcError } = await supabase.rpc('consume_oauth_state', {
    p_nonce: nonce,
  });

  if (rpcError) {
    throw new Error(`OAuth state consumption failed: ${rpcError.message}`);
  }

  if (!consumed) return null;

  // Fetch the state details (now consumed, safe to read)
  const { data: state } = await supabase
    .from('oauth_states')
    .select('user_id, business_id, provider, account_id, expires_at')
    .eq('nonce', nonce)
    .single();

  if (!state) return null;

  return {
    userId: state.user_id,
    businessId: state.business_id,
    provider: state.provider,
    accountId: state.account_id,
    nonce,
    expiresAt: new Date(state.expires_at).getTime(),
  };
}
