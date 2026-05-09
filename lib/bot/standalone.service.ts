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
  orderConfirmation: string;
  paymentReceipt: string;
  orderStatus: string;
}

export interface WhatsAppConfigBundle {
  templates: BotTemplates;
  alias: string | null;
  welcome_buttons: { label: string; action: string; payload?: string }[];
  quick_replies: { trigger: string; label: string; response: string }[];
  default_reply: string | null;
  auto_reply_enabled: boolean;
  business_hours: Record<string, unknown> | null;
  away_message: string | null;
  instant_reply_enabled: boolean;
  instant_reply_message: string | null;
}

export class StandaloneService {
  constructor(private readonly supabase: SupabaseClient) {}

  /**
   * Check tier limits using already-fetched business data (avoids redundant business query).
   */
  async checkTierLimitsFromBusiness(
    businessId: string,
    subscriptionTier: string | null,
    isWhitelabel?: boolean,
  ): Promise<TierCheckResult> {
    const tierKey = (subscriptionTier as SubscriptionTier) || 'free';
    const tier = PRICING_TIERS[tierKey] || PRICING_TIERS.free;

    if (tier.maxBookings === Infinity) {
      return {
        allowed: true,
        plan: tierKey,
        monthlyBookings: 0,
        monthlyLimit: Infinity,
        isWhitelabel: isWhitelabel ?? tier.whitelabel,
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
      isWhitelabel: isWhitelabel ?? tier.whitelabel,
    };
  }

  async checkTierLimits(businessId: string): Promise<TierCheckResult> {
    const { data: business } = await this.supabase
      .from('businesses')
      .select('subscription_tier, is_whitelabel')
      .eq('id', businessId)
      .single();

    return this.checkTierLimitsFromBusiness(
      businessId,
      business?.subscription_tier || null,
      business?.is_whitelabel,
    );
  }

  /**
   * Load all WhatsApp config in a single query (templates + alias + welcome buttons + quick replies).
   * Replaces 3 separate queries: getBotTemplates, getBotAlias, loadBotCustomConfig.
   */
  async loadWhatsAppConfigBundle(businessId: string): Promise<WhatsAppConfigBundle> {
    const { data } = await this.supabase
      .from('whatsapp_config')
      .select('bot_greeting, bot_confirmation_template, bot_reminder_template, bot_order_confirmation_template, bot_payment_receipt_template, bot_order_status_template, bot_alias, quick_replies, welcome_buttons, default_reply, auto_reply_enabled, business_hours, away_message, instant_reply_enabled, instant_reply_message')
      .eq('business_id', businessId)
      .maybeSingle();

    return {
      templates: {
        greeting: data?.bot_greeting || 'Welcome! How can I help you today?',
        confirmation: data?.bot_confirmation_template ||
          '✅ *Confirmed!*\n\n{business_name}\n📅 {date}\n🕐 {time}\n👥 {quantity} {quantity_label}\n🔑 Ref: *{reference_code}*\n\nThank you! 🎉',
        reminder: data?.bot_reminder_template ||
          '⏰ *Reminder*\n\nYour booking at {business_name} is tomorrow at {time}.\n\nRef: {reference_code}\n\nSee you there! 🎉',
        orderConfirmation: data?.bot_order_confirmation_template ||
          '✅ *Order Confirmed!*\n\n🏢 {business_name}\n📦 {service_name}\n💰 {amount}\n🔑 Ref: *{reference_code}*\n\nWe\'ll notify you when it\'s ready!',
        paymentReceipt: data?.bot_payment_receipt_template ||
          '🧾 *Payment Receipt*\n\n🏢 {business_name}\n💰 {amount}\n📅 {date} at {time}\n🔑 Ref: *{reference_code}*\n\nThank you for your payment! 🙏',
        orderStatus: data?.bot_order_status_template ||
          '📦 *Order Update*\n\nYour order at {business_name} is now: *{status}*\n🔑 Ref: {reference_code}',
      },
      alias: data?.bot_alias || null,
      welcome_buttons: (data?.welcome_buttons as WhatsAppConfigBundle['welcome_buttons']) || [],
      quick_replies: (data?.quick_replies as WhatsAppConfigBundle['quick_replies']) || [],
      default_reply: data?.default_reply || null,
      auto_reply_enabled: data?.auto_reply_enabled ?? false,
      business_hours: (data?.business_hours as Record<string, unknown>) || null,
      away_message: data?.away_message || null,
      instant_reply_enabled: data?.instant_reply_enabled ?? true,
      instant_reply_message: data?.instant_reply_message || null,
    };
  }

  async getBotTemplates(businessId: string): Promise<BotTemplates> {
    const { data } = await this.supabase
      .from('whatsapp_config')
      .select('bot_greeting, bot_confirmation_template, bot_reminder_template, bot_order_confirmation_template, bot_payment_receipt_template, bot_order_status_template')
      .eq('business_id', businessId)
      .maybeSingle();

    return {
      greeting: data?.bot_greeting || 'Welcome! How can I help you today?',
      confirmation: data?.bot_confirmation_template ||
        '✅ *Confirmed!*\n\n{business_name}\n📅 {date}\n🕐 {time}\n👥 {quantity} {quantity_label}\n🔑 Ref: *{reference_code}*\n\nThank you! 🎉',
      reminder: data?.bot_reminder_template ||
        '⏰ *Reminder*\n\nYour booking at {business_name} is tomorrow at {time}.\n\nRef: {reference_code}\n\nSee you there! 🎉',
      orderConfirmation: data?.bot_order_confirmation_template ||
        '✅ *Order Confirmed!*\n\n🏢 {business_name}\n📦 {service_name}\n💰 {amount}\n🔑 Ref: *{reference_code}*\n\nWe\'ll notify you when it\'s ready!',
      paymentReceipt: data?.bot_payment_receipt_template ||
        '🧾 *Payment Receipt*\n\n🏢 {business_name}\n💰 {amount}\n📅 {date} at {time}\n🔑 Ref: *{reference_code}*\n\nThank you for your payment! 🙏',
      orderStatus: data?.bot_order_status_template ||
        '📦 *Order Update*\n\nYour order at {business_name} is now: *{status}*\n🔑 Ref: {reference_code}',
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
    // Fix double-escaped unicode sequences (e.g. \\u2705 → ✅)
    result = result.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
    // Fix escaped newlines (literal \n in DB → actual newline)
    result = result.replace(/\\n/g, '\n');
    // Strip unreplaced {customer_name} if empty — avoids showing literal placeholder
    for (const [key, value] of Object.entries(vars)) {
      result = result.replace(new RegExp(`\\{${key}\\}`, 'g'), String(value));
    }
    // Clean up any remaining empty placeholders (unreplaced vars with empty values)
    result = result.replace(/^\s*\n/gm, (match) => match); // keep intentional blank lines
    return result.trim();
  }
}
