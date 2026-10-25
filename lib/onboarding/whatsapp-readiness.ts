/** Read-only WhatsApp allocation readiness for admin assistance.
 * Never infer readiness from countries.is_active or a requested onboarding method.
 * Treat unrecognized channel types as pending, not an implicit platform fallback.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { isStagingTestMode } from '@/lib/staging-test-mode';

export interface ReadinessBusiness {
  id: string;
  country_code: string | null;
}
export interface ReadinessChannel {
  channel_type: string | null;
  is_active: boolean;
  connection_status: string | null;
  country_code: string | null;
  business_id: string | null;
}

/**
 * Explicit, owner-approved regional shared-channel fallbacks when a country
 * does not yet have a dedicated local platform shared number.
 * Businesses keep their authoritative country_code for currency, pricing, and gateway routing.
 *
 * Staging only: When WAAIIO_ENVIRONMENT === 'staging' (server-side), approved launch
 * countries without a local shared channel fall back to US after all existing exact-country
 * and production-approved cross-country candidates are exhausted. This does not change
 * businesses.country_code, pricing, or gateway routing — only transport assignment.
 *
 * Production: Only the explicitly approved GH → NG fallback is active. Missing,
 * malformed, or contradictory WAAIIO_ENVIRONMENT values never enable staging fallbacks.
 */
export const SHARED_CHANNEL_FALLBACK_COUNTRIES: Readonly<Record<string, readonly string[]>> = (() => {
  const base: Record<string, string[]> = { GH: ['NG'] };
  // Only the authoritative server-side env var gates staging behavior.
  // NEXT_PUBLIC_WAAIIO_ENVIRONMENT is intentionally NOT checked — client-side
  // config must never enable staging-only routing policy.
  // Belt-and-suspenders: also require canonical staging infrastructure identity
  // (Vercel project ID + Supabase URL) to prevent contradictory configuration
  // from enabling staging fallbacks on production infrastructure.
  if (process.env.WAAIIO_ENVIRONMENT === 'staging' && isStagingTestMode()) {
    base.GH.push('US');     // GH → try NG first, then US
    base.NG = ['US'];       // NG → US (staging has no NG shared channel)
    base.GB = ['US'];       // GB → US
    base.CA = ['US'];       // CA → US
  }
  return base;
})();

export type SharedChannelFallbackPolicy = 'GH_TO_NG_SHARED' | 'EXACT_COUNTRY';

export function getSharedChannelFallbackPolicy(
  businessCountry: string | null | undefined,
): SharedChannelFallbackPolicy {
  // This value is bound into the step-up MFA parameter hash (SEC-005) for
  // admin-assisted onboarding. It must match the admin client's expectation
  // at WhatsAppAssistance.tsx — changing the return value breaks the MFA
  // hash contract. Staging US fallbacks are transparent infrastructure;
  // the admin-visible policy label remains EXACT_COUNTRY for non-GH.
  return businessCountry === 'GH' ? 'GH_TO_NG_SHARED' : 'EXACT_COUNTRY';
}

export function isCompatibleSharedChannelCountry(
  businessCountry: string | null | undefined,
  channelCountry: string | null | undefined,
): boolean {
  if (!businessCountry || !channelCountry) return false;
  if (businessCountry === channelCountry) return true;
  const fallbacks = SHARED_CHANNEL_FALLBACK_COUNTRIES[businessCountry];
  return Array.isArray(fallbacks) && fallbacks.includes(channelCountry);
}

export function isAssignedWhatsAppChannelReady(
  business: ReadinessBusiness | null | undefined,
  channel: ReadinessChannel | null | undefined,
): boolean {
  if (!business || !channel || !channel.is_active || channel.connection_status !== 'active') return false;
  if (channel.channel_type === 'shared') {
    return isCompatibleSharedChannelCountry(business.country_code, channel.country_code) && !channel.business_id;
  }
  if (channel.channel_type === 'dedicated') {
    return channel.business_id === business.id;
  }
  return false;
}

/** Match Get Started's link convention only after verifying channel readiness. */
export function buildVerifiedWhatsAppLink(
  business: (ReadinessBusiness & { bot_code: string | null; status: string; messaging_suspended?: boolean | null }) | null | undefined,
  channel: (ReadinessChannel & { phone_number: string | null }) | null | undefined,
): string | null {
  if (!business || !channel || business.status !== 'active' || business.messaging_suspended === true || !isAssignedWhatsAppChannelReady(business, channel)) return null;
  const digits = String(channel.phone_number || '').replace(/[^0-9]/g, '');
  if (!/^[1-9]\d{6,14}$/.test(digits)) return null;
  if (channel.channel_type === 'dedicated') return 'https://wa.me/' + digits;
  const code = String(business.bot_code || '').trim();
  if (!code) return null;
  return 'https://wa.me/' + digits + '?text=' + encodeURIComponent(code);
}

export interface SharedChannelAllocationResult {
  allocated: boolean;
  channel_id?: string | null;
  phone_number?: string | null;
  channel_country?: string | null;
  fallback_used?: boolean;
  idempotent?: boolean;
  repaired?: boolean;
  reason?: string;
}

/**
 * Allocates an active shared WhatsApp channel for a business using the M430
 * `allocate_shared_channel` / `reassign_shared_channel` RPCs:
 * 1. Tries exact `businessCountry` first.
 * 2. If `no_shared_channel_for_country` or `all_channels_at_capacity`, tries
 *    configured `SHARED_CHANNEL_FALLBACK_COUNTRIES[businessCountry]` (e.g. GH -> NG)
 *    without mutating `businesses.country_code`.
 * 3. When `repairStaleSharedChannel` is true and the RPC returns `idempotent: true`
 *    for a stale/inactive assigned shared channel, repairs the assignment via
 *    `reassign_shared_channel` to an active compatible shared channel.
 */
