import type { SupabaseClient } from '@supabase/supabase-js';
import type { FlowExecutor } from '../flows/executor';
import type { BotSession, BusinessRecord } from '../bot-types';

/**
 * Route the user to the My Account Menu flow step.
 */
export async function routeToMyAccountMenu(
  supabase: SupabaseClient,
  flowExecutor: FlowExecutor,
  session: BotSession,
  from: string,
): Promise<void> {
  // Update session_data and current_step in memory BEFORE passing to executor
  session.session_data = { ...session.session_data, active_capability: 'my_account' };
  session.current_step = 'my_account_menu';

  await supabase.from('bot_sessions')
    .update({ current_step: 'my_account_menu', session_data: session.session_data })
    .eq('id', session.id);

  // Load business for flow context
  let biz = null;
  if (session.business_id) {
    const { data } = await supabase
      .from('businesses')
      .select('id, name, slug, category, flow_type, subscription_tier, trial_ends_at, metadata, operating_hours, country_code, payment_gateway')
      .eq('id', session.business_id).single();
    biz = data;
  }

  await flowExecutor.execute(from, '', session as unknown as BotSession, biz as BusinessRecord | null);
}
