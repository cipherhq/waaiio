import type { SupabaseClient } from '@supabase/supabase-js';
import { ChannelResolver, type ResolvedChannel } from '@/lib/channels/channel-resolver';
import { businessChatWindowState, serviceWindowState } from '@/lib/forms/form-send';
import { authenticateNativeFlowToken, generateNativeFlowToken, hashNonceForReplay, normalizePhone } from './flow-token';
import { compilePublication, type NativePublication } from './publication';
import { validateAndNormalizeAnswers, type NfmReplyMessage } from './submission-handler';
import type { WaaiioFormField } from './native-flow';
import { nativeFormsEnabled } from './release-gate';
import { MetaFlowApiError } from './meta-flow-asset';
import { normalizeConsentEmail } from './email-consent';

export class NativePersistenceError extends Error {}

export async function resolveNativeChannel(db: SupabaseClient, businessId: string) {
  try { return await new ChannelResolver(db).resolveByBusinessId(businessId, true); }
  catch { throw new NativePersistenceError('Channel lookup unavailable.'); }
}


export async function nativeReplyAllowed(db: SupabaseClient, businessId: string, phone: string): Promise<boolean> {
  const digits = normalizePhone(phone);
  if (!/^[1-9]\d{6,14}$/.test(digits)) return false;
  const [{ data: business, error: businessError }, { count: blocked, error: blockedError }] = await Promise.all([
    db.from('businesses').select('status,metadata').eq('id', businessId).maybeSingle(),
    db.from('blocked_phones').select('id', { count: 'exact', head: true })
      .eq('business_id', businessId).in('phone', [digits, `+${digits}`]),
  ]);
  const legacyBlocked = business?.metadata?.blocked_phones;
  if (businessError || blockedError || blocked === null) throw new NativePersistenceError('Recipient eligibility unavailable.');
  if (business?.status !== 'active' || blocked !== 0
    || (Array.isArray(legacyBlocked) && legacyBlocked.some((p: unknown) => typeof p === 'string' && normalizePhone(p) === digits))) return false;
  const { count, error } = await db.from('messaging_opt_outs').select('id', { count: 'exact', head: true })
    .in('phone', [digits, `+${digits}`]).or(`business_id.eq.${businessId},business_id.is.null`)
    .eq('channel', 'whatsapp').is('resubscribed_at', null);
  if (error || count === null) throw new NativePersistenceError('Opt-out lookup unavailable.');
  return count === 0;
}

export async function loadCurrentPublication(db: SupabaseClient, formId: string, businessId: string, resolved: ResolvedChannel) {
  const { data: form, error } = await db.from('forms').select('id,title,description,fields,settings,is_active').eq('id', formId).eq('business_id', businessId).maybeSingle();
  if (error) throw new NativePersistenceError('Form lookup unavailable.');
  if (!form?.is_active) return null;
  let revision: string;
  try { revision = compilePublication(form).revision; } catch { return null; }
  const { data, error: publicationError } = await db.from('native_form_publications').select('*')
    .eq('form_id', formId).eq('business_id', businessId).eq('revision', revision).eq('status', 'published')
    .eq('channel_id', resolved.channel.id).eq('phone_number_id', resolved.channel.phone_number_id)
    .eq('waba_id', resolved.channel.waba_id).maybeSingle();
  if (publicationError) throw new NativePersistenceError('Publication lookup unavailable.');
  return data as NativePublication | null;
}

/** Customer requests have already been authenticated by the webhook and scoped
 * to this form/business. Merchant sends instead require business chat evidence. */
export async function sendNativeForm(input: {
  db: SupabaseClient; businessId: string; formId: string; phone: string; resolved: ResolvedChannel;
  verifiedCustomerRequest?: boolean; beforeEmission?: () => Promise<boolean>;
}) {
  const { db, businessId, formId, phone, resolved } = input;
  if (!nativeFormsEnabled()) return { sent: false, reason: 'not_enabled' };
  if (!await nativeReplyAllowed(db, businessId, phone)) return { sent: false, reason: 'opted_out_or_unavailable' };
  const window = input.verifiedCustomerRequest
    ? await serviceWindowState(db, resolved.channel.id, phone)
    : await businessChatWindowState(db, businessId, resolved.channel, phone);
  if (window === 'unknown') throw new NativePersistenceError('Service window lookup unavailable.');
  if (window !== 'open') return { sent: false, reason: 'customer_must_open_chat' };
  const publication = await loadCurrentPublication(db, formId, businessId, resolved);
  if (!publication?.meta_flow_id || !resolved.sender.sendFlow || !resolved.cloud) return { sent: false, reason: 'publish_current_form_first' };
  let provider;
  try { provider = await resolved.cloud.nativeFlowAssets(publication.waba_id).status(publication.meta_flow_id); }
  catch (error) {
    if (error instanceof MetaFlowApiError && (error.statusCode === 429 || (error.statusCode || 0) >= 500)) {
      throw new NativePersistenceError('Provider status lookup temporarily unavailable.');
    }
    return { sent: false, reason: 'provider_unavailable' };
  }
  if (provider.status !== 'PUBLISHED' || provider.wabaId !== publication.waba_id) return { sent: false, reason: 'provider_unavailable' };
  const token = generateNativeFlowToken({ formId, businessId, publicationId: publication.id,
    channelId: publication.channel_id, phoneNumberId: publication.phone_number_id, assetId: publication.meta_flow_id,
    revision: publication.revision, phone });
  resolved.sender.bindBusiness?.(businessId);
  if (input.beforeEmission && !await input.beforeEmission()) return { sent: false, reason: 'already_attempted' };
  const result = await resolved.sender.sendFlow({ to: phone, bodyText: `Please complete ${publication.config.title}.`,
    flowId: publication.meta_flow_id, flowCta: 'Open form', screen: 'FORM', flowToken: token.token,
    messageCategory: 'service', noRetry: true });
  return { sent: result.success !== false && !!result.messageId, messageId: result.messageId };
}

