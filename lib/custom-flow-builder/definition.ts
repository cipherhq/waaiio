import type { CustomFlowNode } from '@/lib/bot/custom-flow/types';
import { withOrderMetadata, type EditableFlow, type FlowOrderMetadata } from './order';

export function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function text(value: unknown, max = 10000): string {
  if (typeof value !== 'string' || value.length > max) throw new Error('invalid_definition');
  return value;
}
function target(value: unknown): string | null {
  return value === null ? null : text(value, 80);
}

/** Shape checks protect the shared graph validator from malformed API input. */
export function readDraft(value: unknown, id: string, businessId: string): EditableFlow {
  if (!record(value) || !Array.isArray(value.nodes) || value.nodes.length > 500) throw new Error('invalid_definition');
  const nodes: CustomFlowNode[] = value.nodes.map(raw => {
    if (!record(raw)) throw new Error('invalid_definition');
    const nodeId = text(raw.id, 80);
    if (!nodeId) throw new Error('invalid_definition');
    switch (raw.type) {
      case 'message': {
        const image = raw.image == null ? null : text(raw.image, 2048);
        if (image && !/^https?:\/\//i.test(image)) throw new Error('invalid_definition');
        return { id: nodeId, type: 'message', text: text(raw.text), image, next: target(raw.next) };
      }
      case 'menu':
        if (!Array.isArray(raw.options) || raw.options.length > 100) throw new Error('invalid_definition');
        return { id: nodeId, type: 'menu', text: text(raw.text), options: raw.options.map(option => {
          if (!record(option)) throw new Error('invalid_definition');
          return { label: text(option.label), next: text(option.next, 80) };
        }) };
      case 'lookup':
        if (!Array.isArray(raw.search_fields) || raw.search_fields.length > 100) throw new Error('invalid_definition');
        return { id: nodeId, type: 'lookup', table: text(raw.table, 80), search_fields: raw.search_fields.map(field => text(field, 200)),
          prompt: raw.prompt === undefined ? undefined : text(raw.prompt), reply: text(raw.reply), no_match: text(raw.no_match),
          ...(raw.next === undefined ? {} : { next: target(raw.next) }) };
      default: throw new Error('invalid_definition');
    }
  });
  if (new Set(nodes.map(node => node.id)).size !== nodes.length) throw new Error('invalid_definition');
  const definition: EditableFlow = {
    id, tenant_id: businessId, status: 'draft', name: text(value.name, 120), greeting: text(value.greeting, 1000),
    fallback_message: text(value.fallback_message, 1000), entry_keyword: value.entry_keyword == null || value.entry_keyword === '' ? null : text(value.entry_keyword, 40),
    language: text(value.language ?? 'en', 10), timezone: text(value.timezone ?? 'Africa/Lagos', 64), currency: text(value.currency ?? 'NGN', 3),
    ...(value.start_node === undefined ? {} : { start_node: text(value.start_node, 80) }), nodes,
    tables: [...new Set(nodes.flatMap(node => node.type === 'lookup' ? [node.table] : []))],
  };
  if (!definition.name.trim() || definition.currency!.length !== 3) throw new Error('invalid_definition');
  if (value.editor_order !== undefined) {
    const metadata = value.editor_order;
    if (!record(metadata) || metadata.version !== 1 || !Array.isArray(metadata.chains)) throw new Error('invalid_order_metadata');
    const used = new Set<string>();
    let starts = 0;
    const chains: FlowOrderMetadata['chains'] = metadata.chains.map(raw => {
      if (!record(raw) || !Array.isArray(raw.members) || !raw.members.length || typeof raw.followsStart !== 'boolean') throw new Error('invalid_order_metadata');
      const members = raw.members.map(member => text(member, 80));
      const exit = target(raw.exit);
      for (let index = 0; index < members.length; index++) {
        const node = nodes.find(node => node.id === members[index]);
        if (used.has(members[index]) || node?.type !== 'message' || node.next !== (members[index + 1] ?? exit)) throw new Error('invalid_order_metadata');
        used.add(members[index]);
      }
      if (raw.followsStart) {
        starts++;
        if ((definition.start_node ?? nodes[0]?.id) !== members[0] || starts > 1) throw new Error('invalid_order_metadata');
      }
      return { members, exit, followsStart: raw.followsStart };
    });
    definition.editor_order = { version: 1, chains };
  }
  return withOrderMetadata(definition);
}

/** The unchanged engine stops before following the tenth Message's next edge. */
export function excessiveMessageChains(definition: EditableFlow): string[] {
  const nodes = new Map(definition.nodes.map(node => [node.id, node]));
  return definition.nodes.filter(start => {
    let node: CustomFlowNode | undefined = start;
    for (let count = 1; count <= 10 && node?.type === 'message'; count++) {
      if (count === 10) return node.next !== null;
      node = node.next === null ? undefined : nodes.get(node.next);
    }
    return false;
  }).map(node => node.id);
}
