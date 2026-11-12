import { createHash } from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { sendEmail } from '@/lib/email/client';
import { hasEmailMarketingPermission, normalizeConsentEmail } from './email-consent';
import { emailUnsubscribeToken } from './email-unsubscribe';
import { nativeFormsEnabled } from './release-gate';

const escape = (value: string) => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
export interface NativeEmailResult { accepted: number; skipped: number; unknown: number; total: number }
const requestHash = (responseIds: string[], message: string) => createHash('sha256')
  .update(JSON.stringify({ message, responseIds: [...responseIds].sort() })).digest('hex');

/** Authorized retrieval precedes new-send quota checks; it never sends or charges. */
export async function existingNativeEmailBatch(db: SupabaseClient, businessId: string, requestId: string,
  responseIds: string[], message: string): Promise<NativeEmailResult | null> {
  const { data, error } = await db.from('native_form_email_batches').select('request_hash,result')
    .eq('id', requestId).eq('business_id', businessId).maybeSingle();
  if (error) throw new Error('Email batch lookup unavailable.');
  if (!data) return null;
  if (data.request_hash !== requestHash(responseIds, message)) throw new Error('This request ID was used for a different batch.');
  if (!data.result) throw new Error('Email batch is pending or needs reconciliation. Do not resend it.');
  return data.result as NativeEmailResult;
}

export async function dispatchNativeFormEmails(input: {
  db: SupabaseClient; businessId: string; businessName: string; responseIds: string[]; requestId: string; message: string;
}) {
  const { db, businessId, businessName, responseIds, requestId, message } = input;
  if (!nativeFormsEnabled()) throw new Error('Native form emails are not enabled.');
  if (!process.env.RESEND_API_KEY) throw new Error('Email provider unavailable.');
  const base = process.env.NEXT_PUBLIC_APP_URL;
  if (!base || !/^https:\/\/[^/]+$/.test(base)) throw new Error('Email link origin unavailable.');
  const hash = requestHash(responseIds, message);
  const { data: responses, error } = await db.from('form_responses').select('id,customer_email,customer_phone')
    .eq('business_id', businessId).eq('submission_source', 'native').in('id', responseIds);
  if (error || !responses || responses.length !== responseIds.length) throw new Error('Some selected responses are unavailable.');
  // Persist once before provider emission. Browser retries never repeat a batch.
  const { error: claimError } = await db.from('native_form_email_batches').insert({ id: requestId, business_id: businessId, request_hash: hash });
  if (claimError) {
    if (claimError.code !== '23505') throw new Error('Email batch reservation unavailable.');
    const { data: existing, error: lookupError } = await db.from('native_form_email_batches').select('request_hash,result').eq('id', requestId).eq('business_id', businessId).maybeSingle();
    if (lookupError || existing?.request_hash !== hash || !existing.result) throw new Error('Email batch is pending or the request changed.');
    return existing.result as { accepted: number; skipped: number; unknown: number; total: number };
  }
  const result = { accepted: 0, skipped: 0, unknown: 0, total: responses.length };
  // Count this claimed request once using the existing broadcast usage authority.
  const { error: usageError } = await db.rpc('increment_broadcast_usage', { p_business_id: businessId, p_recipient_count: responses.length });
  if (usageError) throw new Error('Broadcast usage could not be reserved. No email was sent.');
  const seen = new Set<string>();
  const deadline = Date.now() + 40_000;
  for (const response of responses) {
    const address = normalizeConsentEmail(response.customer_email);
    const phone = String(response.customer_phone || '').replace(/^\+/, '');
    if (!address || seen.has(address) || Date.now() >= deadline
      || !await hasEmailMarketingPermission(db, businessId, address, phone)) { result.skipped++; continue; }
    seen.add(address);
    const unsubscribe = `${base}/forms/email-unsubscribe?token=${emailUnsubscribeToken(businessId, address, phone)}`;
    try {
      const delivery = await sendEmail({ to: address, subject: `${businessName} — updates`.slice(0, 200), noRetry: true,
        html: `<h1>${escape(businessName)}</h1><p>${escape(message).replace(/\n/g, '<br>')}</p><p><a href="${escape(unsubscribe)}">Unsubscribe from these emails</a></p>` });
      if (delivery.success && 'id' in delivery && delivery.id) result.accepted++;
      else result.unknown++;
    } catch { result.unknown++; }
  }
  const { error: saveError } = await db.from('native_form_email_batches').update({ result }).eq('id', requestId).eq('business_id', businessId);
  if (saveError) throw new Error('Email results need reconciliation. Do not resend this batch.');
  return result;
}
