// ─────────────────────────────────────────────────────────────────────
// Waaiio Custom Flow — session store (Issue #1013, Phase 1)
//
// Custom sessions live in their own table (custom_flow_sessions), NOT in
// bot_sessions.session_data: the code-flow executor updates bot_sessions
// with version-gated CAS writes, and a second writer would race it.
// whatsapp_number is the RAW inbound transport key (DB-005): no '+'
// normalization, exact match on Meta `from`.
// ─────────────────────────────────────────────────────────────────────

import type { SupabaseClient } from '@supabase/supabase-js';
import { logger } from '@/lib/logger';
import type { CustomFlowSessionRow } from './types';

export const CUSTOM_FLOW_SESSION_TTL_HOURS = 24;

/** Load the active session for this business + raw phone, if any. */
export async function loadActiveSession(
  supabase: SupabaseClient,
  businessId: string,
  whatsappNumber: string,
): Promise<CustomFlowSessionRow | null> {
  const { data, error } = await supabase
    .from('custom_flow_sessions')
    .select('*')
    .eq('business_id', businessId)
    .eq('whatsapp_number', whatsappNumber)
    .eq('is_active', true)
    .maybeSingle();
  if (error || !data) return null;
  return data as unknown as CustomFlowSessionRow;
}

/** Create a new session at the flow's start node. */
export async function createSession(
  supabase: SupabaseClient,
  args: {
    businessId: string;
    whatsappNumber: string;
    flowId: string;
    flowVersion: number;
    startNodeId: string;
  },
): Promise<CustomFlowSessionRow | null> {
  const expiresAt = new Date(Date.now() + CUSTOM_FLOW_SESSION_TTL_HOURS * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from('custom_flow_sessions')
    .insert({
      business_id: args.businessId,
      whatsapp_number: args.whatsappNumber,
      flow_id: args.flowId,
      flow_version: args.flowVersion,
      current_node_id: args.startNodeId,
      fields: {},
      version: 0,
      is_active: true,
      expires_at: expiresAt,
    })
    .select('*')
    .single();
  if (error || !data) return null;
  return data as unknown as CustomFlowSessionRow;
}

/**
 * Version-guarded session update. Returns true when the write won the race,
 * false when another writer moved the session first (caller must re-read).
 */
export async function updateSessionCas(
  supabase: SupabaseClient,
  session: CustomFlowSessionRow,
  patch: { current_node_id?: string; fields?: Record<string, unknown>; expires_at?: string; flow_version?: number },
): Promise<boolean> {
  const { data, error } = await supabase
    .from('custom_flow_sessions')
    .update({ ...patch, version: session.version + 1 })
    .eq('id', session.id)
    .eq('version', session.version)
    .eq('is_active', true)
    .select('id');
  // A lost race returns zero rows with no error — that is a failure.
  return !error && Array.isArray(data) && data.length > 0;
}

/** Close a session (end of flow, exit, or replacement by a new start). Returns false (and logs) when the write fails instead of swallowing the error. */
export async function closeSession(
  supabase: SupabaseClient,
  sessionId: string,
): Promise<boolean> {
  const { error } = await supabase
    .from('custom_flow_sessions')
    .update({ is_active: false })
    .eq('id', sessionId);
  if (error) {
    logger.error('[CUSTOM-FLOW] closeSession failed:', error.message);
    return false;
  }
  return true;
}

/** True when the session's 24h window has passed. */
export function isSessionExpired(session: CustomFlowSessionRow, now = new Date()): boolean {
  return new Date(session.expires_at).getTime() <= now.getTime();
}
