/**
 * Customer updates opt-in (Owner decision 2026-11-06, Option A).
 *
 * One extra row in a menu the customer already gets: the next-steps menu after
 * every completed transaction, and once in the welcome menu for a first-time
 * customer. Tapping it records WhatsApp marketing consent for THAT business and,
 * unless the business is white-label, for Waaiio's own updates list.
 *
 * Rules (WhatsApp Business Policy):
 *   - the row names who will message the customer (the business, and Waaiio);
 *   - nothing is pre-ticked, silence is never consent, not tapping is "no";
 *   - consent for one business never covers another business;
 *   - anyone who ever unsubscribed from the business (STOP), revoked consent,
 *     or unsubscribed from Waaiio updates is never shown the offer again.
 *
 * Storage (no new tables):
 *   - business: append-only `customer_consents` row (whatsapp / marketing /
 *     granted), the same rows broadcasts already check. `source` is 'whatsapp'
 *     (CHECK-constrained); the menu it came from is in `evidence_reference`.
 *   - Waaiio: `launch_subscribers`, Waaiio's updates list that STOP already
 *     offers as "Waaiio updates". `wa_number` is stored exactly as Meta sends
 *     it, because that is how the STOP handler looks it up.
 *
 * Every read fails closed: on any lookup error the offer is not shown and no
 * consent is recorded.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { fillFlowCopy, getFlowCopy } from '@/lib/bot/flows/flow-localization';
import { sanitizeFilterValue } from '@/lib/utils/sanitize';
import { getPoweredByInteractiveFooter } from '@/lib/whitelabel';
import { logger } from '@/lib/logger';

export type UpdatesOptInSource = 'menu' | 'welcome';

/** Postback prefix. Taps arrive as the row id, so the id carries the business. */
export const UPDATES_OPTIN_PREFIX = 'updates_yes';

/** Written to customer_consents.evidence_reference and launch_subscribers.signup_source. */
export const UPDATES_OPTIN_EVIDENCE: Record<UpdatesOptInSource, string> = {
  menu: 'bot_next_steps_menu',
  welcome: 'bot_welcome_menu',
};

/** Wording version recorded with each consent row. Bump when the copy changes. */
export const UPDATES_OPTIN_POLICY_VERSION = 'bot-updates-optin-v1';

/** WhatsApp list row description limit (titles are capped at 24 by the copy governance test). */
const ROW_DESCRIPTION_MAX = 72;

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const UUID_RE = new RegExp(`^${UUID}$`, 'i');
const POSTBACK_RE = new RegExp(`^${UPDATES_OPTIN_PREFIX}:(menu|welcome):(${UUID})$`, 'i');

export function updatesOptInPostback(source: UpdatesOptInSource, businessId: string): string {
  return `${UPDATES_OPTIN_PREFIX}:${source}:${businessId}`;
}

export function parseUpdatesOptInPostback(text: string): { source: UpdatesOptInSource; businessId: string } | null {
  const m = POSTBACK_RE.exec(text.trim());
  if (!m) return null;
  return { source: m[1].toLowerCase() as UpdatesOptInSource, businessId: m[2].toLowerCase() };
}

/**
 * Waaiio is named and subscribed only when the business shows Waaiio branding.
 * Same rule as the "Powered by Waaiio.com" footer: the per-business switch wins
 * over the plan.
 */
export function updatesOptInIncludesWaaiio(subscriptionTier: string | null | undefined, isWhitelabel: boolean | null | undefined): boolean {
  return getPoweredByInteractiveFooter(subscriptionTier, isWhitelabel) !== undefined;
}

function phoneVariants(phone: string): string[] {
  const digits = phone.replace(/\D/g, '');
  return [digits, `+${digits}`];
}

/**
 * Fill the description. The Owner's full line is used whenever the business
 * name fits; a long name gets the shorter line, and only if that still does
 * not fit is the business name shortened. Both parties are always named.
 */
