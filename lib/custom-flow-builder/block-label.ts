import type { CustomFlowNode } from '@/lib/bot/custom-flow/types';
import type { GuidedMetadata } from '@/lib/bot/custom-flow/data';

/** Editor display only; graph identities and destinations remain node IDs. */
export function blockLabel(node: CustomFlowNode, guided?: GuidedMetadata): string {
  if (node.type !== 'lookup') return node.type === 'message' ? 'Message' : 'Menu prompt';
  const section = guided?.sections.find(item => item.node_id === node.id && item.table === node.table);
  const name = section?.label.trim() || node.table.trim().replace(/[_-]+/g, ' ').replace(/\b\w/g, letter => letter.toUpperCase());
  return name ? `${name} — Lookup` : 'Lookup prompt';
}
