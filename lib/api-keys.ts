/**
 * API key utilities for external integrations.
 * Keys are hashed (SHA-256) before storage — raw keys are never persisted.
 */

import { createServiceClient } from '@/lib/supabase/service';
import { logger } from '@/lib/logger';

const KEY_PREFIX = 'wai_';

/**
 * Generate a new API key.
 * Returns the raw key (show once to user), its hash, and prefix for display.
 */
export async function generateApiKey(): Promise<{ raw: string; hash: string; prefix: string }> {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const raw = KEY_PREFIX + Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
  const hash = await hashApiKey(raw);
  const prefix = raw.slice(0, 12); // "wai_" + 8 hex chars
  return { raw, hash, prefix };
}

/**
 * Hash a raw API key using SHA-256.
 */
export async function hashApiKey(raw: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(raw);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Validate an API key and return the associated business_id.
 * Updates last_used_at on successful validation.
 * Returns null if key is invalid or revoked.
 */
export async function validateApiKey(rawKey: string): Promise<{ businessId: string; keyId: string } | null> {
  if (!rawKey || !rawKey.startsWith(KEY_PREFIX)) return null;

  const hash = await hashApiKey(rawKey);
  const supabase = createServiceClient();

  const { data } = await supabase
    .from('api_keys')
    .select('id, business_id')
    .eq('key_hash', hash)
    .is('revoked_at', null)
    .single();

  if (!data) return null;

  // Update last_used_at (non-blocking)
  void supabase
    .from('api_keys')
    .update({ last_used_at: new Date().toISOString() })
    .eq('id', data.id);

  return { businessId: data.business_id, keyId: data.id };
}
