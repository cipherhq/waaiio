import type { SupabaseClient } from '@supabase/supabase-js';
import { GupshupService } from './gupshup';
import { MetaCloudService } from './meta-cloud';
import { MetaCloudSender, type MessageSender } from './message-sender';
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
  provider: 'gupshup' | 'meta_cloud';
  waba_id: string | null;
  phone_number_id: string | null;
  meta_access_token: string | null;
}

export interface ResolvedChannel {
  channel: ChannelRecord;
  sender: MessageSender;
}

const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

export class ChannelResolver {
  private cache = new Map<string, { data: ChannelRecord | null; ts: number }>();

  constructor(private readonly supabase: SupabaseClient) {}

  /**
   * Build the correct MessageSender for a channel based on its provider.
   */
  private buildSender(channel: ChannelRecord): MessageSender {
    if (channel.provider === 'meta_cloud' && channel.meta_access_token && channel.phone_number_id) {
      return new MetaCloudSender(
        new MetaCloudService({
          accessToken: channel.meta_access_token,
          phoneNumberId: channel.phone_number_id,
          wabaId: channel.waba_id || undefined,
        })
      );
    }
    // Default: Gupshup
    return GupshupService.fromChannel(channel);
  }

  /**
   * Resolve a channel by the destination phone number.
   * Returns the channel record + a MessageSender configured with that channel's credentials.
   */
  async resolveByPhone(destinationPhone: string): Promise<ResolvedChannel | null> {
    if (!destinationPhone) return null;

    const normalized = destinationPhone.replace(/^\+/, '');

    const cached = this.cache.get(`phone:${normalized}`);
    if (cached && Date.now() - cached.ts < CACHE_TTL) {
      if (!cached.data) return null;
      return { channel: cached.data, sender: this.buildSender(cached.data) };
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
    return { channel: record, sender: this.buildSender(record) };
  }

  /**
   * Resolve a channel by Meta Cloud API phone_number_id.
   * Used by the Meta Cloud webhook to find the channel.
   */
  async resolveByPhoneNumberId(phoneNumberId: string): Promise<ResolvedChannel | null> {
    if (!phoneNumberId) return null;

    const cacheKey = `pnid:${phoneNumberId}`;
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.ts < CACHE_TTL) {
      if (!cached.data) return null;
      return { channel: cached.data, sender: this.buildSender(cached.data) };
    }

    const { data } = await this.supabase
      .from('whatsapp_channels')
      .select('*')
      .eq('phone_number_id', phoneNumberId)
      .eq('provider', 'meta_cloud')
      .eq('is_active', true)
      .single();

    const record = data as ChannelRecord | null;
    this.cache.set(cacheKey, { data: record, ts: Date.now() });

    if (!record) return null;
    return { channel: record, sender: this.buildSender(record) };
  }

  /**
   * Resolve a channel by business_id.
   * Tries dedicated channel first, then falls back to the shared channel for the business's country.
   */
  async resolveByBusinessId(businessId: string): Promise<ResolvedChannel | null> {
    if (!businessId) return null;

    const cacheKey = `biz:${businessId}`;
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.ts < CACHE_TTL) {
      if (!cached.data) return null;
      return { channel: cached.data, sender: this.buildSender(cached.data) };
    }

    // First try dedicated channel
    const { data } = await this.supabase
      .from('whatsapp_channels')
      .select('*')
      .eq('business_id', businessId)
      .eq('channel_type', 'dedicated')
      .eq('is_active', true)
      .maybeSingle();

    if (data) {
      const record = data as ChannelRecord;
      this.cache.set(cacheKey, { data: record, ts: Date.now() });
      return { channel: record, sender: this.buildSender(record) };
    }

    // Fallback: shared channel for the business's country
    const { data: biz } = await this.supabase
      .from('businesses')
      .select('country_code')
      .eq('id', businessId)
      .single();

    if (biz?.country_code) {
      const shared = await this.getSharedChannelForCountry(biz.country_code as CountryCode);
      if (shared) {
        this.cache.set(cacheKey, { data: shared.channel, ts: Date.now() });
        return shared;
      }
    }

    this.cache.set(cacheKey, { data: null, ts: Date.now() });
    return null;
  }

  /**
   * Get the shared channel for a given country.
   */
  async getSharedChannelForCountry(countryCode: CountryCode): Promise<ResolvedChannel | null> {
    const cacheKey = `shared:${countryCode}`;
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.ts < CACHE_TTL) {
      if (!cached.data) return null;
      return { channel: cached.data, sender: this.buildSender(cached.data) };
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
    return { channel: record, sender: this.buildSender(record) };
  }
}
