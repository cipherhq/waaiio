import type { SupabaseClient } from '@supabase/supabase-js';
import type { CustomFlowDefinition } from '@/lib/bot/custom-flow/types';
import { businessData } from '@/lib/bot/custom-flow/sources';
import { loadAnswerRows } from '@/lib/bot/custom-flow/table-data';
import { hasValue, variablesIn } from '@/lib/bot/custom-flow/data';

export async function guidedReadiness(db: SupabaseClient, businessId: string, draft: CustomFlowDefinition) {
  if (!draft.guided && !draft.business_bindings) return { missingBusiness: false, sections: [] as string[] };
  const settings = await businessData(db,businessId,draft.business_bindings ?? []);
  const texts = [draft.greeting,draft.fallback_message,...draft.nodes.flatMap(n=>n.type==='message' ? [n.text] : n.type==='menu' ? [n.text] : n.type==='handoff' ? [] : n.type==='ask' ? [n.question,n.retry_message ?? ''] : [n.prompt ?? '',n.reply,n.no_match])];
  const missingBusiness = !settings.timezone || !settings.currency
    || Object.values(settings.vars).some(v=>!hasValue(v))
    || texts.flatMap(variablesIn).some(key=>key.startsWith('business.') && !hasValue(settings.vars[key]));
  const reachable = new Set<string>();
  const visit=(id:string|undefined|null)=>{
    if(!id || reachable.has(id))return;
    reachable.add(id);
    const node=draft.nodes.find(n=>n.id===id);
    if(node?.type==='menu')node.options.forEach(o=>visit(o.next));
    else if(node?.type==='lookup')visit(node.next ?? draft.start_node ?? draft.nodes[0]?.id);
    else if(node && node.type!=='handoff')visit(node.next); // a handoff ends the custom flow (#1086)
  };
  visit(draft.start_node ?? draft.nodes[0]?.id);
  const sections: string[]=[];
  for(const section of draft.guided?.sections ?? []) {
    const node=draft.nodes.find(n=>n.id===section.node_id);
    if(section.enabled && (!node || node.type!=='lookup' || node.table!==section.table || !reachable.has(node.id))) sections.push(section.id);
    if(!section.enabled && reachable.has(section.node_id)) sections.push(section.id);
  }
  for(const node of draft.nodes) {
    if(node.type==='lookup' && reachable.has(node.id) && !(await loadAnswerRows(db,businessId,draft.id,node.table,node.reply,settings.vars)).length) sections.push(node.id);
  }
  return {missingBusiness,sections:[...new Set(sections)],settings};
}
