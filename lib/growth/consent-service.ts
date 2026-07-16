import type { SupabaseClient } from '@supabase/supabase-js';
import { logger } from '@/lib/logger';

export type ConsentChannel = 'whatsapp' | 'sms' | 'email';
export type ConsentPurpose = 'utility' | 'marketing' | 'authentication';
export type ConsentStatus = 'granted' | 'revoked' | 'pending' | 'unknown';
export type ConsentSource = 'website' | 'checkout' | 'qr' | 'pos' | 'event' | 'paper' | 'crm_import' | 'manual' | 'sms' | 'whatsapp' | 'api';

export async function grantConsent(supabase: SupabaseClient, params: {
  phone: string;
  businessId: string;
  channel: ConsentChannel;
  purpose: ConsentPurpose;
  source: ConsentSource;
  evidenceReference?: string;
  createdBy?: string;
}): Promise<{ success: boolean; error?: string }> {
  // Insert new consent record (append-only)
  const { error } = await supabase.from('customer_consents').insert({
    business_id: params.businessId,
    phone: params.phone,
    channel: params.channel,
    purpose: params.purpose,
    status: 'granted',
    source: params.source,
    evidence_reference: params.evidenceReference || null,
    granted_at: new Date().toISOString(),
    created_by: params.createdBy || null,
  });
  if (error) {
    logger.error('[CONSENT] Grant failed:', error.message);
    return { success: false, error: error.message };
  }
  return { success: true };
}

export async function revokeConsent(supabase: SupabaseClient, params: {
  phone: string;
  businessId: string;
  channel: ConsentChannel;
  purpose?: ConsentPurpose;
}): Promise<{ success: boolean }> {
  // Revoke specified purpose or all purposes (append-only, don't update existing)
  const purposes: ConsentPurpose[] = params.purpose
    ? [params.purpose]
    : ['utility', 'marketing', 'authentication'];

  for (const purpose of purposes) {
    const { error } = await supabase.from('customer_consents').insert({
      business_id: params.businessId,
      phone: params.phone,
      channel: params.channel,
      purpose,
      status: 'revoked',
      source: 'whatsapp',
      revoked_at: new Date().toISOString(),
    });
    if (error) logger.error('[CONSENT] Revoke failed for purpose', purpose, ':', error.message);
  }
  return { success: true };
}

export async function verifyConsent(supabase: SupabaseClient, params: {
  phone: string;
  businessId: string;
  channel: ConsentChannel;
  purpose: ConsentPurpose;
}): Promise<{ hasConsent: boolean; status: ConsentStatus; grantedAt?: string }> {
  // Get the latest consent record for this phone/business/channel/purpose
  const { data } = await supabase
    .from('customer_consents')
    .select('status, granted_at, revoked_at, expires_at')
    .eq('business_id', params.businessId)
    .eq('phone', params.phone)
    .eq('channel', params.channel)
    .eq('purpose', params.purpose)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!data) return { hasConsent: false, status: 'unknown' };
  // Check if consent has expired
  if (data.status === 'granted' && data.expires_at && new Date(data.expires_at) < new Date()) {
    return { hasConsent: false, status: 'unknown' };
  }
  return {
    hasConsent: data.status === 'granted',
    status: data.status as ConsentStatus,
    grantedAt: data.granted_at,
  };
}

export async function getConsentHistory(supabase: SupabaseClient, params: {
  phone: string;
  businessId: string;
}): Promise<Array<{ channel: string; purpose: string; status: string; source: string; created_at: string }>> {
  const { data } = await supabase
    .from('customer_consents')
    .select('channel, purpose, status, source, created_at')
    .eq('business_id', params.businessId)
    .eq('phone', params.phone)
    .order('created_at', { ascending: false })
    .limit(50);
  return data || [];
}
