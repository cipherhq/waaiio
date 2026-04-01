import type { SupabaseClient } from '@supabase/supabase-js';
import { GupshupService } from './gupshup';
import type { CountryCode } from '@/lib/constants';

interface ChannelRecord {
  id: string;
  country_code: CountryCode;
  phone_number: string;
  gupshup_app_name: string;
  gupshup_api_key: string;
  channel_type: 'shared' | 'dedicated';
  business_id: string | null;
  is_active: boolean;
}

interface ResolvedChannel {
  channel: ChannelRecord;
  gupshup: GupshupService;
}

const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

export class ChannelResolver {
  private cache = new Map<string, { data: ChannelRecord | null; ts: number }>();

  constructor(private readonly supabase: SupabaseClient) {}

  /**
   * Resolve a channel by the destination phone number (the Gupshup number that received the message).
   * Returns the channel record + a GupshupService configured with that channel's credentials.
   * Falls back to null if no channel is found in DB (use default env-var GupshupService).
   */
  async resolveByPhone(destinationPhone: string): Promise<ResolvedChannel | null> {
    if (!destinationPhone) return null;

    // Normalize: strip leading +
    const normalized = destinationPhone.replace(/^\+/, '');

    const cached = this.cache.get(`phone:${normalized}`);
    if (cached && Date.now() - cached.ts < CACHE_TTL) {
      if (!cached.data) return null;
      return { channel: cached.data, gupshup: GupshupService.fromChannel(cached.data) };
    }

    const { data } = await this.supabase
      .from('whatsapp_channels')
      .select('*')
      .eq('phone_number', normalized)
      .eq('is_active', true)
      .single();

    const record = data as ChannelRecord | null;
    this.cache.set(`phone:${normalized}`, { data: record, ts: Date.now() });

    if (!record) return null;
    return { channel: record, gupshup: GupshupService.fromChannel(record) };
  }

  /**
   * Get the shared channel for a given country.
   */
  async getSharedChannelForCountry(countryCode: CountryCode): Promise<ResolvedChannel | null> {
    const cacheKey = `shared:${countryCode}`;
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.ts < CACHE_TTL) {
      if (!cached.data) return null;
      return { channel: cached.data, gupshup: GupshupService.fromChannel(cached.data) };
    }

    const { data } = await this.supabase
      .from('whatsapp_channels')
      .select('*')
      .eq('country_code', countryCode)
      .eq('channel_type', 'shared')
      .eq('is_active', true)
      .limit(1)
      .single();

    const record = data as ChannelRecord | null;
    this.cache.set(cacheKey, { data: record, ts: Date.now() });

    if (!record) return null;
    return { channel: record, gupshup: GupshupService.fromChannel(record) };
  }
}
