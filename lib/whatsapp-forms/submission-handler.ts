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
import { createHash } from 'crypto';
import { createServiceClient } from '@/lib/supabase/service';
import { verifyFlowToken, hashNonceForReplay } from './flow-token';
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

/** Max raw JSON size for response_json before parsing. */
const MAX_RESPONSE_JSON_BYTES = 102400; // 100KB

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
 * Validate submitted answers against the form's field schema and normalize
 * compiler-generated option IDs back to display titles.
 *
 * Rules:
 * - Reject unknown field IDs not in the schema
 * - Enforce required fields are present and non-empty
 * - For select/radio fields: validate value matches an allowed option
 *   and normalize option_N IDs to their display titles
 * - Enforce max answer size (10KB per field, 100KB total)
 * - Type checking: number fields must be numeric, email must contain @
 *
 * Returns normalized answers where compiler option IDs are resolved to
 * meaningful display titles, preserving historical query integrity.
 */
function validateAndNormalizeAnswers(
  answers: Record<string, unknown>,
  fields: WaaiioFormField[],
): { valid: boolean; error?: string; normalized?: Record<string, unknown> } {
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

  // Build normalized copy
  const normalized: Record<string, unknown> = { ...answers };

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

    // Reject object/array values for scalar fields before any string conversion.
    // String({}) → "[object Object]", String([1,2]) → "1,2" — both nonsensical.
    if (typeof value === 'object') {
      return { valid: false, error: `Field ${field.id} must be a scalar value, not ${Array.isArray(value) ? 'array' : 'object'}.` };
    }

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

    // Select/radio option validation and normalization
    if (field.type === 'select' || field.type === 'radio') {
      if (Array.isArray(field.options) && field.options.length > 0) {
        // Build lookup: display titles and compiler option IDs → display title
        const displayTitles = new Set<string>();
        const optionIdToTitle = new Map<string, string>();

        field.options.forEach((opt: unknown, i: number) => {
          let title: string | undefined;
          if (typeof opt === 'string') title = opt.trim();
          else if (opt && typeof opt === 'object' && 'value' in opt) title = String((opt as { value: unknown }).value);
          else if (opt && typeof opt === 'object' && 'id' in opt) title = String((opt as { id: unknown }).id);
          if (title) {
            displayTitles.add(title);
            optionIdToTitle.set('option_' + (i + 1), title);
          }
        });

        if (displayTitles.has(strValue)) {
          // Already a display title (web submission) — keep as-is
        } else if (optionIdToTitle.has(strValue)) {
          // Compiler-generated option ID (native submission) — normalize to display title
          normalized[field.id] = optionIdToTitle.get(strValue)!;
        } else {
          return { valid: false, error: `Invalid option for field ${field.id}: ${strValue}` };
        }
      }
    }
  }

  return { valid: true, normalized };
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
  // ── 1. Validate resolved channel has all required fields ──
  if (!resolvedChannel.businessId || !resolvedChannel.channelId || !resolvedChannel.phoneNumberId) {
    return { success: false, error: 'Fully resolved dedicated channel required (businessId, channelId, phoneNumberId).' };
  }
  const businessId = resolvedChannel.businessId;

  // ── 2. Extract flow_token and response data ──
  const nfmReply = message?.interactive?.nfm_reply;
  if (!nfmReply?.response_json) {
    return { success: false, error: 'Missing nfm_reply response_json.' };
  }

  // Raw JSON size guard before parsing (byte length, not character count)
  if (Buffer.byteLength(nfmReply.response_json, 'utf8') > MAX_RESPONSE_JSON_BYTES) {
    return { success: false, error: 'response_json exceeds maximum size.' };
  }

  let responseData: Record<string, unknown>;
  try {
    const parsed = JSON.parse(nfmReply.response_json);
    // JSON.parse can return null, arrays, primitives — reject all non-object results
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { success: false, error: 'response_json must be a JSON object.' };
    }
    responseData = parsed;
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
    .select('id, business_id, is_active, fields, settings')
    .eq('id', tokenFormId)
    .eq('business_id', businessId)
    .maybeSingle();

  if (formError || !form) {
    return { success: false, error: 'Form not found.' };
  }
  if (!form.is_active) {
    return { success: false, error: 'Form is no longer active.' };
  }

  // ── 5b. Form-version binding ──
  // The token's formVersionHash was signed at send time against the form's
  // effective configuration (field schema + consent label). Reject if either
  // changed after delivery — the customer saw version A but we'd validate,
  // normalize, and record consent against version B.
  const formSettings = form.settings as Record<string, unknown> | null;
  const consentLabel = typeof formSettings?.consent_label === 'string'
    ? (formSettings.consent_label as string).trim() : '';
  const currentVersionHash = createHash('sha256')
    .update(JSON.stringify({ fields: form.fields, consentLabel }))
    .digest('hex');
  if (verification.formVersionHash !== currentVersionHash) {
    return { success: false, error: 'Form configuration changed after this form was sent. Submission rejected.' };
  }

  // ── 6. Hash verified nonce for replay prevention ──
  // Replay identity is the nonce (immutable signed claim), not the serialized
  // token string. This ensures equivalent serializations cannot bypass replay.
  const nonceHash = hashNonceForReplay(verification.nonce!);

  // ── 7. Separate reserved keys from answer fields ──
  // flow_token is the signed token; _marketing_consent is the OptIn value.
  const { flow_token: _ft, _marketing_consent, ...answers } = responseData as Record<string, unknown>;

  // Only accept marketing consent when the published Form version provably
  // presented a consent prompt (settings.consent_label is set and non-empty).
  // consentLabel was already extracted and verified in the version-binding check.
  const formHasConsentPrompt = consentLabel.length > 0;
  const consentGiven = formHasConsentPrompt
    ? (_marketing_consent === true ? true : _marketing_consent === false ? false : null)
    : null; // No consent prompt → ignore any _marketing_consent value

  // ── 8. Validate and normalize answers against form field schema ──
  // Native submissions require a valid field schema — the form must have compiled
  // successfully to be published. Reject if fields are empty/null/non-array/zero-length.
  const formFields = Array.isArray(form.fields) ? (form.fields as WaaiioFormField[]) : null;
  if (!formFields || formFields.length === 0) {
    return { success: false, error: 'Form has no valid field schema for native submission validation.' };
  }
  // Reject if form schema uses a reserved field ID that would collide with
  // the signed token or consent key during answer extraction.
  if (formFields.some(f => f.id === 'flow_token')) {
    return { success: false, error: 'Form contains a reserved field ID (flow_token). Native submissions cannot use this field name.' };
  }
  const schemaCheck = validateAndNormalizeAnswers(answers, formFields);
  if (!schemaCheck.valid) {
    return { success: false, error: schemaCheck.error || 'Answer validation failed.' };
  }
  // Use normalized answers (compiler option IDs resolved to display titles)
  const normalizedAnswers = schemaCheck.normalized ?? answers;

  // ── 9. Extract customer_name and customer_email from validated answers ──
  // Preserves the web-form convention where these are stored as top-level
  // response columns for dashboard display. Uses field type (email) and
  // conventional field IDs (name, full_name) — does not invent identities.
  let customerName: string | null = null;
  let customerEmail: string | null = null;
  for (const field of formFields) {
    const val = normalizedAnswers[field.id];
    if (typeof val !== 'string' || !val.trim()) continue;
    if (field.type === 'email' && !customerEmail) {
      customerEmail = val.trim().slice(0, 200);
    }
    if (!customerName && (field.id === 'name' || field.id === 'full_name' || field.id === 'customer_name')) {
      customerName = val.trim().slice(0, 200);
    }
  }

  // ── 10. INSERT response (replay prevented by unique constraint on flow_token_hash) ──
  // Note: response_count increment (step 11) is best-effort, matching the
  // existing web form route (app/api/forms/submit/route.ts:126). Both paths
  // use a separate RPC call after INSERT. A broader atomic-counter correction
  // is tracked separately.
  const { data: response, error: insertError } = await supabase
    .from('form_responses')
    .insert({
      form_id: tokenFormId,
      business_id: businessId,
      customer_phone: senderPhone,
      customer_name: customerName,
      customer_email: customerEmail,
      answers: normalizedAnswers,
      submission_source: 'native',
      flow_token_hash: nonceHash,
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

  // ── 11. Increment response count (best-effort) ──
  await supabase.rpc('increment_form_response_count', { p_form_id: tokenFormId });

  return { success: true, responseId: response?.id };
}