function describe(lang: string, businessName: string, includesWaaiio: boolean): string {
  const key = includesWaaiio ? 'updates.optin_desc' : 'updates.optin_desc_business';
  const name = businessName.trim() || 'this business';
  const full = fillFlowCopy(lang, key, { businessName: name });
  if (full.length <= ROW_DESCRIPTION_MAX) return full;
  const short = fillFlowCopy(lang, `${key}_short`, { businessName: name });
  if (short.length <= ROW_DESCRIPTION_MAX) return short;
  const room = ROW_DESCRIPTION_MAX - (short.length - name.length) - 1;
  return fillFlowCopy(lang, `${key}_short`, { businessName: `${name.slice(0, Math.max(room, 1)).trimEnd()}…` })
    .slice(0, ROW_DESCRIPTION_MAX);
}

/** The list row: short value-led title, one line naming the business (and Waaiio). */
export function buildUpdatesOptInRow(
  lang: string,
  businessName: string,
  includesWaaiio: boolean,
  source: UpdatesOptInSource,
  businessId: string,
): { title: string; description: string; postbackText: string } {
  return {
    title: getFlowCopy(lang, 'updates.optin_title'),
    description: describe(lang, businessName, includesWaaiio),
    postbackText: updatesOptInPostback(source, businessId),
  };
}

type ConsentState = 'none' | 'granted' | 'blocked' | 'error';

/** Latest WhatsApp marketing consent for this business only. */
async function businessConsentState(supabase: SupabaseClient, phone: string, businessId: string): Promise<ConsentState> {
  const { data, error } = await supabase.from('customer_consents')
    .select('status, expires_at')
    .eq('business_id', businessId).in('phone', phoneVariants(phone))
    .eq('channel', 'whatsapp').eq('purpose', 'marketing')
    .order('created_at', { ascending: false }).order('id', { ascending: false })
    .limit(1).maybeSingle();
  if (error) return 'error';
  if (!data) return 'none';
  if (data.status === 'revoked') return 'blocked';
  if (data.status === 'granted' && (!data.expires_at || new Date(data.expires_at) > new Date())) return 'granted';
  return 'none'; // pending (unverified web tick), unknown or expired
}

/**
 * Opt-outs for this business or for all businesses. `everStopped` counts rows a
 * later START reopened too: someone who once said STOP is never asked again.
 */
async function optOutState(supabase: SupabaseClient, phone: string, businessId: string, everStopped: boolean): Promise<'none' | 'opted_out' | 'error'> {
  let query = supabase.from('messaging_opt_outs')
    .select('id', { count: 'exact', head: true })
    .in('phone', phoneVariants(phone)).in('channel', ['whatsapp', 'all'])
    .or(`business_id.eq.${sanitizeFilterValue(businessId)},business_id.is.null`);
  if (!everStopped) query = query.is('resubscribed_at', null);
  const { count, error } = await query;
  if (error || count === null || count === undefined) return 'error';
  return count > 0 ? 'opted_out' : 'none';
}

/** True when this number has chatted with, or is a recorded customer of, this business. */
async function hasContactWithBusiness(supabase: SupabaseClient, phone: string, businessId: string): Promise<boolean | 'error'> {
  const variants = phoneVariants(phone);
  const [sessions, profiles] = await Promise.all([
    supabase.from('bot_sessions').select('id', { count: 'exact', head: true })
      .eq('business_id', businessId).in('whatsapp_number', variants),
    supabase.from('customer_profiles').select('id', { count: 'exact', head: true })
      .eq('business_id', businessId).in('phone', variants),
  ]);
  if (sessions.error || profiles.error) return 'error';
  return (sessions.count ?? 0) > 0 || (profiles.count ?? 0) > 0;
}

async function waaiioListState(supabase: SupabaseClient, phone: string): Promise<'none' | 'active' | 'opted_out' | 'error'> {
  const { data, error } = await supabase.from('launch_subscribers')
    .select('opt_in_status').in('wa_number', phoneVariants(phone));
  if (error) return 'error';
  const rows = (data || []) as Array<{ opt_in_status: string }>;
  if (rows.some(r => r.opt_in_status === 'opted_out')) return 'opted_out';
  return rows.length > 0 ? 'active' : 'none';
}

