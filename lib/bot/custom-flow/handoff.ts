// ─────────────────────────────────────────────────────────────────────
// Waaiio Custom Flow — "Use what you already have" handoff (Issue #1086)
//
// A handoff step passes the customer to an existing capability flow. The
// existing flow then runs unchanged from its first step: its own record
// validation, payment authority, "I've Paid", confirmation and next-steps
// menu. Nothing here creates a payment or decides a payment route.
//
// Re-entry reuses the quick-rebook pattern in BotService: the normal bot
// session is positioned on the capability's first step and the record id is
// fed to that step's own validator, which reloads it under business_id.
// ─────────────────────────────────────────────────────────────────────

import type { SupabaseClient } from '@supabase/supabase-js';
import { logger } from '@/lib/logger';
import { getEffectiveCapabilities } from '@/lib/capabilities/policy';
import { getConfiguredCapabilities } from '@/lib/capabilities/service';
import { getLegacyDefaultCapabilities } from '@/lib/capabilities/legacy-defaults';
import { resolveFeatureTrialEndsAt } from '@/lib/trial-status';
import { repeatSessionData } from '../flows/shared/navigation';
import type { CustomFlowHandoffCapability, CustomFlowHandoffNode } from './types';

/** First step of each existing flow (same ids as capability-selection getFirstStepForCapability). */
export const HANDOFF_FIRST_STEP: Record<CustomFlowHandoffCapability, string> = {
  ticketing: 'select_event',
  giving: 'select_category',
  payment: 'select_category',
  chat: 'chat_start',
};

export interface CapabilityHandoffRequest {
  capability: CustomFlowHandoffCapability;
  recordId: string | null;
  /** Display name of the chosen record (preview only). */
  recordName: string | null;
  /** Closes the custom session. The runner calls it after the bot session is ready, before the existing flow speaks. */
  closeCustomSession: () => Promise<boolean>;
}

/** Returns true when the existing flow took over; false leaves the custom session as it was. */
export type CapabilityHandoff = (request: CapabilityHandoffRequest) => Promise<boolean>;

/** UTC calendar day, the same rule ticketing uses for "upcoming". */
function todayUtc(now: Date): string {
  return now.toISOString().split('T')[0];
}

/**
 * The node's record, if it still belongs to this business and is available
 * to start with. Used at publish time (route) and at runtime (engine).
 * Only `select`, `eq` and `maybeSingle` are used, so the builder preview's
 * read-only facade can run it unchanged.
 *
 * Returns `{ name: null }` when the node has no record, `null` when the
 * record is not usable.
 */
export async function checkHandoffRecord(
  db: SupabaseClient,
  businessId: string,
  node: Pick<CustomFlowHandoffNode, 'capability' | 'record_id'>,
  now = new Date(),
): Promise<{ name: string | null } | null> {
  const recordId = node.record_id ?? null;
  if (!recordId) return { name: null };
  if (node.capability === 'chat') return null;

  if (node.capability === 'ticketing') {
    const { data: event, error } = await db.from('events')
      .select('id, business_id, name, status, date, time, total_tickets, tickets_sold')
      .eq('business_id', businessId).eq('id', recordId).maybeSingle();
    if (error || !event || event.business_id !== businessId || event.status !== 'published') return null;
    const today = todayUtc(now);
    if (typeof event.date !== 'string' || event.date < today) return null;
    if (event.date === today && typeof event.time === 'string' && /^\d{2}:\d{2}/.test(event.time)) {
      if (new Date(`${event.date}T${event.time.slice(0, 5)}:00Z`).getTime() <= now.getTime()) return null;
    }
    if (Number(event.total_tickets) - Number(event.tickets_sold) <= 0) return null;
    return { name: String(event.name ?? '') };
  }

  const { data: service, error } = await db.from('services')
    .select('id, business_id, name, is_active, service_type, deleted_at')
    .eq('business_id', businessId).eq('id', recordId).maybeSingle();
  if (error || !service || service.business_id !== businessId || service.is_active !== true || service.deleted_at) return null;
  const isGiving = service.service_type === 'giving';
  if (node.capability === 'giving' ? !isGiving : isGiving) return null;
  return { name: String(service.name ?? '') };
}

/** Current effective capabilities, resolved the same way as the bot's session-resume revalidation. Null on any read error. */
async function loadEffectiveCapabilities(
  supabase: SupabaseClient,
  business: { id: string; category?: string | null; subscription_tier?: string | null },
): Promise<string[] | null> {
  const capResult = await getConfiguredCapabilities(supabase, business.id);
  if (!capResult.ok) return null;
  const { data: overrideRows, error } = await supabase.from('capability_overrides').select('capability').eq('business_id', business.id);
  if (error) return null;
  let configured = capResult.rows;
  if (configured.length === 0) {
    configured = getLegacyDefaultCapabilities(business.category ?? 'other').map((capability, index) => ({
      capability, is_enabled: true, sort_order: index,
    }));
  }
  const trialEndsAt = await resolveFeatureTrialEndsAt(supabase, business.id);
  return getEffectiveCapabilities({
    configuredCapabilities: configured,
    overrides: (overrideRows ?? []).map((row: { capability: string }) => row.capability),
    tier: business.subscription_tier || 'free',
    trialEndsAt,
  }).effective;
}

