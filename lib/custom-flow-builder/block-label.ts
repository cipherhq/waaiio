import type { CustomFlowNode } from '@/lib/bot/custom-flow/types';
import type { GuidedMetadata } from '@/lib/bot/custom-flow/data';
import { HANDOFF_FEATURE_NAME } from '@/lib/bot/custom-flow/handoff-copy';

/**
 * Editor display only, in plain English (#1079); graph identities and
 * destinations remain node IDs and the stored definition is unchanged.
 */
export function blockLabel(node: CustomFlowNode, guided?: GuidedMetadata): string {
  if (node.type === 'handoff') return HANDOFF_FEATURE_NAME[node.capability] ?? 'Use what you already have';
  if (node.type !== 'lookup') return node.type === 'message' ? 'Send a message' : 'Show buttons';
  const section = guided?.sections.find(item => item.node_id === node.id && item.table === node.table);
  const name = section?.label.trim() || node.table.trim().replace(/[_-]+/g, ' ').replace(/\b\w/g, letter => letter.toUpperCase());
  return name ? `Search ${name}` : 'Search my list';
}
