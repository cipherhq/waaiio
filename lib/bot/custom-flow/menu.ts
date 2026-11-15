import type { SupabaseClient } from '@supabase/supabase-js';
import { requireCurrentCapability } from '../flows/shared/capability-guard';
import { parseDefinition, validateDefinition } from './definition';

export const FLOW_START_PREFIX = 'cf-start:';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export interface PublishedFlowChoice { id: string; name: string }
interface MenuSession {
  id: string;
  business_id?: string | null;
  current_step: string;
  session_data: Record<string, unknown>;
}
interface MenuSnapshot { businessId: string; sessionId: string; postbacks: string[] }

/** Display eligibility is rechecked independently by the engine on selection. */
export async function publishedFlowChoices(supabase: SupabaseClient, businessId: string): Promise<PublishedFlowChoice[]> {
  const entitlement = await requireCurrentCapability(supabase, { businessId, capability: 'custom_flow', action: 'create_new' });
  if (!entitlement.allowed) return [];
  const { data, error } = await supabase.from('custom_flows')
    .select('id, published_definition').eq('business_id', businessId).eq('status', 'published').order('id', { ascending: true });
  if (error) throw error;
  return (data ?? []).flatMap(row => {
    const definition = parseDefinition(row.published_definition);
    return UUID.test(row.id) && definition && validateDefinition(definition).length === 0
      ? [{ id: row.id, name: definition.name }] : [];
  });
}

/** Store only the current displayed page, not a freshly reordered choice list. */
export function rememberFlowMenu(session: MenuSession, businessId: string, postbacks: string[]): void {
  session.session_data._custom_flow_menu = { businessId, sessionId: session.id, postbacks } satisfies MenuSnapshot;
}

export function resolveFlowMenuSelection(session: MenuSession | null | undefined, businessId: string, input: string):
  { kind: 'pass' } | { kind: 'unavailable' } | { kind: 'selection'; postback: string; flowId?: string } {
  const snapshot = session?.session_data._custom_flow_menu as MenuSnapshot | undefined;
  const explicit = input.startsWith(FLOW_START_PREFIX);
  const numeric = /^\d{1,2}$/.test(input.trim());
  if (!explicit && !(numeric && snapshot)) return { kind: 'pass' };
  if (!session || session.current_step !== 'select_capability' || session.business_id !== businessId ||
      !snapshot || snapshot.businessId !== businessId || snapshot.sessionId !== session.id ||
      !Array.isArray(snapshot.postbacks)) return { kind: 'unavailable' };
  const postback = explicit ? input : snapshot.postbacks[Number(input) - 1];
  if (!postback || !snapshot.postbacks.includes(postback)) return { kind: 'unavailable' };
  if (!postback.startsWith(FLOW_START_PREFIX)) return { kind: 'selection', postback };
  const flowId = postback.slice(FLOW_START_PREFIX.length);
  return UUID.test(flowId) ? { kind: 'selection', postback, flowId } : { kind: 'unavailable' };
}
