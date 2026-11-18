import type { SupabaseClient } from '@supabase/supabase-js';

/** Fail closed: menu visibility follows the recorded inbound channel, never country or plan. */
export async function isSharedConversation(supabase: SupabaseClient, data: Record<string, unknown>): Promise<boolean> {
  if (typeof data._inbound_channel_id !== 'string') return false;
  const { data: channel, error } = await supabase.from('whatsapp_channels')
    .select('channel_type').eq('id', data._inbound_channel_id).eq('is_active', true).maybeSingle();
  return !error && channel?.channel_type === 'shared';
}

export const DIRECTORY_ACTION = { id: 'nav_directory', title: 'Search directory' };

// "View Options" on a next-steps menu carries the business it belongs to, so a tap
// after the chat has expired can go back to that business (Owner bug 2026-11-18).
// Older menus sent the bare ids ('menu', 'pc_options'); both forms are accepted.
const VIEW_OPTIONS_POSTBACK = /^(menu|pc_options):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const STALE_NEXT_STEPS_IDS = /^(menu|pc_options|pc_done|pc_again|pc_history)$/i;

/** Button id for a next-steps "View Options" tap that names its business. */
export function viewOptionsPostback(id: 'menu' | 'pc_options', businessId: string | null | undefined): string {
  return businessId ? `${id}:${businessId}` : id;
}

/** Splits "menu:<businessId>" into the bare id and the business it names (unverified). */
export function parseViewOptionsPostback(text: string): { id: string; businessId: string } | null {
  const match = text.match(VIEW_OPTIONS_POSTBACK);
  return match ? { id: match[1].toLowerCase(), businessId: match[2].toLowerCase() } : null;
}

/** A next-steps menu id: navigation, never something to search the directory for. */
export function isNextStepsNavigation(text: string): boolean {
  return STALE_NEXT_STEPS_IDS.test(text);
}
export const DIRECTORY_PROMPT = 'What would you like to find? Try *restaurants in Ikoyi* or *barbers in Lekki*. You can also enter a business name or code.';

/** Preserve conversation authority and identity, but never copy an old payment or checkout. */
export function repeatSessionData(data: Record<string, unknown>): Record<string, unknown> {
  const keys = ['_inbound_channel_id', '_conversation_version', 'biz_resolution', 'capabilities',
    '_detected_language', 'business_category', 'business_name', 'first_name', 'last_name',
    'customer_name', 'customer_email', 'email', 'phone', '_customer_history'];
  return Object.fromEntries(keys.filter(key => key in data).map(key => [key, data[key]]));
}

/** Navigation only: no claims about payment or fulfillment state. */
export function transactionNextSteps(kind: string, shared: boolean): string {
  const history = kind === 'ordering' ? 'my orders' : kind === 'giving' || kind === 'crowdfunding'
    ? 'my giving' : kind === 'payment' || kind === 'invoice' ? 'history' : 'my bookings';
  return `Type *${history}* to view your activity. Type *menu* for this business's options.`
    + (shared ? '\nType *directory* to search for another business.' : '');
}

/** Save directory state before inviting a reply. Never overwrite another number's picker. */
export async function persistDirectoryEntry(supabase: SupabaseClient, phone: string, data: Record<string, unknown>): Promise<boolean> {
  const readCurrent = () => {
    let query = supabase.from('bot_sessions').select('id, version, session_data')
      .eq('whatsapp_number', phone).is('business_id', null).eq('is_active', true);
    query = typeof data._inbound_channel_id === 'string'
      ? query.eq('session_data->>_inbound_channel_id', data._inbound_channel_id)
      : query.is('session_data->>_inbound_channel_id', null);
    return query.maybeSingle();
  };
  const saveExisting = async (row: { id: string; version?: number; session_data?: Record<string, unknown> }) => {
    if (row.session_data?._inbound_channel_id !== data._inbound_channel_id) return false;
    const { data: result, error } = await supabase.from('bot_sessions').update({
      current_step: 'directory_search', session_data: data,
      expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(), version: (row.version ?? 0) + 1,
    }).eq('id', row.id).eq('whatsapp_number', phone).is('business_id', null)
      .eq('is_active', true).eq('version', row.version ?? 0).select('id').maybeSingle();
    return !error && !!result;

  };
  const current = await readCurrent();
  if (current.error) return false;
  if (current.data) return saveExisting(current.data);
  const insertFresh = () => supabase.from('bot_sessions').insert({
    whatsapp_number: phone, user_id: null, business_id: null, current_step: 'directory_search',
    session_data: data, is_active: true, expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
  }).select('id').single();
  let inserted = await insertFresh();
  if (!inserted.error && inserted.data) return true;
  if (inserted.error?.code !== '23505') return false;
  // Pre-channel pickers can outlive their TTL while occupying the phone-only unique index.
  // Retire only expired, unbound navigation state; never adopt its business suggestions.
  const cutoff = new Date().toISOString();
  const legacyFilter = (query: any) => query.eq('whatsapp_number', phone)
    .is('business_id', null).eq('is_active', true)
    .is('session_data->>_inbound_channel_id', null).lt('expires_at', cutoff)
    .in('current_step', ['select_business_suggestion', 'directory_search', 'directory_results']);
  const legacy = await legacyFilter(supabase.from('bot_sessions').select('id, version')).maybeSingle();
  if (legacy.error) return false;
  if (legacy.data) {
    const retired = await legacyFilter(supabase.from('bot_sessions').update({
      is_active: false, version: (legacy.data.version ?? 0) + 1,
    })).eq('id', legacy.data.id).eq('version', legacy.data.version ?? 0).select('id').maybeSingle();
    if (retired.error || !retired.data) return false; // Concurrent renewal wins.
    inserted = await insertFresh();
    if (!inserted.error && inserted.data) return true;
    if (inserted.error?.code !== '23505') return false;
  }
  // A concurrent click may have won. Re-read only this channel and use CAS.
  const winner = await readCurrent();
  return !winner.error && winner.data ? saveExisting(winner.data) : false;
}
