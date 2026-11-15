import type { SupabaseClient } from '@supabase/supabase-js';
import type { MessageSender } from '@/lib/channels/message-sender';
import { parseUpdatesOptInPostback } from '../customer-updates-optin';
import { CustomFlowEngine } from './engine';
import { FLOW_START_PREFIX, resolveFlowMenuSelection } from './menu';
import { loadActiveSession } from './session';

/** The normal menu owns the selection claim; the existing engine owns the flow. */
export async function handleCustomFlowMenu(args: {
  supabase: SupabaseClient; sender: MessageSender; businessId: string; from: string; text: string;
  isPinStep: boolean; isBusinessCode: (text: string) => Promise<boolean>;
  session: { id: string; business_id: string | null; current_step: string; version?: number; session_data: Record<string, unknown> } | null;
}): Promise<{ kind: 'pass' } | { kind: 'started' | 'unavailable' } | { kind: 'mapped'; text: string }> {
  if (args.isPinStep) return { kind: 'pass' };
  const explicit = args.text.startsWith(FLOW_START_PREFIX);
  if (!explicit && (args.session?.current_step !== 'select_capability' || !args.session?.session_data._custom_flow_menu || !/^\d{1,2}$/.test(args.text))) return { kind: 'pass' };
  // Numbers still answer an active custom flow, and exact business codes keep priority.
  if (!explicit && await args.isBusinessCode(args.text)) return { kind: 'pass' };
  if (await loadActiveSession(args.supabase, args.businessId, args.from)) return { kind: explicit ? 'unavailable' : 'pass' };
  const choice = resolveFlowMenuSelection(args.session, args.businessId, args.text);
  if (choice.kind !== 'selection') return choice;
  // Consent requires a real tap; never promote typed menu numbers into consent.
  if (parseUpdatesOptInPostback(choice.postback)) return { kind: 'unavailable' };
  if (!choice.flowId) return { kind: 'mapped', text: choice.postback };
  const session = args.session!;
  const data = { ...session.session_data };
  delete data._custom_flow_menu;
  delete data._cap_menu_page;
  delete data._cap_menu_total_pages;
  const { data: claim, error } = await args.supabase.rpc('update_session_cas', {
    p_session_id: session.id, p_expected_version: session.version ?? 0,
    p_current_step: 'select_capability', p_session_data: data,
  });
  if (error || !claim?.success) return { kind: 'unavailable' };
  session.session_data = data;
  session.version = claim.version;
  const engine = new CustomFlowEngine(args);
  return { kind: await engine.startById(args.businessId, args.from, choice.flowId) ? 'started' : 'unavailable' };
}