/**
 * Show the row only to someone who has dealt with this business, has not
 * agreed yet and never unsubscribed.
 * Never throws; any error means "don't show".
 */
export async function shouldOfferUpdatesOptIn(
  supabase: SupabaseClient,
  phone: string,
  businessId: string | null | undefined,
  includesWaaiio: boolean,
): Promise<boolean> {
  if (!phone || !businessId || !UUID_RE.test(businessId)) return false;
  try {
    const [consent, optOut, waaiio, contact] = await Promise.all([
      businessConsentState(supabase, phone, businessId),
      optOutState(supabase, phone, businessId, true),
      includesWaaiio ? waaiioListState(supabase, phone) : Promise.resolve('none' as const),
      // Same prior-contact rule as the tap, so an offer shown can always be accepted.
      hasContactWithBusiness(supabase, phone, businessId),
    ]);
    return consent === 'none' && optOut === 'none' && (waaiio === 'none' || waaiio === 'active') && contact === true;
  } catch (err) {
    logger.warn('[UPDATES-OPTIN] Eligibility check failed — not offering', { err: String(err) });
    return false;
  }
}

/** The opt-in row when it should be shown, otherwise null. Never throws. */
export async function updatesOptInRowFor(
  supabase: SupabaseClient,
  params: {
    phone: string;
    lang: string;
    source: UpdatesOptInSource;
    business: { id: string; name: string; subscription_tier?: string | null; is_whitelabel?: boolean | null } | null | undefined;
    /** Welcome only: the current chat session. Any other session with this business means it is not a first visit. */
    firstVisitSessionId?: string;
  },
): Promise<{ title: string; description: string; postbackText: string } | null> {
  const biz = params.business;
  if (!biz?.id || !biz.name || !UUID_RE.test(biz.id)) return null;
  try {
    // Some paths load the business without its white-label switch. Read it
    // rather than guess, so a white-label business is never shown "Waaiio".
    let branding = { subscription_tier: biz.subscription_tier, is_whitelabel: biz.is_whitelabel };
    if (biz.is_whitelabel === undefined) {
      const { data, error } = await supabase.from('businesses')
        .select('subscription_tier, is_whitelabel').eq('id', biz.id).maybeSingle();
      if (error || !data) return null;
      branding = data;
    }
    if (params.firstVisitSessionId) {
      const { count, error } = await supabase.from('bot_sessions')
        .select('id', { count: 'exact', head: true })
        .eq('business_id', biz.id).in('whatsapp_number', phoneVariants(params.phone))
        .neq('id', params.firstVisitSessionId);
      if (error || count === null || count === undefined || count > 0) return null;
    }
    const includesWaaiio = updatesOptInIncludesWaaiio(branding.subscription_tier, branding.is_whitelabel);
    if (!await shouldOfferUpdatesOptIn(supabase, params.phone, biz.id, includesWaaiio)) return null;
    return buildUpdatesOptInRow(params.lang, biz.name, includesWaaiio, params.source, biz.id);
  } catch (err) {
    logger.warn('[UPDATES-OPTIN] Row check failed — not offering', { err: String(err) });
    return null;
  }
}

/**
 * The Waaiio number that will message this customer: launch delivery only sends
 * from an active shared Waaiio number. A tap on a shared number uses that
 * number; a tap on a business's own number uses Waaiio's shared number for the
 * business's country. Null when there is none (Waaiio is then not added).
 */