export interface CapturedNativeResponse {
  responseId: string; duplicate: boolean; businessId: string; formId: string;
  phone: string; publication: NativePublication; resolved: ResolvedChannel; whatsappRequested: boolean; registrationId?: string;
}

/** Called only from the signature-verified Meta hook. No outbound side effects. */
export async function captureNativeResponse(db: SupabaseClient, message: NfmReplyMessage, phone: string,
  transport: { channelId: string; phoneNumberId: string }): Promise<CapturedNativeResponse | null> {
  if (!nativeFormsEnabled()) return null;
  const raw = message.interactive?.nfm_reply?.response_json;
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > 102400) return null;
  let payload: Record<string, unknown>;
  try { payload = JSON.parse(raw); } catch { return null; }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const claims = authenticateNativeFlowToken(payload.flow_token, phone, transport.channelId, transport.phoneNumberId);
  if (!claims) return null;
  // Fresh sender per business. Never bind the batch's shared transport sender.
  const resolved = await resolveNativeChannel(db, claims.businessId);
  if (!resolved || resolved.channel.id !== transport.channelId || resolved.channel.phone_number_id !== transport.phoneNumberId) return null;
  const { data: row, error } = await db.from('native_form_publications').select('*').eq('id', claims.publicationId)
    .eq('business_id', claims.businessId).eq('form_id', claims.formId).maybeSingle();
  if (error) throw new NativePersistenceError('Publication lookup unavailable.');
  const publication = row as NativePublication | null;
  if (!publication || publication.status !== 'published' || publication.meta_flow_id !== claims.assetId
    || publication.channel_id !== claims.channelId || publication.phone_number_id !== claims.phoneNumberId
    || publication.waba_id !== resolved.channel.waba_id || publication.revision !== claims.revision) return null;
  try { if (compilePublication(publication.config).revision !== claims.revision) return null; } catch { return null; }
  const { flow_token: _token, _marketing_consent, _email_consent, ...answers } = payload;
  const fields = publication.config.fields as WaaiioFormField[];
  const validation = validateAndNormalizeAnswers(answers, fields);
  if (!validation.valid) return null;
  const normalized = validation.normalized!;
  const nameField = fields.find(f => ['name', 'full_name', 'customer_name'].includes(f.id));
  const emailField = fields.find(f => f.type === 'email');
  const name = nameField && typeof normalized[nameField.id] === 'string' ? String(normalized[nameField.id]).trim().slice(0, 200) : null;
  const email = emailField && typeof normalized[emailField.id] === 'string' ? String(normalized[emailField.id]).trim().slice(0, 200) : null;
  const prompt = publication.config.settings?.native_whatsapp_opt_in === true ? 'native-whatsapp-v1' : publication.config.settings?.consent_label;
  const consent = typeof prompt === 'string' && prompt.trim() && typeof _marketing_consent === 'boolean' ? _marketing_consent : null;
  const { data: saved, error: saveError } = await db.rpc('save_native_form_response_591', {
    p_publication_id: publication.id, p_business_id: claims.businessId, p_channel_id: transport.channelId,
    p_phone_number_id: transport.phoneNumberId, p_asset_id: claims.assetId, p_revision: claims.revision,
    p_phone: claims.phone, p_nonce_hash: hashNonceForReplay(claims.nonce), p_answers: normalized,
    p_name: name, p_email: email, p_consent: consent,
    p_message_id: message.id || null, p_provider_timestamp: message.timestamp && Number.isFinite(Number(message.timestamp)) ? new Date(Number(message.timestamp) * 1000).toISOString() : null,
    p_email_consent: publication.config.settings?.email_marketing_opt_in === true && _email_consent === true && !!normalizeConsentEmail(email),
  });
  if (saveError || !saved) throw new NativePersistenceError('Native response persistence unavailable.');
  if (saved.error === 'receipt_unavailable') throw new NativePersistenceError('Native receipt persistence unavailable.');
  if (saved.error || !saved.response_id) return null;
  return { responseId: saved.response_id, duplicate: saved.duplicate === true, businessId: claims.businessId,
    registrationId: saved.registration_id || undefined, formId: claims.formId, phone: claims.phone, publication, resolved, whatsappRequested: consent === true };
}
