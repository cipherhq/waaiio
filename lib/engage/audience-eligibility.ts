/**
 * Audience Eligibility — E1 (#557)
 *
 * Computes marketing preview eligibility only.
 * Does NOT send messages. Does NOT manufacture consent.
 *
 * E1-ELIG-1 remediation: consent and opt-out reads are count-verified
 * and paginated to prevent PostgREST max_rows silent truncation.
 * Missing or incomplete consent/opt-out data fails closed (ineligible).
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

/** Page size for paginated consent/opt-out reads (well under PostgREST max_rows) */
const ELIGIBILITY_PAGE_SIZE = 500;

export class EligibilityDataIncompleteError extends Error {
  constructor(table: string, expected: number, actual: number) {
    super(`Eligibility data incomplete: ${table} expected ${expected} rows, got ${actual}. Failing closed.`);
    this.name = 'EligibilityDataIncompleteError';
  }
}

export async function computeAudienceEligibility(
  service: SupabaseClient,
  businessId: string,
  audience: Map<string, AudienceIdentity>,
): Promise<AudiencePreviewResult> {
  if (audience.size === 0) {
    return { total: 0, whatsappEligible: 0, emailEligible: 0, sample: [] };
  }

  const phonesToCheck: string[] = [];
  for (const identity of audience.values()) {
    if (identity.phone) phonesToCheck.push(identity.phone);
  }

  const consentMap = await loadConsents(service, businessId, phonesToCheck);
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

  const sorted = results.sort((a, b) => a.identity.key.localeCompare(b.identity.key));
  const sample = sorted.slice(0, SAMPLE_SIZE);

  return {
    total: audience.size,
    whatsappEligible: whatsappCount,
    emailEligible: emailCount,
    sample,
  };
}

// ── Consent loading (E1-ELIG-1: count-verified paginated reads) ──

interface ConsentRecord {
  phone: string;
  channel: string;
  purpose: string;
  status: string;
  expires_at: string | null;
}

/**
 * E1-ELIG-1: Load consents with count-verified paginated reads.
 *
 * Strategy: chunk phones into batches of 20 (keeping result rows well under
 * max_rows even with many consent records per phone). For each chunk:
 * 1. Count exact matching rows
 * 2. Paginated fetch in pages of ELIGIBILITY_PAGE_SIZE
 * 3. Verify fetched rows === count (fail closed on mismatch)
 *
 * Scoped to business_id in the query — only this business's consents.
 */
async function loadConsents(
  service: SupabaseClient,
  businessId: string,
  phones: string[],
): Promise<Map<string, ConsentRecord[]>> {
  const result = new Map<string, ConsentRecord[]>();
  if (phones.length === 0) return result;

  const chunks = chunkArray(phones, 20);
  for (const chunk of chunks) {
    // Step 1: Count
    const { count, error: countError } = await service
      .from('customer_consents')
      .select('*', { count: 'exact', head: true })
      .eq('business_id', businessId)
      .in('phone', chunk);

    if (countError) throw countError;
    if (count === null || count === undefined) {
      throw new EligibilityDataIncompleteError('customer_consents', -1, 0);
    }
    if (count === 0) continue;

    // Step 2: Paginated fetch
    const rows: ConsentRecord[] = [];
    let offset = 0;
    while (true) {
      const { data, error } = await service
        .from('customer_consents')
        .select('phone, channel, purpose, status, expires_at')
        .eq('business_id', businessId)
        .in('phone', chunk)
        .order('phone', { ascending: true })
        .order('id', { ascending: true })
        .range(offset, offset + ELIGIBILITY_PAGE_SIZE - 1);

      if (error) throw error;
      if (!data || data.length === 0) break;
      rows.push(...data);
      if (data.length < ELIGIBILITY_PAGE_SIZE) break;
      offset += ELIGIBILITY_PAGE_SIZE;
    }

    // Step 3: Verify completeness — fail closed
    if (rows.length !== count) {
      throw new EligibilityDataIncompleteError('customer_consents', count, rows.length);
    }

    for (const row of rows) {
      const existing = result.get(row.phone) || [];
      existing.push(row);
      result.set(row.phone, existing);
    }
  }
  return result;
}

// ── Opt-out loading (E1-ELIG-1: SQL-scoped + count-verified) ──

interface OptOutRecord {
  phone: string;
  business_id: string | null;
  channel: string;
  opt_out_type: string;
  resubscribed_at: string | null;
}

/**
 * E1-ELIG-1: Load opt-outs with SQL-scoped filtering and count-verified reads.
 *
 * CTO fix: push global/business scoping INTO the query instead of fetching
 * all businesses' opt-outs and filtering in-app. Uses PostgREST .or() to
 * include both global (business_id IS NULL) and business-specific opt-outs.
 *
 * Same count-verify-paginate strategy as loadConsents.
 */
async function loadOptOuts(
  service: SupabaseClient,
  businessId: string,
  phones: string[],
): Promise<Map<string, OptOutRecord[]>> {
  const result = new Map<string, OptOutRecord[]>();
  if (phones.length === 0) return result;

  const chunks = chunkArray(phones, 20);
  for (const chunk of chunks) {
    // Step 1: Count — with business scoping in SQL
    const { count, error: countError } = await service
      .from('messaging_opt_outs')
      .select('*', { count: 'exact', head: true })
      .in('phone', chunk)
      .is('resubscribed_at', null)
      .or(`business_id.is.null,business_id.eq.${businessId}`);

    if (countError) throw countError;
    if (count === null || count === undefined) {
      throw new EligibilityDataIncompleteError('messaging_opt_outs', -1, 0);
    }
    if (count === 0) continue;

    // Step 2: Paginated fetch with SQL-scoped business filter
    const rows: OptOutRecord[] = [];
    let offset = 0;
    while (true) {
      const { data, error } = await service
        .from('messaging_opt_outs')
        .select('phone, business_id, channel, opt_out_type, resubscribed_at')
        .in('phone', chunk)
        .is('resubscribed_at', null)
        .or(`business_id.is.null,business_id.eq.${businessId}`)
        .order('phone', { ascending: true })
        .order('id', { ascending: true })
        .range(offset, offset + ELIGIBILITY_PAGE_SIZE - 1);

      if (error) throw error;
      if (!data || data.length === 0) break;
      rows.push(...data);
      if (data.length < ELIGIBILITY_PAGE_SIZE) break;
      offset += ELIGIBILITY_PAGE_SIZE;
    }

    // Step 3: Verify completeness
    if (rows.length !== count) {
      throw new EligibilityDataIncompleteError('messaging_opt_outs', count, rows.length);
    }

    for (const row of rows) {
      const existing = result.get(row.phone) || [];
      existing.push(row);
      result.set(row.phone, existing);
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
      if (consent.expires_at && new Date(consent.expires_at) <= now) {
        continue;
      }
      return true;
    }
  }

  return false;
}

function checkEmailEligibility(
  identity: AudienceIdentity,
  consentMap: Map<string, ConsentRecord[]>,
  optOutMap: Map<string, OptOutRecord[]>,
): boolean {
  if (!identity.email) return false;
  if (!identity.phone) return false;

  const optOuts = optOutMap.get(identity.phone) || [];
  for (const optOut of optOuts) {
    if (
      (optOut.channel === 'email' || optOut.channel === 'all') &&
      (optOut.opt_out_type === 'all' || optOut.opt_out_type === 'marketing')
    ) {
      return false;
    }
  }

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
