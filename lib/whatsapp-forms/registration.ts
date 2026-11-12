import type { SupabaseClient } from '@supabase/supabase-js';
import { ChannelResolver } from '@/lib/channels/channel-resolver';
import type { MessageSender } from '@/lib/channels/message-sender';
import type { StandaloneService } from '@/lib/bot/standalone.service';
import type { BotIntelligenceService } from '@/lib/bot/bot-intelligence';
import { FlowExecutor } from '@/lib/bot/flows/executor';
import type { BotSession, BusinessRecord } from '@/lib/bot/bot-types';
import { requireCurrentCapability } from '@/lib/bot/flows/shared/capability-guard';
import { getConfiguredCapabilities } from '@/lib/capabilities/service';
import { getEffectiveCapabilities } from '@/lib/capabilities/policy';
import { getLegacyDefaultCapabilities } from '@/lib/capabilities/legacy-defaults';
import { resolveFeatureTrialEndsAt } from '@/lib/trial-status';
import { loadBusinessOverrides, loadPlatformOverrides, runWithTranslationOverrides } from '@/lib/bot/translations';
import { nativeReplyAllowed } from './runtime';
import { serviceWindowState } from '@/lib/forms/form-send';
import { nativeFormsEnabled } from './release-gate';

export const NATIVE_REGISTRATION_BUTTON = /^native_register:([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i;

export async function continueNativeRegistration(input: {
  db: SupabaseClient; from: string; text: string; messageType: string; phoneNumberId?: string;
  channelBusinessId?: string; standalone: StandaloneService; intelligence: BotIntelligenceService;
  guardSender: (sender: MessageSender) => MessageSender;
}) {
  const { db, from, text, messageType, phoneNumberId, standalone, intelligence } = input;
  const match = NATIVE_REGISTRATION_BUTTON.exec(text);
  if (!match || messageType !== 'button' || !phoneNumberId || !nativeFormsEnabled()) return;
  const phone = from.replace(/^\+/, '');
  const { data: registration, error } = await db.from('native_form_registrations').select('*').eq('id', match[1]).eq('phone', phone).maybeSingle();
  if (error || !registration || (input.channelBusinessId && input.channelBusinessId !== registration.business_id)) return;
  const businessId = registration.business_id;
  const resolved = await new ChannelResolver(db).resolveByBusinessId(businessId);
  if (!resolved || resolved.channel.id !== registration.channel_id || resolved.channel.phone_number_id !== phoneNumberId) return;
  if (!await nativeReplyAllowed(db, businessId, phone) || await serviceWindowState(db, resolved.channel.id, phone) !== 'open') return;
  const { data: business, error: businessError } = await db.from('businesses').select('*').eq('id', businessId).eq('status', 'active').maybeSingle();
  if (businessError || !business) return;
  const sender = input.guardSender(resolved.sender);
  sender.bindBusiness?.(businessId);
  const tell = (text: string) => sender.sendText({ to: phone, text, noRetry: true, messageCategory: 'service' });
  const capability = await requireCurrentCapability(db, { businessId, capability: 'ticketing', action: 'create_new' });
  if (!capability.allowed) { await tell(capability.customerMessage); return; }
  const tier = await standalone.checkTierLimitsFromBusiness(businessId, business.subscription_tier, business.is_whitelabel);
  if (!tier.allowed) { await tell('This business cannot accept another registration right now. Please contact them.'); return; }
  const configured = await getConfiguredCapabilities(db, businessId);
  const overrides = await db.from('capability_overrides').select('capability').eq('business_id', businessId);
  if (!configured.ok || overrides.error) return;
  const capabilities = getEffectiveCapabilities({
    configuredCapabilities: configured.rows.length ? configured.rows : getLegacyDefaultCapabilities(business.category).map((capability, sort_order) => ({ capability, sort_order, is_enabled: true })),
    overrides: (overrides.data || []).map(row => row.capability), tier: business.subscription_tier || 'free',
    trialEndsAt: await resolveFeatureTrialEndsAt(db, businessId),
  }).effective;
  if (!capabilities.includes('ticketing')) return;
  const { data: claimed, error: claimError } = await db.rpc('claim_native_registration_591', {
    p_registration_id: registration.id, p_business_id: businessId, p_phone: phone,
    p_channel_id: resolved.channel.id, p_capabilities: capabilities,
  });
  if (claimError || !claimed) { await tell('Registration is temporarily unavailable. Please try again.'); return; }
  if (claimed.error) {
    await tell(claimed.error === 'active_checkout' ? 'Please finish or cancel your current checkout before starting this registration.'
      : claimed.error === 'already_started' ? 'This registration has already been started. Continue in your current chat, or contact the business for help.'
      : 'This event is no longer available for registration. Please contact the business.');
    return;
  }
  // Existing executor owns event selection, quantity, customer information,
  // terms, booking creation, tax refusal, payment and confirmation.
  const executor = new FlowExecutor(db, sender, standalone, intelligence);
  const [platformOverrides, businessOverrides] = await Promise.all([loadPlatformOverrides(db), loadBusinessOverrides(db, businessId)]);
  await runWithTranslationOverrides({ platform: platformOverrides, business: businessOverrides }, () =>
    executor.execute(phone, claimed.event_id, claimed.session as BotSession, business as BusinessRecord));
}

export async function attachNativeRegistration(db: SupabaseClient, registrationId: string, bookingId: string, sessionId: string) {
  const { data, error } = await db.rpc('attach_native_registration_591', { p_registration_id: registrationId, p_booking_id: bookingId, p_session_id: sessionId });
  if (error || data !== true) throw new Error('Registration booking association could not be saved.');
}
