/**
 * #591 Phase 2 — Native Form Submission Handler.
 *
 * Secure handler for WhatsApp nfm_reply messages. Verifies the signed
 * flow token, uses pre-resolved channel identity (phone_number_id authority
 * from webhook), resolves customer_phone from webhook envelope (NEVER from
 * Flow payload), and persists the response with replay prevention via
 * flow_token_hash unique constraint.
 *
 * Security invariants:
 * - business_id from pre-resolved channel (phone_number_id), not payload
 * - customer_phone from webhook envelope message.from, not payload
 * - Expired/forged/replayed tokens rejected before any INSERT
 * - No booking creation, no payment, no scheduling RPC
 */
import { createServiceClient } from '@/lib/supabase/service';
import { verifyFlowToken, hashFlowToken } from './flow-token';
import type { WaaiioFormField } from './native-flow';

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

export interface ResolvedChannel {
  businessId: string;
  channelId: string;
  phoneNumberId: string;
}

export interface SubmissionResult {
  success: boolean;
  responseId?: string;
  duplicate?: boolean;
  error?: string;
}

// ── Answer Schema Validation ──

/** Max size per individual answer value in bytes. */
const MAX_ANSWER_SIZE_BYTES = 10 * 1024; // 10KB
/** Max total size of all answers combined in bytes. */
const MAX_TOTAL_ANSWERS_BYTES = 100 * 1024; // 100KB

/**
 * Validate submitted answers against the form's field schema.
 *
 * Rules:
 * - Reject unknown field IDs not in the schema
 * - Enforce required fields are present and non-empty
 * - For select/radio fields: validate value matches an allowed option
 * - Enforce max answer size (10KB per field, 100KB total)
 * - Type checking: number fields must be numeric, email must contain @
 */
function validateAnswersAgainstSchema(
  answers: Record<string, unknown>,
  fields: WaaiioFormField[],
): { valid: boolean; error?: string } {
  const fieldMap = new Map<string, WaaiioFormField>();
  for (const f of fields) {
    fieldMap.set(f.id, f);
  }

  // Check total size
  const totalJson = JSON.stringify(answers);
  if (Buffer.byteLength(totalJson, 'utf8') > MAX_TOTAL_ANSWERS_BYTES) {
    return { valid: false, error: 'Total answer payload exceeds 100KB limit.' };
  }

  // Reject unknown field IDs
  for (const key of Object.keys(answers)) {
    if (!fieldMap.has(key)) {
      return { valid: false, error: `Unknown field ID: ${key}` };
    }
  }

  // Validate each field
  for (const field of fields) {
    const value = answers[field.id];

    // Check required fields
    if (field.required) {
      if (value === undefined || value === null || value === '') {
        return { valid: false, error: `Required field missing: ${field.id}` };
      }
    }

    // Skip further checks if value is absent (optional field)
    if (value === undefined || value === null) continue;

    // Per-field size check
    const valueJson = JSON.stringify(value);
    if (Buffer.byteLength(valueJson, 'utf8') > MAX_ANSWER_SIZE_BYTES) {
      return { valid: false, error: `Answer for field ${field.id} exceeds 10KB limit.` };
    }

    const strValue = typeof value === 'string' ? value : String(value);

    // Type-specific validation
    if (field.type === 'number') {
      if (isNaN(Number(strValue))) {
        return { valid: false, error: `Field ${field.id} must be a numeric value.` };
      }
    }

    if (field.type === 'email') {
      if (!strValue.includes('@')) {
        return { valid: false, error: `Field ${field.id} must be a valid email address.` };
      }
    }

    // Select/radio option validation
    if (field.type === 'select' || field.type === 'radio') {
      if (Array.isArray(field.options) && field.options.length > 0) {
        const allowedValues = new Set(
          field.options.map((opt: unknown) => {
            if (typeof opt === 'string') return opt;
            if (opt && typeof opt === 'object' && 'value' in opt) return String((opt as { value: unknown }).value);
            if (opt && typeof opt === 'object' && 'id' in opt) return String((opt as { id: unknown }).id);
            return String(opt);
          }),
        );
        if (!allowedValues.has(strValue)) {
          return { valid: false, error: `Invalid option for field ${field.id}: ${strValue}` };
        }
      }
    }
  }

  return { valid: true };
}

// ── Public API ──

/**
 * Handle a native WhatsApp form submission (nfm_reply message).
 *
 * @param message - The raw nfm_reply message from the webhook payload
 * @param senderPhone - Phone number from webhook envelope (message.from), NOT from Flow payload
 * @param resolvedChannel - Pre-resolved channel from webhook's channel resolver (phone_number_id authority)
 */
export async function handleNativeFormSubmission(
  message: NfmReplyMessage,
  senderPhone: string,
  resolvedChannel: ResolvedChannel,
): Promise<SubmissionResult> {
  // ── 1. Validate resolved channel has a bound business ──
  if (!resolvedChannel.businessId) {
    return { success: false, error: 'Dedicated channel with bound business required for native form submissions.' };
  }
  const businessId = resolvedChannel.businessId;

  // ── 2. Extract flow_token and response data ──
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

  // ── 3. Extract formId from the token for verification ──
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
    .select('id, business_id, is_active, fields')
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

  // ── 8. Validate answers against form field schema ──
  const formFields = Array.isArray(form.fields) ? (form.fields as WaaiioFormField[]) : [];
  if (formFields.length > 0) {
    const schemaCheck = validateAnswersAgainstSchema(answers, formFields);
    if (!schemaCheck.valid) {
      return { success: false, error: schemaCheck.error || 'Answer validation failed.' };
    }
  }

  // ── 9. INSERT response (replay prevented by unique constraint on flow_token_hash) ──
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
      metadata: {
        source: 'whatsapp_nfm_reply',
        channel_id: resolvedChannel.channelId,
        phone_number_id: resolvedChannel.phoneNumberId,
      },
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

  // ── 10. Increment response count atomically (best-effort) ──
  await supabase.rpc('increment_form_response_count', { p_form_id: tokenFormId });

  return { success: true, responseId: response?.id };
}
