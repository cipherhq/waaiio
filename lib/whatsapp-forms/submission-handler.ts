/**
 * #591 — Handle inbound nfm_reply submissions from WhatsApp Flows.
 *
 * This module processes form responses received via the Meta webhook
 * when a customer completes a native WhatsApp Flow.
 *
 * Security invariants:
 * - Business ID is resolved from the WhatsApp channel, NEVER from the Flow payload
 * - Customer phone is taken from the webhook envelope (msg.from), NEVER asserted by Flow payload
 * - Idempotency: uses message_id for dedup to prevent double-submit
 * - All response data is validated against the form's field schema
 * - Booking requests are created as PENDING, never as confirmed bookings
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { validateFlowResponse, resolveOptionLabels, CONSENT_FIELD_ID } from './native-flow';
import type { WaaiioFormField } from './native-flow';
import { logger } from '@/lib/logger';

export interface NfmReplyPayload {
  /** The response_json from Meta's nfm_reply interactive message */
  responseJson: Record<string, unknown>;
  /** The flow_token we set when sending the Flow (contains formId + businessId) */
  flowToken: string;
}

export interface FlowTokenData {
  formId: string;
  businessId: string;
  /** ISO timestamp of when the flow was sent — for staleness checks */
  sentAt?: string;
}

/**
 * Encode form + business identity into a flow_token.
 * This token is opaque to Meta and returned in the nfm_reply.
 *
 * Format: `waaiio_form:<formId>:<businessId>:<timestamp>`
 * The token MUST NOT contain secrets. It only carries routing data.
 */
export function encodeFlowToken(formId: string, businessId: string): string {
  return `waaiio_form:${formId}:${businessId}:${Date.now()}`;
}

/**
 * Decode a flow_token back to form + business identity.
 * Returns null if the token format is invalid.
 */
export function decodeFlowToken(token: string): FlowTokenData | null {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split(':');
  if (parts.length < 3 || parts[0] !== 'waaiio_form') return null;

  const formId = parts[1];
  const businessId = parts[2];
  const timestamp = parts[3] ? parseInt(parts[3], 10) : undefined;

  // Basic UUID format validation
  const uuidRe = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
  if (!uuidRe.test(formId) || !uuidRe.test(businessId)) return null;

  return {
    formId,
    businessId,
    sentAt: timestamp && Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined,
  };
}

export interface SubmissionResult {
  success: boolean;
  /** Human-readable error for logging — never sent to customer */
  error?: string;
  /** true if this was a duplicate submission that was safely skipped */
  duplicate?: boolean;
  /** The form_response record ID, if created */
  responseId?: string;
  /** true if a booking request was created */
  bookingRequestCreated?: boolean;
}

/**
 * Process an nfm_reply submission from a WhatsApp Flow.
 *
 * @param supabase - Service client (bypasses RLS for cross-table writes)
 * @param customerPhone - From the webhook envelope (msg.from), NOT from Flow payload
 * @param channelBusinessId - Business ID resolved from the WhatsApp channel
 * @param nfmReply - The nfm_reply payload from Meta
 * @param metaMessageId - The webhook message ID for idempotency
 */