async function waaiioSenderFor(supabase: SupabaseClient, destinationPhone: string | undefined, countryCode: string | null): Promise<string | null> {
  if (destinationPhone) {
    const { data, error } = await supabase.from('whatsapp_channels').select('phone_number_id')
      .eq('phone_number_id', destinationPhone).eq('channel_type', 'shared').eq('is_active', true)
      .limit(1);
    if (error) return null;
    if (data && data.length > 0) return destinationPhone;
  }
  if (!countryCode) return null;
  const { data, error } = await supabase.from('whatsapp_channels').select('phone_number_id')
    .eq('country_code', countryCode).eq('channel_type', 'shared').eq('is_active', true)
    .order('created_at', { ascending: true }).limit(1);
  if (error || !data || data.length === 0) return null;
  return (data[0] as { phone_number_id: string | null }).phone_number_id || null;
}

/** Outcome of recording an opt-in. The caller chooses the reply. */
export type UpdatesOptInResult =
  | { status: 'granted'; businessName: string; waaiioSubscribed: boolean }
  | { status: 'already' | 'opted_out'; businessName: string }
  | { status: 'unknown_business' | 'no_contact' | 'error' };

/**
 * Purposes one "yes" covers (Owner decision 2026-11-06, #591): marketing and
 * utility (service messages about what the customer did with the business).
 */
export const UPDATES_OPTIN_PURPOSES = ['marketing', 'utility'] as const;

/**
 * Record a customer's "yes" for one business (and Waaiio's list unless the
 * business is white-label). Shared by the menu tap and, later, other explicit
 * WhatsApp opt-in paths. The caller must already have the customer's explicit
 * action; this never infers consent. Never throws.
 *
 * Checks, in order: business exists; the number has dealt with it; no active
 * opt-out (business or global); latest consent not revoked; not already granted.
 * Then appends one granted customer_consents row per purpose in a single insert.
 */
export async function recordUpdatesOptIn(
  supabase: SupabaseClient,
  params: { phone: string; businessId: string; source: UpdatesOptInSource; destinationPhone?: string },
): Promise<UpdatesOptInResult> {
  const { phone, businessId, source } = params;
  if (!phone || !UUID_RE.test(businessId)) return { status: 'unknown_business' };
  try {
    const { data: business, error: bizErr } = await supabase.from('businesses')
      .select('id, name, subscription_tier, is_whitelabel, country_code')
      .eq('id', businessId).maybeSingle();
    if (bizErr) return { status: 'error' };
    if (!business) return { status: 'unknown_business' };

    // Cross-business safety: only a business this number has actually dealt with.
    const contact = await hasContactWithBusiness(supabase, phone, businessId);
    if (contact === 'error') return { status: 'error' };
    if (!contact) {
      logger.warn('[UPDATES-OPTIN] No prior contact with business — not recorded');
      return { status: 'no_contact' };
    }

    const optOut = await optOutState(supabase, phone, businessId, false);
    if (optOut === 'error') return { status: 'error' };
    if (optOut === 'opted_out') return { status: 'opted_out', businessName: business.name };

    const consent = await businessConsentState(supabase, phone, businessId);
    if (consent === 'error') return { status: 'error' };
    if (consent === 'blocked') return { status: 'opted_out', businessName: business.name };
    if (consent === 'granted') return { status: 'already', businessName: business.name };

    const includesWaaiio = updatesOptInIncludesWaaiio(business.subscription_tier, business.is_whitelabel);
    const grantedAt = new Date().toISOString();
    const row = {
      business_id: businessId,
      phone: `+${phone.replace(/\D/g, '')}`,
      channel: 'whatsapp',
      status: 'granted',
      source: 'whatsapp',
      evidence_reference: UPDATES_OPTIN_EVIDENCE[source],
      policy_version: `${UPDATES_OPTIN_POLICY_VERSION}:${includesWaaiio ? 'business+waaiio' : 'business'}`,
      granted_at: grantedAt,
    };
    // One statement, so both purposes are recorded or neither is.
    const { error: insertErr } = await supabase.from('customer_consents')
      .insert(UPDATES_OPTIN_PURPOSES.map(purpose => ({ ...row, purpose })));
    if (insertErr) {
      logger.error('[UPDATES-OPTIN] Business consent not recorded:', insertErr.message);
      return { status: 'error' };
    }

    // Waaiio's list: add a new subscriber, keep an active one, never re-activate
    // someone who unsubscribed from Waaiio (the thank-you then names only the business).
    let waaiioSubscribed = false;
    if (includesWaaiio) {
      const waaiio = await waaiioListState(supabase, phone);
      if (waaiio === 'active') {
        waaiioSubscribed = true;
      } else if (waaiio === 'none') {
        const waaiioSender = await waaiioSenderFor(supabase, params.destinationPhone, business.country_code ?? null);
        if (!waaiioSender) {
          logger.warn('[UPDATES-OPTIN] No shared Waaiio number for this market — business consent only');
        } else {
          const { error: subErr } = await supabase.from('launch_subscribers').insert({
            wa_number: phone,
            market: String(business.country_code || 'XX').slice(0, 4),
            receiving_number: waaiioSender,
            signup_source: UPDATES_OPTIN_EVIDENCE[source],
            opt_in_status: 'active',
          });
          // 23505: a concurrent tap or launch sign-up just added this number as active.
          waaiioSubscribed = !subErr || subErr.code === '23505';
          if (subErr && subErr.code !== '23505') logger.error('[UPDATES-OPTIN] Waaiio subscriber not recorded:', subErr.message);
        }
      }
    }
    return { status: 'granted', businessName: business.name, waaiioSubscribed };
  } catch (err) {
    logger.error('[UPDATES-OPTIN] Recording failed:', String(err));
    return { status: 'error' };
  }
}

