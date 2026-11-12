import { requestNativeWhatsAppConsent } from './whatsapp-consent';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { MessageSender } from '@/lib/channels/message-sender';
import { serviceWindowState } from '@/lib/forms/form-send';
import { captureNativeResponse, resolveNativeChannel, nativeReplyAllowed, sendNativeForm, NativePersistenceError } from './runtime';
import type { NfmReplyMessage } from './submission-handler';
import { nativeFormsEnabled } from './release-gate';
import { MetaApiError } from '@/lib/channels/meta-api-error';
import { logger } from '@/lib/logger';

export const NATIVE_FORM_ENTRY = /^waaiio_form:([A-Za-z0-9_-]{8,20})$/;
export type NativeInbound = NfmReplyMessage & { text?: { body?: string }; timestamp?: string };
export function isNativeFormMessage(message: NativeInbound): boolean {
  return message.interactive?.type === 'nfm_reply' || NATIVE_FORM_ENTRY.test(message.text?.body?.trim() || '');
}

/** Dedicated branch before the webhook's ordinary post-emission catch. Returns
 * retry only when no customer-visible effect has been attempted. */
export async function handleNativeFormWebhook(input: {
  db: SupabaseClient; message: NativeInbound; phone: string; channelId: string; phoneNumberId: string;
  guardSender: (sender: MessageSender) => MessageSender;
}): Promise<{ retry: boolean }> {
  if (!nativeFormsEnabled()) return { retry: false };
  const { db, message, phone, channelId, phoneNumberId, guardSender } = input;
  let emissionStarted = false;
  try {
    const entry = NATIVE_FORM_ENTRY.exec(message.text?.body?.trim() || '');
    if (entry) {
      // The user explicitly named this public form in a signed inbound message.
      const { data: form, error } = await db.from('forms').select('id,business_id,is_active').eq('token', entry[1]).maybeSingle();
      if (error) throw new NativePersistenceError('Form lookup unavailable.');
      if (!form?.is_active) return { retry: false };
      const resolved = await resolveNativeChannel(db, form.business_id);
      if (!resolved || resolved.channel.id !== channelId || resolved.channel.phone_number_id !== phoneNumberId) return { retry: false };
      const timestamp = Number(message.timestamp) * 1000;
      if (!Number.isFinite(timestamp) || timestamp > Date.now() || timestamp <= Date.now() - 86400000) return { retry: false };
      const { data: receipt, error: receiptError } = await db.from('whatsapp_inbound_receipts').select('message_id')
        .eq('channel_id', channelId).eq('message_id', message.id || '').eq('sender_phone', phone.replace(/^\+/, '')).maybeSingle();
      if (receiptError || !receipt) throw new NativePersistenceError('Inbound receipt unavailable.');
      resolved.sender = guardSender(resolved.sender);
      // Once sending starts, ambiguous provider results must never be replayed.
      await sendNativeForm({ db, businessId: form.business_id, formId: form.id, phone, resolved, verifiedCustomerRequest: true,
        beforeEmission: async () => {
          if (!message.id) return false;
          const { data, error } = await db.from('whatsapp_inbound_receipts')
            .update({ native_form_send_claimed_at: new Date().toISOString() }).eq('channel_id', channelId)
            .eq('message_id', message.id).eq('sender_phone', phone.replace(/^\+/, ''))
            .is('native_form_send_claimed_at', null).select('message_id').maybeSingle();
          if (error) throw new NativePersistenceError('Native send claim unavailable.');
          if (!data) return false;
          emissionStarted = true;
          return true;
        } });
      return { retry: false };
    }
    const captured = await captureNativeResponse(db, message, phone, { channelId, phoneNumberId });
    if (!captured) return { retry: false };
    if (!await nativeReplyAllowed(db, captured.businessId, phone)) return { retry: false };
    const window = await serviceWindowState(db, channelId, phone);
    if (window === 'unknown') throw new NativePersistenceError('Service window lookup unavailable.');
    if (window !== 'open') return { retry: false };
    // Durable once-only acknowledgement ownership; a saved response survives any
    // delivery failure. Duplicate nfm_reply events cannot send another receipt.
    const { data: claimed, error: claimError } = await db.from('form_responses')
      .update({ native_ack_claimed_at: new Date().toISOString() }).eq('id', captured.responseId)
      .eq('business_id', captured.businessId).is('native_ack_claimed_at', null).select('id').maybeSingle();
    if (claimError) throw new NativePersistenceError('Acknowledgement claim unavailable.');
    if (!claimed) return { retry: false };
    const sender = guardSender(captured.resolved.sender);
    sender.bindBusiness?.(captured.businessId);
    emissionStarted = true;
    if (captured.registrationId) {
      await sender.sendButtons({ to: phone, body: 'Your information has been received. Continue to choose tickets and complete registration. A booking is confirmed separately.',
        buttons: [{ id: `native_register:${captured.registrationId}`, title: 'Continue registration' }], noRetry: true, messageCategory: 'service' });
    } else {
      await sender.sendText({ to: phone, text: 'Your information has been received. Thank you.', noRetry: true, messageCategory: 'service' });
    }
    await requestNativeWhatsAppConsent(db, captured, sender);
    return { retry: false };
  } catch (error) {
    // No raw answers, tokens, phone numbers or provider errors in logs.
    const numericCode = (value: unknown) => Number.isSafeInteger(value) ? value as number : undefined;
    logger.warn('[NATIVE-FORM] Webhook failure', {
      error_type: error instanceof MetaApiError ? 'meta_api' : error instanceof NativePersistenceError ? 'persistence' : 'other',
      emission_started: emissionStarted,
      ...(error instanceof MetaApiError ? {
        http_status: numericCode(error.httpStatus),
        meta_error_code: numericCode(error.metaErrorCode),
        meta_error_subcode: numericCode(error.metaErrorSubcode),
      } : {}),
    });
    if (!emissionStarted && error instanceof NativePersistenceError) return { retry: true };
    return { retry: false };
  }
}