export async function allocateSharedChannelWithFallback(
  service: SupabaseClient,
  businessId: string,
  businessCountry: string | null | undefined,
  options?: { repairStaleSharedChannel?: boolean },
): Promise<{ data: SharedChannelAllocationResult | null; error: { message: string } | null }> {
  if (!businessCountry) {
    return {
      data: { allocated: false, reason: 'missing_business_country' },
      error: null,
    };
  }

  const candidateCountries = [
    businessCountry,
    ...(SHARED_CHANNEL_FALLBACK_COUNTRIES[businessCountry] ?? []),
  ];

  let lastResult: SharedChannelAllocationResult | null = null;

  for (let idx = 0; idx < candidateCountries.length; idx++) {
    const targetCountry = candidateCountries[idx];
    const isFallback = idx > 0;

    const { data: rawResult, error: rpcError } = await service.rpc('allocate_shared_channel', {
      p_business_id: businessId,
      p_country_code: targetCountry,
    });

    if (rpcError) {
      return { data: null, error: rpcError };
    }

    const result = (rawResult ?? null) as SharedChannelAllocationResult | null;
    if (!result) {
      return { data: { allocated: false, reason: 'empty_rpc_response' }, error: null };
    }

    if (result.allocated) {
      // If idempotent (business already had assigned_channel_id), optionally verify & repair stale channel
      if (result.idempotent && options?.repairStaleSharedChannel) {
        // P2-1: Fail closed on stale channel lookup errors — do not attempt
        // reassignment with uncertain state.
        const { data: currentChannel, error: staleLookupErr } = await service
          .from('whatsapp_channels')
          .select('id, phone_number, channel_type, is_active, connection_status, country_code, business_id')
          .eq('id', result.channel_id ?? '')
          .maybeSingle();

        if (staleLookupErr) {
          return {
            data: {
              allocated: false,
              channel_id: result.channel_id,
              reason: `stale_channel_lookup_error: ${staleLookupErr.message}`,
            },
            error: null,
          };
        }

        const isReady = isAssignedWhatsAppChannelReady(
          { id: businessId, country_code: businessCountry },
          currentChannel,
        );

        if (isReady && currentChannel) {
          return {
            data: {
              ...result,
              phone_number: currentChannel.phone_number,
              channel_country: currentChannel.country_code,
              fallback_used: currentChannel.country_code !== businessCountry,
            },
            error: null,
          };
        }

        // Assigned shared channel is stale/inactive — find a healthy compatible
        // shared channel and reassign. Query only schema-verified columns;
        // capacity is enforced inside the reassign_shared_channel RPC via
        // platform_settings.shared_number_capacity (not per-channel columns).
        for (let fIdx = 0; fIdx < candidateCountries.length; fIdx++) {
          const repairCountry = candidateCountries[fIdx];
          const { data: candidates, error: candidateErr } = await service
            .from('whatsapp_channels')
            .select('id, phone_number, country_code')
            .eq('channel_type', 'shared')
            .eq('country_code', repairCountry)
            .eq('is_active', true)
            .eq('connection_status', 'active')
            .is('business_id', null)
            .order('created_at', { ascending: true })
            .limit(10);

          // P1-2: Fail closed on query errors — do not proceed with stale data
          if (candidateErr) {
            return { data: null, error: { message: `Stale-repair candidate query failed: ${candidateErr.message}` } };
          }

          // P2-2: Try ALL eligible candidates, not just the first. The
          // reassign_shared_channel RPC enforces capacity — if the first
          // candidate is at capacity, try the next one.
          const eligibleCandidates = (candidates ?? []).filter(
            (c: { id: string }) => c.id !== result.channel_id,
          );

          for (const healthyTarget of eligibleCandidates) {
            const { data: reassignRaw, error: reassignErr } = await service.rpc('reassign_shared_channel', {
              p_business_id: businessId,
              p_new_channel_id: healthyTarget.id,
            });
            if (reassignErr) {
              return { data: null, error: reassignErr };
            }
            const reassignRes = (reassignRaw ?? null) as { reassigned?: boolean; reason?: string; new_channel_id?: string } | null;
            if (reassignRes?.reassigned) {
              return {
                data: {
                  allocated: true,
                  channel_id: healthyTarget.id,
                  phone_number: healthyTarget.phone_number,
                  channel_country: healthyTarget.country_code,
                  fallback_used: fIdx > 0,
                  repaired: true,
                },
                error: null,
              };
            }
            // This candidate rejected (likely at capacity) — try the next
          }
        }

        return {
          data: {
            allocated: false,
            channel_id: result.channel_id,
            reason: 'assigned_channel_inactive_and_no_replacement_available',
          },
          error: null,
        };
      }

      // P1-1: The M430 RPC selects channels with is_active=true but does NOT
      // check connection_status. Callers MUST verify connection_status='active'
      // via isAssignedWhatsAppChannelReady before treating the allocation as
      // ready for business activation. This function reports the allocation
      // result; the caller's post-allocation readiness check is the gate.
      return {
        data: {
          ...result,
          channel_country: result.channel_country ?? targetCountry,
          fallback_used: isFallback,
        },
        error: null,
      };
    }

    lastResult = result;
    if (
      result.reason !== 'no_shared_channel_for_country' &&
      result.reason !== 'all_channels_at_capacity'
    ) {
      break;
    }
  }

  return {
    data: lastResult ?? { allocated: false, reason: 'no_shared_channel_for_country' },
    error: null,
  };
}

