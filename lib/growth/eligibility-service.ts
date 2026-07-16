import type { SupabaseClient } from '@supabase/supabase-js';
import { verifyConsent } from './consent-service';
import { logger } from '@/lib/logger';

export type EligibilityStatus =
  | 'template_eligible'  // Can send WhatsApp template
  | 'service_window'     // Inside 24hr window, can send any message
  | 'needs_consent'      // Must obtain consent first
  | 'opted_out'          // Customer opted out
  | 'never_contacted'    // No prior contact
  | 'unknown_consent';   // Consent status unclear

export interface EligibilityResult {
  status: EligibilityStatus;
  reason: string;
  recommendedChannel: 'whatsapp_template' | 'sms_invite' | 'email_invite' | 'needs_consent' | 'blocked';
  canSendWhatsApp: boolean;
  canSendSMS: boolean;
  canSendEmail: boolean;
}

export async function getEligibility(
  supabase: SupabaseClient,
  phone: string,
  businessId: string,
  email?: string,
): Promise<EligibilityResult> {
  try {
    // 1. Check opt-out
    const { data: optOut } = await supabase
      .from('messaging_opt_outs')
      .select('id')
      .eq('phone', phone)
      .eq('business_id', businessId)
      .is('resubscribed_at', null)
      .maybeSingle();

    if (optOut) {
      return {
        status: 'opted_out',
        reason: 'Customer has opted out of messages',
        recommendedChannel: 'blocked',
        canSendWhatsApp: false,
        canSendSMS: false,
        canSendEmail: false,
      };
    }

    // 2. Check 24hr service window (recent bot session)
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data: recentSession } = await supabase
      .from('bot_sessions')
      .select('id')
      .eq('business_id', businessId)
      .eq('whatsapp_number', phone)
      .gte('updated_at', twentyFourHoursAgo)
      .limit(1)
      .maybeSingle();

    if (recentSession) {
      return {
        status: 'service_window',
        reason: 'Customer messaged within 24 hours',
        recommendedChannel: 'whatsapp_template',
        canSendWhatsApp: true,
        canSendSMS: false,
        canSendEmail: false,
      };
    }

    // 3. Check WhatsApp marketing consent
    const waConsent = await verifyConsent(supabase, {
      phone, businessId, channel: 'whatsapp', purpose: 'marketing',
    });

    if (waConsent.hasConsent) {
      return {
        status: 'template_eligible',
        reason: 'Has WhatsApp marketing consent',
        recommendedChannel: 'whatsapp_template',
        canSendWhatsApp: true,
        canSendSMS: false,
        canSendEmail: !!email,
      };
    }

    // 4. No consent — determine best acquisition channel
    const { data: smsConsent } = await supabase
      .from('customer_consents')
      .select('status')
      .eq('business_id', businessId)
      .eq('phone', phone)
      .eq('channel', 'sms')
      .eq('status', 'granted')
      .limit(1)
      .maybeSingle();

    if (smsConsent) {
      return {
        status: 'needs_consent',
        reason: 'Has SMS consent but not WhatsApp',
        recommendedChannel: 'sms_invite',
        canSendWhatsApp: false,
        canSendSMS: true,
        canSendEmail: !!email,
      };
    }

    if (email) {
      return {
        status: 'needs_consent',
        reason: 'No WhatsApp or SMS consent, has email',
        recommendedChannel: 'email_invite',
        canSendWhatsApp: false,
        canSendSMS: false,
        canSendEmail: true,
      };
    }

    return {
      status: 'never_contacted',
      reason: 'No consent and no contact history',
      recommendedChannel: 'needs_consent',
      canSendWhatsApp: false,
      canSendSMS: false,
      canSendEmail: false,
    };
  } catch (err) {
    logger.error('[ELIGIBILITY] Check failed:', err);
    return {
      status: 'unknown_consent',
      reason: 'Could not determine eligibility',
      recommendedChannel: 'needs_consent',
      canSendWhatsApp: false,
      canSendSMS: false,
      canSendEmail: false,
    };
  }
}