interface BotSessionLike {
  id: string;
  business_id: string | null;
  current_step: string;
  session_data: Record<string, unknown>;
  version?: number;
}

/**
 * BotService side of a handoff. Prepares the normal bot session on the
 * capability's first step, closes the custom session, then runs the
 * existing executor with the record id (or an empty input for the step's
 * own prompt). Returns false, without touching the custom session, when the
 * business, capability, channel or session write is not usable.
 */
export async function startCapabilityHandoff(deps: {
  supabase: SupabaseClient;
  from: string;
  businessId: string;
  destinationPhone?: string;
  /** The customer's current bot session, if any (as loaded by BotService). */
  botSession: BotSessionLike | null;
  userId: string | null;
  request: CapabilityHandoffRequest;
  /** Runs FlowExecutor.execute for the prepared session (BotService adds translation overrides). */
  execute: (session: BotSessionLike, input: string, business: Record<string, unknown>) => Promise<void>;
}): Promise<boolean> {
  const { supabase, from, businessId, request } = deps;
  const tag = `[CUSTOM-FLOW] handoff ${request.capability} business=${businessId}`;

  const { data: business, error: businessError } = await supabase.from('businesses').select('*').eq('id', businessId).maybeSingle();
  if (businessError || !business || business.status !== 'active') {
    logger.warn(`${tag}: business unavailable`);
    return false;
  }
  const capabilities = await loadEffectiveCapabilities(supabase, business);
  if (!capabilities || !capabilities.includes(request.capability)) {
    logger.warn(`${tag}: capability not in effective set`);
    return false;
  }

  // Same channel-identity rule as the new-session path (#219): a dedicated
  // channel must belong to this business; its id is kept for confirmations.
  let inboundChannelId: string | null = null;
  if (deps.destinationPhone) {
    const { data: channel, error } = await supabase.from('whatsapp_channels')
      .select('id, channel_type, business_id').eq('phone_number_id', deps.destinationPhone).eq('is_active', true).maybeSingle();
    if (error) return false;
    if (channel) {
      if (channel.channel_type === 'dedicated' && channel.business_id && channel.business_id !== businessId) {
        logger.error(`${tag}: dedicated channel belongs to another business`);
        return false;
      }
      inboundChannelId = channel.id;
    }
  }

  const existing = deps.botSession;
  if (existing && existing.business_id !== businessId) {
    // Fail closed rather than replace another business's session.
    logger.warn(`${tag}: active bot session belongs to another business`);
    return false;
  }

  const firstStep = HANDOFF_FIRST_STEP[request.capability];
  const base = existing ? repeatSessionData(existing.session_data) : {};
  const channelId = inboundChannelId ?? (base._inbound_channel_id as string | undefined);
  const sessionData: Record<string, unknown> = {
    ...base,
    ...(channelId ? { _inbound_channel_id: channelId } : {}),
    business_id: businessId,
    business_name: business.name,
    business_category: business.category,
    capabilities,
    active_capability: request.capability,
    _step_history: ['select_capability', firstStep],
    // The payment flow's validator rejects an inactive or wrong-kind option when this matches the input.
    ...(request.recordId && request.capability !== 'ticketing' ? { _repeat_selection_id: request.recordId } : {}),
  };

  let session: BotSessionLike;
  if (existing) {
    const { data: cas, error } = await supabase.rpc('update_session_cas', {
      p_session_id: existing.id,
      p_expected_version: existing.version ?? 0,
      p_current_step: firstStep,
      p_session_data: sessionData,
    });
    if (error || !cas?.success) {
      logger.warn(`${tag}: bot session CAS lost (${error?.message ?? cas?.reason ?? 'unknown'})`);
      return false;
    }
    session = { ...existing, current_step: firstStep, session_data: sessionData, version: cas.version };
  } else {
    // Mirrors the new-session path's cleanup so the per-business unique index is free.
    const nowIso = new Date().toISOString();
    await supabase.from('bot_sessions').delete().eq('whatsapp_number', from).eq('business_id', businessId).eq('is_active', false);
    await supabase.from('bot_sessions').delete().eq('whatsapp_number', from).eq('business_id', businessId).eq('is_active', true).lt('expires_at', nowIso);
    const { data: inserted, error } = await supabase.from('bot_sessions').insert({
      whatsapp_number: from,
      user_id: deps.userId,
      business_id: businessId,
      current_step: firstStep,
      session_data: sessionData,
      is_active: true,
      expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    }).select().single();
    if (error || !inserted) {
      logger.warn(`${tag}: bot session insert failed (${error?.code ?? 'no row'})`);
      return false;
    }
    session = inserted as unknown as BotSessionLike;
  }

  // The custom session must be closed before the existing flow speaks, or
  // the customer's next reply would be read by the custom engine.
  if (!(await request.closeCustomSession())) return false;
  await deps.execute(session, request.recordId ?? '', business);
  return true;
}
