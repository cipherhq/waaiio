/**
 * Admin WhatsApp broadcasts (#1104, Owner request 2026-11-17).
 *
 * Waaiio messages its own users and account owners with an approved WhatsApp
 * template from the shared Waaiio number. Every send is platform-scoped
 * (sendPlatformTemplate on an unbound shared sender), so no merchant messaging
 * credit is reserved or charged; the cost is Waaiio's own.
 *
 * Recipients that are suspended (#1103), opted out of Waaiio messages, or
 * whose status cannot be read are skipped (fail closed). Each recipient gets
 * an admin_broadcast_recipients row before the send (M548), so a number is
 * never messaged twice for one broadcast.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { CountryCode } from 'libphonenumber-js';
import { canonicalCustomerPhone } from '@/lib/customer-suspension';
import { resolveRecipientCountry } from '@/lib/channels/phone-country';
import { billingCurrencyAndRate } from '@/lib/messaging/low-balance-alerts';
import { SHARED_CHANNEL_FALLBACK_COUNTRIES } from '@/lib/onboarding/whatsapp-readiness';
import { AmbiguousSendError } from '@/lib/channels/attempt-recording';
import type { MessageTemplate, MetaCloudService } from '@/lib/channels/meta-cloud';
import type { MessageSender } from '@/lib/channels/message-sender';

/** One synchronous send; larger audiences must be narrowed with filters. */
export const MAX_RECIPIENTS = 500;
/** Spacing between provider calls (about 10 messages a second). */
export const SEND_INTERVAL_MS = 100;

export const AUDIENCES = ['all_users', 'all_businesses', 'specific'] as const;
export type Audience = typeof AUDIENCES[number];
export const PLANS = ['free', 'growth', 'business'] as const;

export class BroadcastInputError extends Error {
  constructor(message: string, public readonly status = 400) {
    super(message);
    this.name = 'BroadcastInputError';
  }
}

/** Normalized request. It is also the step-up parameter set, so keep it stable. */
export interface BroadcastInput {
  templateName: string;
  language: string;
  audience: Audience;
  country: string | null;
  plan: string | null;
  phones: string[];
  params: string[];
}

const TEMPLATE_NAME = /^[a-z][a-z0-9_]{0,511}$/;
const LANGUAGE = /^[a-z]{2,3}(_[A-Z]{2})?$/;

/** Validate and normalize a preview or send body. Throws BroadcastInputError. */
export function parseBroadcastInput(body: unknown): BroadcastInput {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const templateName = typeof b.templateName === 'string' ? b.templateName.trim() : '';
  const language = typeof b.language === 'string' ? b.language.trim() : '';
  if (!TEMPLATE_NAME.test(templateName) || !LANGUAGE.test(language)) {
    throw new BroadcastInputError('Choose an approved template.');
  }
  if (typeof b.audience !== 'string' || !(AUDIENCES as readonly string[]).includes(b.audience)) {
    throw new BroadcastInputError('Choose an audience.');
  }
  const audience = b.audience as Audience;

  let country: string | null = null;
  let plan: string | null = null;
  let phones: string[] = [];
  if (audience === 'specific') {
    const raw = Array.isArray(b.phones) ? b.phones : [];
    if (!raw.length) throw new BroadcastInputError('Enter at least one WhatsApp number.');
    if (raw.length > MAX_RECIPIENTS) throw new BroadcastInputError(`Enter at most ${MAX_RECIPIENTS} numbers.`);
    const canonical = raw.map(p => canonicalCustomerPhone(p));
    const bad = canonical.filter(p => !p).length;
    if (bad) throw new BroadcastInputError(`${bad} number(s) are not valid international WhatsApp numbers. Include the country code, for example +2348012345678.`);
    phones = [...new Set(canonical as string[])].sort();
  } else {
    if (b.country !== undefined && b.country !== null && b.country !== '') {
      if (typeof b.country !== 'string' || !/^[A-Z]{2}$/.test(b.country)) throw new BroadcastInputError('Country must be a two-letter code.');
      country = b.country;
    }
    if (b.plan !== undefined && b.plan !== null && b.plan !== '') {
      if (audience !== 'all_businesses') throw new BroadcastInputError('The plan filter applies to account owners only.');
      if (typeof b.plan !== 'string' || !(PLANS as readonly string[]).includes(b.plan)) throw new BroadcastInputError('Unknown plan.');
      plan = b.plan;
    }
  }

  const rawParams = Array.isArray(b.params) ? b.params : [];
  if (rawParams.length > 10) throw new BroadcastInputError('Too many template values.');
  const params = rawParams.map(p => (typeof p === 'string' ? p.trim() : ''));
  for (const p of params) {
    // Meta rejects empty values, new lines, tabs and runs of four spaces.
    if (!p || p.length > 1024 || /[\n\r\t]| {4,}/.test(p)) {
      throw new BroadcastInputError('Each template value must be filled in, on one line, and at most 1,024 characters.');
    }
  }
  return { templateName, language, audience, country, plan, phones, params };
}

