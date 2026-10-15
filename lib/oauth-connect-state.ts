/**
 * OAuth connect state management for Stripe/Square payout account linking.
 *
 * Generates a cryptographic nonce, stores its SHA-256 hash server-side
 * bound to user + business + provider, and consumes it atomically on callback.
 */
import { createHash, randomBytes } from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';

const STATE_TTL_MINUTES = 10;

export function generateState(): { raw: string; hash: string } {
  const raw = randomBytes(32).toString('hex');
  const hash = createHash('sha256').update(raw).digest('hex');
  return { raw, hash };
}

export async function storeState(
  supabase: SupabaseClient,
  opts: { stateHash: string; userId: string; businessId: string; provider: 'stripe' | 'square' },
): Promise<{ ok: boolean; error?: string }> {
  const expiresAt = new Date(Date.now() + STATE_TTL_MINUTES * 60 * 1000).toISOString();
  const { error } = await supabase.from('oauth_connect_states').insert({
    state_hash: opts.stateHash,
    user_id: opts.userId,
    business_id: opts.businessId,
    provider: opts.provider,
    expires_at: expiresAt,
  });
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

/**
 * Consume state atomically: mark used + verify user + business + provider + expiry.
 * Returns the business_id from the stored state (never from the query string).
 */
export async function consumeState(
  supabase: SupabaseClient,
  opts: { stateRaw: string; userId: string; provider: 'stripe' | 'square' },
): Promise<{ ok: boolean; businessId?: string; error?: string }> {
  const hash = createHash('sha256').update(opts.stateRaw).digest('hex');

  const { data, error } = await supabase
    .from('oauth_connect_states')
    .update({ used_at: new Date().toISOString() })
    .eq('state_hash', hash)
    .is('used_at', null)
    .gt('expires_at', new Date().toISOString())
    .eq('user_id', opts.userId)
    .eq('provider', opts.provider)
    .select('business_id')
    .single();

  if (error || !data) {
    return { ok: false, error: error?.message || 'state_not_found_or_expired' };
  }

  return { ok: true, businessId: data.business_id };
}
