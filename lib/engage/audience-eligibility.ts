/**
 * Audience Eligibility — E1 (#557)
 *
 * Computes marketing preview eligibility only.
 * Does NOT send messages. Does NOT manufacture consent.
 *
 * WhatsApp marketing eligible requires:
 * - canonical phone identity
 * - explicit customer_consents row: channel='whatsapp', purpose='marketing', status='granted'
 * - consent not expired
 * - no applicable active global/business opt-out for 'all' or 'marketing'
 *
 * Email marketing eligible requires:
 * - email present
 * - canonical phone identity (consent is phone-keyed)
 * - explicit customer_consents row: channel='email', purpose='marketing', status='granted'
 * - consent not expired
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { AudienceIdentity } from './audience-resolver';

export interface EligibilityResult {
  identity: AudienceIdentity;
  whatsappEligible: boolean;
  emailEligible: boolean;
}

export interface AudiencePreviewResult {
  total: number;
  whatsappEligible: number;
  emailEligible: number;
  sample: EligibilityResult[];
}

const SAMPLE_SIZE = 5;

export async function computeAudienceEligibility(
  service: SupabaseClient,
  businessId: string,
  audience: Map<string, AudienceIdentity>,
): Promise<AudiencePreviewResult> {
  if (audience.size === 0) {
    return { total: 0, whatsappEligible: 0, emailEligible: 0, sample: [] };
  }

  // Collect all phones that need consent/opt-out lookups
  const phonesToCheck: string[] = [];
  for (const identity of audience.values()) {
    if (identity.phone) phonesToCheck.push(identity.phone);
  }

  // Batch-load consents for all phones in this business
  const consentMap = await loadConsents(service, businessId, phonesToCheck);

  // Batch-load opt-outs for all phones
  const optOutMap = await loadOptOuts(service, businessId, phonesToCheck);

  let whatsappCount = 0;
  let emailCount = 0;
  const results: EligibilityResult[] = [];

  for (const identity of audience.values()) {
    const whatsappEligible = checkWhatsAppEligibility(identity, consentMap, optOutMap);
    const emailEligible = checkEmailEligibility(identity, consentMap, optOutMap);

    if (whatsappEligible) whatsappCount++;
    if (emailEligible) emailCount++;

    results.push({ identity, whatsappEligible, emailEligible });
  }

  // Take a deterministic sample (first N by key sort)
  const sorted = results.sort((a, b) => a.identity.key.localeCompare(b.identity.key));
  const sample = sorted.slice(0, SAMPLE_SIZE);

  return {
    total: audience.size,
    whatsappEligible: whatsappCount,
    emailEligible: emailCount,
    sample,
  };
}

// ── Consent loading ──

interface ConsentRecord {
  phone: string;
  channel: string;
  purpose: string;
  status: string;
  expires_at: string | null;
}

async function loadConsents(
  service: SupabaseClient,
  businessId: string,
  phones: string[],
): Promise<Map<string, ConsentRecord[]>> {
  const result = new Map<string, ConsentRecord[]>();
  if (phones.length === 0) return result;

  // Batch in chunks of 100 to avoid query limits
  const chunks = chunkArray(phones, 100);
  for (const chunk of chunks) {
    const { data, error } = await service
      .from('customer_consents')
      .select('phone, channel, purpose, status, expires_at')
      .eq('business_id', businessId)
      .in('phone', chunk);

    if (error) throw error;
    for (const row of data || []) {
      const existing = result.get(row.phone) || [];
      existing.push(row);
      result.set(row.phone, existing);
    }
  }
  return result;
}

// ── Opt-out loading ──

interface OptOutRecord {
  phone: string;
  business_id: string | null;
  channel: string;
  opt_out_type: string;
  resubscribed_at: string | null;
}

async function loadOptOuts(
  service: SupabaseClient,
  businessId: string,
  phones: string[],
): Promise<Map<string, OptOutRecord[]>> {
  const result = new Map<string, OptOutRecord[]>();
  if (phones.length === 0) return result;

  const chunks = chunkArray(phones, 100);
  for (const chunk of chunks) {
    // Load both global (business_id IS NULL) and business-specific opt-outs
    const { data, error } = await service
      .from('messaging_opt_outs')
      .select('phone, business_id, channel, opt_out_type, resubscribed_at')
      .in('phone', chunk)
      .is('resubscribed_at', null);

    if (error) throw error;
    for (const row of data || []) {
      // Only include global opt-outs or opt-outs for this specific business
      if (row.business_id === null || row.business_id === businessId) {
        const existing = result.get(row.phone) || [];
        existing.push(row);
        result.set(row.phone, existing);
      }
    }
  }
  return result;
}

// ── Eligibility checks ──

function checkWhatsAppEligibility(
  identity: AudienceIdentity,
  consentMap: Map<string, ConsentRecord[]>,
  optOutMap: Map<string, OptOutRecord[]>,
): boolean {
  // Must have a phone
  if (!identity.phone) return false;

  // Check for active opt-out (all or marketing)
  const optOuts = optOutMap.get(identity.phone) || [];
  for (const optOut of optOuts) {
    if (
      (optOut.channel === 'whatsapp' || optOut.channel === 'all') &&
      (optOut.opt_out_type === 'all' || optOut.opt_out_type === 'marketing')
    ) {
      return false;
    }
  }

  // Check for explicit granted consent
  const consents = consentMap.get(identity.phone) || [];
  const now = new Date();

  for (const consent of consents) {
    if (
      consent.channel === 'whatsapp' &&
      consent.purpose === 'marketing' &&
      consent.status === 'granted'
    ) {
      // Check expiration
      if (consent.expires_at && new Date(consent.expires_at) <= now) {
        continue; // expired, check next consent
      }
      return true;
    }
  }

  // No valid consent found
  return false;
}

function checkEmailEligibility(
  identity: AudienceIdentity,
  consentMap: Map<string, ConsentRecord[]>,
  optOutMap: Map<string, OptOutRecord[]>,
): boolean {
  // Must have email
  if (!identity.email) return false;

  // Must have phone (consent is phone-keyed in E1)
  if (!identity.phone) return false;

  // Check for active opt-out
  const optOuts = optOutMap.get(identity.phone) || [];
  for (const optOut of optOuts) {
    if (
      (optOut.channel === 'email' || optOut.channel === 'all') &&
      (optOut.opt_out_type === 'all' || optOut.opt_out_type === 'marketing')
    ) {
      return false;
    }
  }

  // Check for explicit granted consent
  const consents = consentMap.get(identity.phone) || [];
  const now = new Date();

  for (const consent of consents) {
    if (
      consent.channel === 'email' &&
      consent.purpose === 'marketing' &&
      consent.status === 'granted'
    ) {
      if (consent.expires_at && new Date(consent.expires_at) <= now) {
        continue;
      }
      return true;
    }
  }

  return false;
}

// ── Helpers ──

function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}