// ── Templates ──

export interface BroadcastTemplate {
  name: string;
  language: string;
  category: 'marketing' | 'utility';
  bodyText: string;
  paramCount: number;
}

/**
 * A template this page can send: approved, marketing or utility, body values
 * numbered {{1}}..{{n}}, and no header media or button values (one shared set
 * of values is sent to everyone). Returns null for anything else.
 */
export function toBroadcastTemplate(t: MessageTemplate): BroadcastTemplate | null {
  if (t.status !== 'APPROVED' || (t.category !== 'MARKETING' && t.category !== 'UTILITY')) return null;
  const body = t.components?.find(c => c.type === 'BODY');
  if (!body?.text) return null;
  for (const c of t.components) {
    if (c.type === 'HEADER' && (c.format && c.format !== 'TEXT' || /\{\{/.test(c.text || ''))) return null;
    if (c.type === 'BUTTONS' && c.buttons?.some(btn => /\{\{/.test(btn.url || ''))) return null;
  }
  const vars = [...body.text.matchAll(/\{\{\s*([^}]*?)\s*\}\}/g)].map(m => m[1]);
  if (vars.some(v => !/^[1-9]\d*$/.test(v))) return null;
  const paramCount = new Set(vars).size;
  for (let i = 1; i <= paramCount; i++) if (!vars.includes(String(i))) return null;
  return {
    name: t.name,
    language: t.language,
    category: t.category === 'MARKETING' ? 'marketing' : 'utility',
    bodyText: body.text,
    paramCount,
  };
}

/** Every sendable template on a WhatsApp account (all pages, bounded). */
export async function listBroadcastTemplates(cloud: MetaCloudService): Promise<BroadcastTemplate[]> {
  const out: BroadcastTemplate[] = [];
  const seen = new Set<string>();
  let after: string | undefined;
  for (let page = 0; page < 20; page++) {
    const result = await cloud.getTemplates({ limit: 100, ...(after ? { after } : {}) });
    if (!Array.isArray(result.data)) throw new Error('Invalid template list');
    for (const t of result.data) {
      const usable = toBroadcastTemplate(t);
      if (usable) out.push(usable);
    }
    after = result.paging?.next ? result.paging.cursors?.after : undefined;
    if (!after) return out;
    if (seen.has(after)) throw new Error('Invalid template pagination');
    seen.add(after);
  }
  throw new Error('Template list exceeded its page limit');
}

export function renderTemplate(bodyText: string, params: string[]): string {
  return bodyText.replace(/\{\{\s*([1-9]\d*)\s*\}\}/g, (match, n) => params[Number(n) - 1] ?? match);
}

// ── Recipients ──

const PAGE = 1000;
const MAX_PAGES = 50;

async function readAll<T>(page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>): Promise<T[]> {
  const rows: T[] = [];
  for (let i = 0; i < MAX_PAGES; i++) {
    const { data, error } = await page(i * PAGE, i * PAGE + PAGE - 1);
    if (error || !data) throw new Error('Recipient read failed');
    rows.push(...data);
    if (data.length < PAGE) return rows;
  }
  throw new BroadcastInputError('This audience is too large. Narrow it with the filters.');
}

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Canonical, de-duplicated recipient numbers for the audience and filters. */
export async function resolveRecipients(db: SupabaseClient, input: BroadcastInput): Promise<{ phones: string[]; withoutNumber: number }> {
  if (input.audience === 'specific') return { phones: input.phones, withoutNumber: 0 };

  const found: Array<{ raw: string | null; country: string | null }> = [];
  if (input.audience === 'all_users') {
    const rows = await readAll<{ phone: string | null }>((from, to) =>
      db.from('profiles').select('phone').order('id').range(from, to));
    for (const r of rows) found.push({ raw: r.phone, country: null });
  } else {
    const businesses = await readAll<{ owner_id: string | null; country_code: string | null }>((from, to) => {
      let q = db.from('businesses').select('owner_id, country_code');
      if (input.country) q = q.eq('country_code', input.country);
      if (input.plan) q = q.eq('subscription_tier', input.plan);
      return q.order('id').range(from, to);
    });
    const ownerCountry = new Map<string, string | null>();
    for (const b of businesses) if (b.owner_id && !ownerCountry.has(b.owner_id)) ownerCountry.set(b.owner_id, b.country_code);
    for (const ids of chunks([...ownerCountry.keys()], 200)) {
      const { data, error } = await db.from('profiles').select('id, phone').in('id', ids);
      if (error || !data) throw new Error('Recipient read failed');
      for (const p of data as Array<{ id: string; phone: string | null }>) found.push({ raw: p.phone, country: ownerCountry.get(p.id) ?? null });
      // Owners with no profile row have no number either.
      const missing = ids.length - data.length;
      for (let i = 0; i < missing; i++) found.push({ raw: null, country: null });
    }
  }

  const phones = new Set<string>();
  let withoutNumber = 0;
  for (const f of found) {
    const canonical = canonicalCustomerPhone(f.raw, f.country);
    if (!canonical) { withoutNumber++; continue; }
    // all_users has no account country: filter on the number's own country.
    if (input.audience === 'all_users' && input.country && resolveRecipientCountry(canonical) !== input.country) continue;
    phones.add(canonical);
  }
  return { phones: [...phones].sort(), withoutNumber };
}

export type RecipientCheck = 'ok' | 'opted_out' | 'suspended' | 'unverified';

/**
 * Suspension (#1103) and Waaiio-level opt-out for each number, read in
 * batches. Any failed read marks its whole batch 'unverified' (skipped).
 * Opt-outs counted here are the platform's own: a STOP with no business
 * (messaging_opt_outs.business_id IS NULL) or a launch-alert opt-out.
 */
export async function checkRecipients(db: SupabaseClient, phones: string[]): Promise<Map<string, RecipientCheck>> {
  const result = new Map<string, RecipientCheck>();
  for (const batch of chunks(phones, 100)) {
    const variants = batch.flatMap(p => [p, `+${p}`]);
    const digits = (v: string) => v.replace(/\D/g, '');
    try {
      const [suspended, optOuts, launch] = await Promise.all([
        db.from('customer_suspensions').select('phone').in('phone', batch),
        db.from('messaging_opt_outs').select('phone').in('phone', variants)
          .is('business_id', null).eq('channel', 'whatsapp').is('resubscribed_at', null),
        db.from('launch_subscribers').select('wa_number').in('wa_number', variants).eq('opt_in_status', 'opted_out'),
      ]);
      if (suspended.error || optOuts.error || launch.error || !suspended.data || !optOuts.data || !launch.data) throw new Error('read failed');
      const suspendedSet = new Set((suspended.data as Array<{ phone: string }>).map(r => digits(r.phone)));
      const optedOut = new Set([
        ...(optOuts.data as Array<{ phone: string }>).map(r => digits(r.phone)),
        ...(launch.data as Array<{ wa_number: string }>).map(r => digits(r.wa_number)),
      ]);
      for (const p of batch) result.set(p, suspendedSet.has(p) ? 'suspended' : optedOut.has(p) ? 'opted_out' : 'ok');
    } catch {
      for (const p of batch) result.set(p, 'unverified');
    }
  }
  return result;
}

// ── Senders ──

export interface SenderChoice {
  /** Stable key for the sending WhatsApp account (template approval is per account). */
  accountKey: string;
  sender: MessageSender;
  cloud: MetaCloudService;
}

/** Shared-number lookup by country; the route passes a ChannelResolver-backed one. */
export type SharedSenderLookup = (country: string) => Promise<SenderChoice | null>;

/** Exact-country shared number, then the approved fallback (GH → NG). Cached per country. */
export function senderForPhone(lookup: SharedSenderLookup) {
  const cache = new Map<string, Promise<SenderChoice | null>>();
  const byCountry = (country: string) => {
    if (!cache.has(country)) {
      cache.set(country, (async () => {
        for (const c of [country, ...(SHARED_CHANNEL_FALLBACK_COUNTRIES[country] ?? [])]) {
          const choice = await lookup(c as CountryCode);
          if (choice) return choice;
        }
        return null;
      })());
    }
    return cache.get(country)!;
  };
  return async (phone: string) => {
    const country = resolveRecipientCountry(phone);
    return country ? byCountry(country) : null;
  };
}

/**
 * Confirm the template is approved on every account that will send it. With
 * no sender at all (nobody reachable), it is checked on the default Waaiio
 * account so a preview can still show it.
 */
export async function assertTemplateOnSenders(
  choices: Array<SenderChoice | null>, input: BroadcastInput, defaultCloud: MetaCloudService,
): Promise<BroadcastTemplate> {
  const accounts = new Map<string, Pick<SenderChoice, 'cloud'>>();
  for (const c of choices) if (c && !accounts.has(c.accountKey)) accounts.set(c.accountKey, c);
  if (!accounts.size) accounts.set('default', { cloud: defaultCloud });
  let template: BroadcastTemplate | null = null;
  for (const choice of accounts.values()) {
    let found: BroadcastTemplate | undefined;
    try {
      found = (await listBroadcastTemplates(choice.cloud)).find(t => t.name === input.templateName && t.language === input.language);
    } catch {
      throw new BroadcastInputError('Unable to check the template with WhatsApp. Try again.', 502);
    }
    if (!found) throw new BroadcastInputError(`Template ${input.templateName} (${input.language}) is not approved on every Waaiio number that would send it.`, 422);
    template = found;
  }
  if (!template) throw new BroadcastInputError('Choose an approved template.', 422);
  if (template.paramCount !== input.params.length) {
    throw new BroadcastInputError(`This template needs ${template.paramCount} value(s).`);
  }
  return template;
}

// ── Cost estimate ──

export interface CostEstimate {
  byCurrency: Array<{ currency: string; amountMinor: number; recipients: number }>;
  unpriced: number;
}

/**
 * Estimate at Waaiio's own per-message rates for the template's category and
 * each recipient's country (the newest effective messaging_pricing). Waaiio
 * pays; no merchant is charged. Null when the pricing cannot be read.
 */
export async function estimateCost(db: SupabaseClient, phones: string[], category: 'marketing' | 'utility', now = new Date()): Promise<CostEstimate | null> {
  const { data, error } = await db.from('platform_config_versions').select('config_snapshot')
    .lte('effective_from', now.toISOString()).order('effective_from', { ascending: false }).limit(1).maybeSingle();
  if (error) return null;
  const pricing = ((data as { config_snapshot?: Record<string, unknown> } | null)?.config_snapshot?.messaging_pricing || {}) as Parameters<typeof billingCurrencyAndRate>[0];
  const totals = new Map<string, { amountMinor: number; recipients: number }>();
  let unpriced = 0;
  for (const phone of phones) {
    const country = resolveRecipientCountry(phone);
    const rate = country ? billingCurrencyAndRate(pricing, country, category) : null;
    if (!rate || rate.cost === null) { unpriced++; continue; }
    const t = totals.get(rate.currency) ?? { amountMinor: 0, recipients: 0 };
    t.amountMinor += rate.cost;
    t.recipients++;
    totals.set(rate.currency, t);
  }
  return {
    byCurrency: [...totals.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([currency, t]) => ({ currency, ...t })),
    unpriced,
  };
}

// ── Delivery ──

export interface DeliverySummary {
  sent: number;
  failed: number;
  unknown: number;
  noSender: number;
  skippedOptedOut: number;
  skippedSuspended: number;
  skippedUnverified: number;
}

const SKIP_STATUS: Record<Exclude<RecipientCheck, 'ok'>, string> = {
  opted_out: 'skipped_opted_out',
  suspended: 'skipped_suspended',
  unverified: 'skipped_unverified',
};

/**
 * Send to each recipient once. The recipient row is claimed before the
 * provider call; a number already recorded for this broadcast is not sent
 * again. Sends are spaced by intervalMs.
 */
export async function deliverBroadcast(db: SupabaseClient, opts: {
  broadcastId: string;
  phones: string[];
  checks: Map<string, RecipientCheck>;
  senderFor: (phone: string) => Promise<SenderChoice | null>;
  template: BroadcastTemplate;
  params: string[];
  intervalMs?: number;
}): Promise<DeliverySummary> {
  const summary: DeliverySummary = { sent: 0, failed: 0, unknown: 0, noSender: 0, skippedOptedOut: 0, skippedSuspended: 0, skippedUnverified: 0 };
  const interval = opts.intervalMs ?? SEND_INTERVAL_MS;
  const table = () => db.from('admin_broadcast_recipients');
  const finish = (phone: string, fields: Record<string, unknown>) =>
    table().update({ ...fields, updated_at: new Date().toISOString() }).eq('broadcast_id', opts.broadcastId).eq('phone', phone);
  let first = true;

  for (const phone of opts.phones) {
    const check = opts.checks.get(phone) ?? 'unverified';
    if (check !== 'ok') {
      await table().upsert({ broadcast_id: opts.broadcastId, phone, status: SKIP_STATUS[check] },
        { onConflict: 'broadcast_id,phone', ignoreDuplicates: true });
      if (check === 'opted_out') summary.skippedOptedOut++;
      else if (check === 'suspended') summary.skippedSuspended++;
      else summary.skippedUnverified++;
      continue;
    }

    // Claim before sending. No row back means it was already handled (or the
    // write failed): either way, do not send.
    const { data: claimed, error: claimError } = await table()
      .upsert({ broadcast_id: opts.broadcastId, phone, status: 'sending' }, { onConflict: 'broadcast_id,phone', ignoreDuplicates: true })
      .select('id');
    if (claimError || !claimed?.length) { summary.failed++; continue; }

    const choice = await opts.senderFor(phone);
    if (!choice?.sender.sendPlatformTemplate) {
      await finish(phone, { status: 'failed', error: 'no_sender' });
      summary.noSender++;
      continue;
    }

    if (!first && interval > 0) await new Promise(r => setTimeout(r, interval));
    first = false;
    try {
      const result = await choice.sender.sendPlatformTemplate({
        to: phone,
        templateName: opts.template.name,
        languageCode: opts.template.language,
        templateParams: opts.params,
        messageCategory: opts.template.category,
      });
      await finish(phone, { status: 'sent', meta_message_id: result.messageId ?? null });
      summary.sent++;
    } catch (err) {
      const ambiguous = err instanceof AmbiguousSendError;
      await finish(phone, {
        status: ambiguous ? 'unknown' : 'failed',
        error: (err instanceof Error ? err.message : 'send failed').slice(0, 500),
      });
      if (ambiguous) summary.unknown++;
      else summary.failed++;
    }
  }
  return summary;
}
