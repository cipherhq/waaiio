import type { CustomFlowAnswerType, CustomFlowDefinition, CustomFlowNode } from '@/lib/bot/custom-flow/types';
import type { GuidedMetadata } from '@/lib/bot/custom-flow/data';
import { HANDOFF_FEATURE_NAME } from '@/lib/bot/custom-flow/handoff-copy';

/**
 * Editor display only, in plain English (#1079); graph identities and
 * destinations remain node IDs and the stored definition is unchanged.
 */
/** Plain names for "Ask a question" steps (#1085), shared by the palette, map and tips. */
export const ASK_STEP_NAME: Record<CustomFlowAnswerType, string> = {
  yes_no: 'Yes or no', choice: 'Pick one', date: 'Pick a date', text: 'Short answer', file: 'Photo or PDF',
};

export function blockLabel(node: CustomFlowNode, guided?: GuidedMetadata): string {
  if (node.type === 'ask') return ASK_STEP_NAME[node.answer_type] ?? 'Ask a question';
  if (node.type === 'handoff') return HANDOFF_FEATURE_NAME[node.capability] ?? 'Use what you already have';
  if (node.type !== 'lookup') return node.type === 'message' ? 'Send a message' : 'Show buttons';
  const section = guided?.sections.find(item => item.node_id === node.id && item.table === node.table);
  const name = section?.label.trim() || node.table.trim().replace(/[_-]+/g, ' ').replace(/\b\w/g, letter => letter.toUpperCase());
  return name ? `Search ${name}` : 'Search my list';
}

/** The one button that leads to a step, if exactly one does (#1107). */
export function incomingButton(draft: CustomFlowDefinition, nodeId: string): { menuId: string; index: number; label: string } | null {
  const found = draft.nodes.flatMap(node => node.type === 'menu'
    ? node.options.map((option, index) => ({ menuId: node.id, index, label: option.label, next: option.next })).filter(option => option.next === nodeId) : []);
  return found.length === 1 ? { menuId: found[0].menuId, index: found[0].index, label: found[0].label } : null;
}

/**
 * A step's title as merchants know it (#1107): a list or message step reached
 * by one button is called by that button, so renaming the button renames the
 * step. Guided sections keep their section label. Display only.
 */
export function stepLabel(draft: CustomFlowDefinition, node: CustomFlowNode): string {
  const guided = draft.guided?.sections.some(item => item.node_id === node.id && item.table === (node.type === 'lookup' ? node.table : undefined));
  if (guided || (node.type !== 'lookup' && node.type !== 'message')) return blockLabel(node, draft.guided);
  const label = incomingButton(draft, node.id)?.label.trim();
  if (!label) return blockLabel(node, draft.guided);
  return node.type === 'lookup' ? `Search ${label}` : label;
}

/** One entry of a list, for "+ Add artist" (#1107). */
const NOUNS: Record<string, string> = {
  artists: 'artist', vendors: 'vendor', ticket_types: 'ticket type', 'badge pickup': 'ticket type', news: 'news item', faqs: 'question',
  questions: 'question', program: 'session', schedule: 'session', 'our menu': 'dish', services: 'service',
};
export function entryNoun(table: string): string {
  return NOUNS[table.trim().toLowerCase()] ?? 'entry';
}
