import type { SupabaseClient } from '@supabase/supabase-js';
import type { MessageSender } from '@/lib/channels/message-sender';
import { newOptInNonce, pendingEvidence, OPTIN_POLICY_VERSION, OPTIN_REQUEST_TTL_MS, SENT_REQUEST_RE, sendOptInConfirmationRequest } from '@/lib/consent/optin-confirmation';
import type { CapturedNativeResponse } from './runtime';

/** Only invoked by the once-claimed native acknowledgement, never merchant input. */
export async function requestNativeWhatsAppConsent(db: SupabaseClient, captured: CapturedNativeResponse, sender: MessageSender) {
  if (!captured.whatsappRequested) return;
  const { data: latest, error: readError } = await db.from('customer_consents').select('status,evidence_reference,created_at,expires_at')
    .eq('business_id', captured.businessId).in('phone', [captured.phone, `+${captured.phone}`])
    .eq('channel', 'whatsapp').eq('purpose', 'marketing').order('created_at', { ascending: false })
    .order('id', { ascending: false }).limit(1).maybeSingle();
  if (readError) return;
  if (latest?.status === 'granted' && (!latest.expires_at || Date.parse(latest.expires_at) > Date.now())) return;
  const age = Date.now() - Date.parse(latest?.created_at || '');
  if (latest?.status === 'pending' && SENT_REQUEST_RE.test(latest.evidence_reference || '')
    && age >= 0 && age <= OPTIN_REQUEST_TTL_MS) return;
  const nonce = newOptInNonce();
  const evidence = pendingEvidence(captured.formId, nonce);
  const { data, error } = await db.from('customer_consents').insert({ business_id: captured.businessId,
    phone: `+${captured.phone}`, channel: 'whatsapp', purpose: 'marketing', status: 'pending', source: 'whatsapp',
    evidence_reference: evidence, policy_version: OPTIN_POLICY_VERSION,
  }).select('id').single();
  if (error || !data) return;
  await sendOptInConfirmationRequest(db, { businessId: captured.businessId, phone: captured.phone,
    requestId: data.id, nonce, evidenceReference: evidence, nativeResponseId: captured.responseId, sender });
}