/**
 * Handle a tap on the opt-in row. Returns false when the text is not an opt-in
 * postback (caller continues), true when handled. Never touches the chat
 * session, so the menu the customer is on keeps working afterwards.
 */
export async function handleUpdatesOptInTap(
  supabase: SupabaseClient,
  params: {
    from: string;
    text: string;
    /** Only a real tap counts ('list' or 'button'); typed text is not consent to the shown wording. */
    messageType: string;
    preResolvedBusinessId?: string;
    destinationPhone?: string;
    sendReply: (to: string, text: string) => Promise<void>;
  },
): Promise<boolean> {
  const parsed = parseUpdatesOptInPostback(params.text);
  if (!parsed || (params.messageType !== 'list' && params.messageType !== 'button')) return false;
  const { from, sendReply } = params;
  const { businessId, source } = parsed;

  // Reply language: the customer's latest chat with this business, else English.
  let lang = 'en';
  const reply = async (key: string, businessName?: string) => {
    await sendReply(from, businessName ? fillFlowCopy(lang, key, { businessName }) : getFlowCopy(lang, key));
  };

  try {
    // On a business's own number only that business can be named.
    if (params.preResolvedBusinessId && params.preResolvedBusinessId.toLowerCase() !== businessId) {
      logger.warn('[UPDATES-OPTIN] Business mismatch on dedicated channel — ignoring tap');
      await reply('updates.expired');
      return true;
    }

    const { data: lastSession } = await supabase.from('bot_sessions')
      .select('session_data').eq('business_id', businessId).in('whatsapp_number', phoneVariants(from))
      .order('updated_at', { ascending: false }).limit(1).maybeSingle();
    const detected = (lastSession?.session_data as Record<string, unknown> | null)?._detected_language;
    if (typeof detected === 'string' && detected) lang = detected;

    const result = await recordUpdatesOptIn(supabase, { phone: from, businessId, source, destinationPhone: params.destinationPhone });
    switch (result.status) {
      case 'granted':
        await reply(result.waaiioSubscribed ? 'updates.thanks' : 'updates.thanks_business', result.businessName); break;
      case 'already': await reply('updates.already', result.businessName); break;
      case 'opted_out': await reply('updates.opted_out', result.businessName); break;
      case 'unknown_business': case 'no_contact': await reply('updates.expired'); break;
      default: await reply('updates.save_failed');
    }
    return true;
  } catch (err) {
    logger.error('[UPDATES-OPTIN] Tap handling failed:', String(err));
    await reply('updates.save_failed').catch(() => {});
    return true;
  }
}
