import { SupabaseClient } from '@supabase/supabase-js';
import { PRICING_TIERS } from '@/lib/constants';
import type { SubscriptionTier } from '@/lib/constants';

export interface TierCheckResult {
  allowed: boolean;
  plan: string;
  monthlyBookings: number;
  monthlyLimit: number;
  isWhitelabel: boolean;
}

export interface BotTemplates {
  greeting: string;
  confirmation: string;
  reminder: string;
}

export class StandaloneService {
  constructor(private readonly supabase: SupabaseClient) {}

  async checkTierLimits(businessId: string): Promise<TierCheckResult> {
    const { data: business } = await this.supabase
      .from('businesses')
      .select('subscription_tier, is_whitelabel')
      .eq('id', businessId)
      .single();

    const tierKey = (business?.subscription_tier as SubscriptionTier) || 'free';
    const tier = PRICING_TIERS[tierKey] || PRICING_TIERS.free;

    if (tier.maxBookings === Infinity) {
      return {
        allowed: true,
        plan: tierKey,
        monthlyBookings: 0,
        monthlyLimit: Infinity,
        isWhitelabel: tier.whitelabel,
      };
    }

    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);

    const { count } = await this.supabase
      .from('bookings')
      .select('id', { count: 'exact', head: true })
      .eq('business_id', businessId)
      .eq('channel', 'whatsapp')
      .gte('created_at', monthStart.toISOString());

    const monthlyBookings = count || 0;

    return {
      allowed: monthlyBookings < tier.maxBookings,
      plan: tierKey,
      monthlyBookings,
      monthlyLimit: tier.maxBookings,
      isWhitelabel: business?.is_whitelabel || tier.whitelabel,
    };
  }

  async getBotTemplates(businessId: string): Promise<BotTemplates> {
    const { data } = await this.supabase
      .from('whatsapp_config')
      .select('bot_greeting, bot_confirmation_template, bot_reminder_template')
      .eq('business_id', businessId)
      .maybeSingle();

    return {
      greeting: data?.bot_greeting || 'Welcome! How can I help you today?',
      confirmation: data?.bot_confirmation_template ||
        '✅ *Confirmed!*\n\n{business_name}\n📅 {date}\n🕐 {time}\n👥 {quantity} {quantity_label}\n🔑 Ref: *{reference_code}*\n\nThank you! 🎉',
      reminder: data?.bot_reminder_template ||
        '⏰ *Reminder*\n\nYour booking at {business_name} is tomorrow at {time}.\n\nRef: {reference_code}\n\nSee you there! 🎉',
    };
  }

  async getBotAlias(businessId: string): Promise<string | null> {
    const { data } = await this.supabase
      .from('whatsapp_config')
      .select('bot_alias')
      .eq('business_id', businessId)
      .maybeSingle();

    return data?.bot_alias || null;
  }

  fillTemplate(
    template: string,
    vars: Record<string, string | number>,
  ): string {
    let result = template;
    for (const [key, value] of Object.entries(vars)) {
      result = result.replace(new RegExp(`\\{${key}\\}`, 'g'), String(value));
    }
    return result;
  }
}
