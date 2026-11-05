/**
 * PR #655 — GH→NG fallback in WhatsApp Flow onboarding callback.
 *
 * Proves:
 * 1. flow-callback/onboarding.ts uses allocateSharedChannelWithFallback (not direct RPC)
 * 2. Confirmation routing tries fallback countries when exact-country resolver returns null
 * 3. SHARED_CHANNEL_FALLBACK_COUNTRIES is imported and used
 */
import { readFileSync } from 'fs';
import { describe, it, expect } from 'vitest';

const source = readFileSync('app/api/whatsapp/flow-callback/onboarding.ts', 'utf8');

describe('PR #655: GH→NG fallback in WhatsApp Flow onboarding', () => {
  it('allocates through the fallback-aware wrapper instead of a direct RPC', () => {
    // M507: allocateSharedChannelForNewBusiness delegates to
    // allocateSharedChannelWithFallback (GH->NG) when channel operations are
    // enabled, otherwise to the M507 first assignment (GH->NG in SQL).
    expect(source).toContain('allocateSharedChannelForNewBusiness');
    // Must NOT call either allocation RPC directly; only through the wrapper.
    const directRpcCalls = source.match(/\.rpc\(['"](allocate_shared_channel|assign_first_shared_channel)['"]/g);
    expect(directRpcCalls).toBeNull();
  });

  it('imports SHARED_CHANNEL_FALLBACK_COUNTRIES for confirmation routing', () => {
    expect(source).toContain('SHARED_CHANNEL_FALLBACK_COUNTRIES');
    expect(source).toContain("from '@/lib/onboarding/whatsapp-readiness'");
  });

  it('confirmation routing tries fallback countries when exact-country returns null', () => {
    // The confirmation section should check for fallbacks
    const confirmSection = source.slice(source.indexOf('Send WhatsApp confirmation'));
    expect(confirmSection).toContain('getSharedChannelForCountry');
    expect(confirmSection).toContain('SHARED_CHANNEL_FALLBACK_COUNTRIES');
    // Must try fallback countries in a loop
    expect(confirmSection).toContain('for (const fb of fallbacks)');
  });
});