export async function handleFlowSubmission(
  supabase: SupabaseClient,
  customerPhone: string,
  channelBusinessId: string,
  nfmReply: NfmReplyPayload,
  metaMessageId: string,
): Promise<SubmissionResult> {
  const log = logger.withContext({ op: 'flow-submission', metaMessageId });

  // ── 1. Decode the flow token ──
  const tokenData = decodeFlowToken(nfmReply.flowToken);
  if (!tokenData) {
    log.warn('[FLOW-SUBMIT] Invalid flow token');
    return { success: false, error: 'Invalid flow token' };
  }

  // ── 2. Tenant isolation: token businessId MUST match channel businessId ──
  // The channel's business_id is the authoritative tenant identity.
  // The flow token is routing data, not an authorization assertion.
  if (tokenData.businessId !== channelBusinessId) {
    log.warn('[FLOW-SUBMIT] Cross-tenant submission blocked', {
      tokenBiz: tokenData.businessId,
      channelBiz: channelBusinessId,
    });
    return { success: false, error: 'Cross-tenant form submission denied' };
  }

  // ── 3. Idempotency check — use meta message ID as dedup key ──
  const { data: existing } = await supabase
    .from('form_responses')
    .select('id')
    .eq('metadata->>meta_message_id', metaMessageId)
    .maybeSingle();

  if (existing) {
    log.debug('[FLOW-SUBMIT] Duplicate submission skipped:', metaMessageId);
    return { success: true, duplicate: true, responseId: existing.id };
  }

  // ── 4. Load the form definition ──
  const { data: form, error: formError } = await supabase
    .from('forms')
    .select('id, business_id, title, fields, is_active, settings')
    .eq('id', tokenData.formId)
    .eq('business_id', channelBusinessId)
    .maybeSingle();

  if (formError || !form) {
    log.warn('[FLOW-SUBMIT] Form not found:', tokenData.formId);
    return { success: false, error: 'Form not found' };
  }

  if (!form.is_active) {
    log.warn('[FLOW-SUBMIT] Form inactive:', tokenData.formId);
    return { success: false, error: 'Form is no longer accepting responses' };
  }

  // ── 5. Validate response against form schema ──
  const formFields = form.fields as WaaiioFormField[];
  const hasConsent = !!(form.settings as Record<string, unknown> | null)?.consent_label;
  const validation = validateFlowResponse(formFields, nfmReply.responseJson, { hasConsent });

  if (!validation.valid || !validation.answers) {
    log.warn('[FLOW-SUBMIT] Schema validation failed:', validation.error);
    return { success: false, error: validation.error || 'Validation failed' };
  }

  // ── 6. Resolve option IDs to labels for human-readable storage ──
  const resolvedAnswers = resolveOptionLabels(formFields, validation.answers);

  // Extract consent flag and remove from answers
  const marketingConsent = !!resolvedAnswers[CONSENT_FIELD_ID];
  delete resolvedAnswers[CONSENT_FIELD_ID];

  // Extract customer info from answers if present
  const emailField = formFields.find(f => f.type === 'email');
  const nameField = formFields.find(f => f.type === 'text' && /name/i.test(f.label));
  const customerEmail = emailField ? (resolvedAnswers[emailField.id] as string) || null : null;
  const customerName = nameField ? (resolvedAnswers[nameField.id] as string) || null : null;

  // ── 7. Check for pending "sent" record for this phone + form (update instead of insert) ──
  const normalizedPhone = customerPhone.startsWith('+') ? customerPhone : `+${customerPhone}`;

  const { data: pendingRecord } = await supabase
    .from('form_responses')
    .select('id')
    .eq('form_id', form.id)
    .eq('customer_phone', normalizedPhone)
    .eq('status', 'sent')
    .maybeSingle();

  let responseId: string;

  if (pendingRecord) {
    // Update the existing sent record
    const { error: updateError } = await supabase
      .from('form_responses')
      .update({
        customer_name: customerName,
        customer_email: customerEmail,
        answers: resolvedAnswers,
        status: 'submitted',
        channel: 'whatsapp_flow',
        submitted_at: new Date().toISOString(),
        metadata: {
          meta_message_id: metaMessageId,
          marketing_consent: marketingConsent,
          source: 'native_whatsapp_flow',
        },
      })
      .eq('id', pendingRecord.id);

    if (updateError) {
      log.error('[FLOW-SUBMIT] Update error:', updateError);
      return { success: false, error: 'Database update failed' };
    }
    responseId = pendingRecord.id;
  } else {
    // Insert new record
    const { data: inserted, error: insertError } = await supabase
      .from('form_responses')
      .insert({
        form_id: form.id,
        business_id: channelBusinessId,
        customer_phone: normalizedPhone,
        customer_name: customerName,
        customer_email: customerEmail,
        answers: resolvedAnswers,
        status: 'submitted',
        channel: 'whatsapp_flow',
        metadata: {
          meta_message_id: metaMessageId,
          marketing_consent: marketingConsent,
          source: 'native_whatsapp_flow',
        },
      })
      .select('id')
      .single();

    if (insertError || !inserted) {
      log.error('[FLOW-SUBMIT] Insert error:', insertError);
      return { success: false, error: 'Database insert failed' };
    }
    responseId = inserted.id;
  }

  // ── 8. Increment response count (atomic) ──
  try {
    await supabase.rpc('increment_form_response_count', { p_form_id: form.id });
  } catch {
    // Non-fatal — count can be recalculated
    log.warn('[FLOW-SUBMIT] Response count increment failed (non-fatal)');
  }

  // ── 9. Handle booking request if form type is booking_request ──
  const formSettings = form.settings as Record<string, unknown> | null;
  let bookingRequestCreated = false;

  if (formSettings?.form_type === 'booking_request') {
    try {
      bookingRequestCreated = await createBookingRequest(
        supabase,
        channelBusinessId,
        normalizedPhone,
        customerName,
        customerEmail,
        resolvedAnswers,
        form.title,
        responseId,
      );
    } catch (err) {
      // Non-fatal — the form response is already saved
      log.error('[FLOW-SUBMIT] Booking request creation failed (non-fatal):', err);
    }
  }

  log.debug('[FLOW-SUBMIT] Submission processed:', { responseId, bookingRequestCreated });
  return { success: true, responseId, bookingRequestCreated };
}

/**
 * Create a PENDING booking request from a form submission.
 *
 * CRITICAL: This creates a REQUEST, not a confirmed booking.
 * The business owner must review, accept/reject, and handle payment/availability
 * separately. This function NEVER:
 * - Creates a confirmed booking
 * - Bypasses payment checks
 * - Bypasses availability checks
 * - Auto-assigns staff
 */
async function createBookingRequest(
  supabase: SupabaseClient,
  businessId: string,
  customerPhone: string,
  customerName: string | null,
  customerEmail: string | null,
  answers: Record<string, unknown>,
  formTitle: string,
  formResponseId: string,
): Promise<boolean> {
  // Extract booking-related fields from answers
  const preferredDate = answers['date'] || answers['preferred_date'] || null;
  const preferredTime = answers['time'] || answers['preferred_time'] || null;
  const service = answers['service'] || answers['service_type'] || null;
  const partySize = answers['party_size'] || answers['size'] || answers['guests'] || 1;
  const notes = answers['notes'] || answers['comments'] || answers['message'] || null;

  const { error } = await supabase
    .from('form_responses')
    .update({
      metadata: {
        booking_request: {
          status: 'pending_review',
          preferred_date: preferredDate,
          preferred_time: preferredTime,
          service: service,
          party_size: partySize,
          notes: notes,
          form_title: formTitle,
          created_at: new Date().toISOString(),
        },
        source: 'native_whatsapp_flow',
      },
    })
    .eq('id', formResponseId);

  return !error;
}
