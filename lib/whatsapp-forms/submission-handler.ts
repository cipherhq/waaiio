/**
 * #591 Phase 2 — Native Form Submission Handler.
 *
 * Secure handler for WhatsApp nfm_reply messages. Verifies the signed
 * flow token, resolves business_id from channel (NEVER from Flow payload),
 * resolves customer_phone from webhook envelope (NEVER from Flow payload),
 * and persists the response with replay prevention via flow_token_hash
 * unique constraint.
 *
 * Security invariants:
 * - business_id from channel lookup, not payload
 * - customer_phone from webhook envelope message.from, not payload
 * - Expired/forged/replayed tokens rejected before any INSERT
 * - No booking creation, no payment, no scheduling RPC
 */
import { createServiceClient } from '@/lib/supabase/service';
import { verifyFlowToken, hashFlowToken } from './flow-token';

// ── Types ──

export interface NfmReplyMessage {
  /** The nfm_reply body containing flow_token and response_json. */
  interactive?: {
    type?: string;
    nfm_reply?: {
      response_json?: string;
      body?: string;
      name?: string;
    };
  };
}

export interface SubmissionResult {
  success: boolean;
  responseId?: string;
  duplicate?: boolean;
  error?: string;
}

// ── Helpers ──

/**
 * Resolve business_id from a WhatsApp channel by WABA ID.
 * Returns the business_id of the dedicated channel, or null for shared channels.
 */
async function resolveBusinessFromChannel(
  wabaId: string,
): Promise<string | null> {
  const supabase = createServiceClient({ noStore: true });

  const { data: channel } = await supabase
    .from('whatsapp_channels')
    .select('business_id, channel_type')
    .eq('waba_id', wabaId)
    .eq('is_active', true)
    .limit(1)
    .maybeSingle();

  if (!channel) return null;

  // Shared channels do not authoritatively bind to a business.
  // Native forms require a dedicated channel with a known business.
  if (channel.channel_type === 'shared') return null;

  return channel.business_id;
}

// ── Public API ──

/**
 * Handle a native WhatsApp form submission (nfm_reply message).
 *
 * @param message - The raw nfm_reply message from the webhook payload
 * @param senderPhone - Phone number from webhook envelope (message.from), NOT from Flow payload
 * @param wabaId - WABA ID from webhook metadata for channel resolution
 */
export async function handleNativeFormSubmission(
  message: NfmReplyMessage,
  senderPhone: string,
  wabaId: string,
): Promise<SubmissionResult> {
  // ── 1. Extract flow_token and response data ──
  const nfmReply = message?.interactive?.nfm_reply;
  if (!nfmReply?.response_json) {
    return { success: false, error: 'Missing nfm_reply response_json.' };
  }

  let responseData: Record<string, unknown>;
  try {
    responseData = JSON.parse(nfmReply.response_json);
  } catch {
    return { success: false, error: 'Invalid response_json format.' };
  }

  const flowToken = responseData.flow_token as string | undefined;
  if (!flowToken || typeof flowToken !== 'string') {
    return { success: false, error: 'Missing flow_token in response.' };
  }

  // ── 2. Resolve business_id from channel (NEVER from Flow payload) ──
  const businessId = await resolveBusinessFromChannel(wabaId);
  if (!businessId) {
    return { success: false, error: 'Could not resolve business from channel.' };
  }

  // ── 3. Extract formId from the token for verification ──
  // The formId is embedded in the signed token payload; verifyFlowToken
  // will validate it matches. We need to parse it to look up the form.
  let tokenFormId: string;
  try {
    const dotIdx = flowToken.indexOf('.');
    if (dotIdx < 1) throw new Error('bad');
    const payloadB64 = flowToken.slice(0, dotIdx);
    const payload = Buffer.from(payloadB64, 'base64url').toString('utf8');
    const parts = payload.split('|');
    if (parts.length < 1 || !parts[0]) throw new Error('bad');
    tokenFormId = parts[0];
  } catch {
    return { success: false, error: 'Could not parse flow token.' };
  }

  // ── 4. Verify flow_token signature and binding ──
  const verification = verifyFlowToken(flowToken, tokenFormId, senderPhone, businessId);
  if (!verification.valid) {
    return { success: false, error: verification.error || 'Token verification failed.' };
  }

  // ── 5. Look up form and verify it is active ──
  const supabase = createServiceClient({ noStore: true });
  const { data: form, error: formError } = await supabase
    .from('forms')
    .select('id, business_id, is_active')
    .eq('id', tokenFormId)
    .eq('business_id', businessId)
    .maybeSingle();

  if (formError || !form) {
    return { success: false, error: 'Form not found.' };
  }
  if (!form.is_active) {
    return { success: false, error: 'Form is no longer active.' };
  }

  // ── 6. Hash flow_token for replay prevention ──
  const tokenHash = hashFlowToken(flowToken);

  // ── 7. Separate consent from answer fields ──
  const { flow_token: _ft, _marketing_consent, ...answers } = responseData as Record<string, unknown>;
  const consentGiven = _marketing_consent === true ? true :
    _marketing_consent === false ? false : null;

  // ── 8. INSERT response (replay prevented by unique constraint on flow_token_hash) ──
  const { data: response, error: insertError } = await supabase
    .from('form_responses')
    .insert({
      form_id: tokenFormId,
      business_id: businessId,
      customer_phone: senderPhone,
      answers,
      submission_source: 'native',
      flow_token_hash: tokenHash,
      consent_given: consentGiven,
      metadata: { source: 'whatsapp_nfm_reply', waba_id: wabaId },
    })
    .select('id')
    .single();

  if (insertError) {
    // Unique constraint violation on flow_token_hash = replay attempt
    if (insertError.code === '23505' && insertError.message?.includes('flow_token_hash')) {
      return { success: false, duplicate: true, error: 'Duplicate submission (replay prevented).' };
    }
    return { success: false, error: 'Failed to save submission.' };
  }

  // ── 9. Increment response count (best-effort) ──
  // response_count is a convenience denormalization. The authoritative count
  // is always COUNT(*) on form_responses. Read-then-write is acceptable here
  // because native form submissions are low-frequency and the count is advisory.
  const { data: currentForm } = await supabase
    .from('forms')
    .select('response_count')
    .eq('id', tokenFormId)
    .single();

  if (currentForm) {
    await supabase
      .from('forms')
      .update({ response_count: (currentForm.response_count ?? 0) + 1 })
      .eq('id', tokenFormId);
  }

  return { success: true, responseId: response?.id };
}
