/**
 * Staging-only WhatsApp routing policy (Owner rule, 2026-11-10).
 *
 * In staging, every business, whatever its country, uses one designated US
 * shared WhatsApp number. The business keeps its own country_code for
 * currency, pricing, payment gateway, fees and messaging costs; only the
 * transport number changes. Production keeps exact-country routing plus the
 * approved fallbacks in SHARED_CHANNEL_FALLBACK_COUNTRIES.
 *
 * The designated channel is pinned by row id AND phone number, so a second US
 * number (or a country-local number) added to staging never takes its place.
 * If the designated row is missing, inactive, disconnected or owned by a
 * business, staging routing fails closed instead of picking another number.
 *
 * See docs/WHATSAPP_ENVIRONMENT_ROUTING.md.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { isStagingTestMode } from '@/lib/staging-test-mode';

export const STAGING_SHARED_WHATSAPP_CHANNEL = Object.freeze({
  id: '1f3d8f48-acfb-4c4a-b788-5cc815f19173',
  phoneDigits: '12404712139',
  countryCode: 'US',
});

/**
 * True only on staging infrastructure. Needs both the server-only
 * WAAIIO_ENVIRONMENT=staging value and the staging Vercel project + Supabase
 * identity. Public (NEXT_PUBLIC_) variables are never consulted.
 */
export function isStagingWhatsAppRouting(): boolean {
  return process.env.WAAIIO_ENVIRONMENT === 'staging' && isStagingTestMode();
}

export interface DesignatedChannelCandidate {
  id?: string | null;
  channel_type: string | null;
  is_active: boolean;
  connection_status?: string | null;
  country_code: string | null;
  business_id: string | null;
  phone_number?: string | null;
}

export type StagingDesignatedChannelProblem =
  | 'staging_designated_channel_missing'
  | 'staging_designated_channel_identity_mismatch'
  | 'staging_designated_channel_not_shared'
  | 'staging_designated_channel_business_owned'
  | 'staging_designated_channel_inactive'
  | 'staging_designated_channel_disconnected';

function phoneDigits(value: string | null | undefined): string {
  return String(value || '').replace(/[^0-9]/g, '');
}

/** Why a channel row cannot serve as the staging number, or null when it can. */
export function stagingDesignatedChannelProblem(
  channel: DesignatedChannelCandidate | null | undefined,
): StagingDesignatedChannelProblem | null {
  if (!channel) return 'staging_designated_channel_missing';
  if (
    channel.id !== STAGING_SHARED_WHATSAPP_CHANNEL.id
    || phoneDigits(channel.phone_number) !== STAGING_SHARED_WHATSAPP_CHANNEL.phoneDigits
    || channel.country_code !== STAGING_SHARED_WHATSAPP_CHANNEL.countryCode
  ) {
    return 'staging_designated_channel_identity_mismatch';
  }
  if (channel.channel_type !== 'shared') return 'staging_designated_channel_not_shared';
  // A shared number is platform transport, never one merchant's channel.
  if (channel.business_id) return 'staging_designated_channel_business_owned';
  if (channel.is_active !== true) return 'staging_designated_channel_inactive';
  if (channel.connection_status !== 'active') return 'staging_designated_channel_disconnected';
  return null;
}

export interface StagingDesignatedChannelRow extends DesignatedChannelCandidate {
  id: string;
  phone_number: string;
  phone_number_id: string | null;
  provider: string | null;
  meta_access_token?: string | null;
  waba_id?: string | null;
}

const DESIGNATED_COLUMNS = 'id,phone_number,phone_number_id,provider,channel_type,business_id,is_active,connection_status,country_code';

/**
 * Staging only: the designated shared channel row, or null (fail closed) when
 * it cannot serve. Looks the row up by its pinned id, never by country or
 * type, so no other number can come back. Pass `credentials` only when the
 * caller sends a message and needs the token.
 */
export async function loadStagingDesignatedChannel(
  db: SupabaseClient,
  options: { credentials?: boolean } = {},
): Promise<StagingDesignatedChannelRow | null> {
  const columns: string = options.credentials ? `${DESIGNATED_COLUMNS},meta_access_token,waba_id` : DESIGNATED_COLUMNS;
  const { data, error } = await db.from('whatsapp_channels').select(columns)
    .eq('id', STAGING_SHARED_WHATSAPP_CHANNEL.id).maybeSingle();
  if (error || !data) return null;
  const row = data as unknown as StagingDesignatedChannelRow;
  return stagingDesignatedChannelProblem(row) === null ? row : null;
}
