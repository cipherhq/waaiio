import type { CustomFlowDefinition, CustomFlowMessageNode, CustomFlowNode } from '@/lib/bot/custom-flow/types';

/** Authoring-only information; the runtime continues to execute node.next. */
export interface FlowOrderMetadata {
  version: 1;
  chains: Array<{ members: string[]; exit: string | null; followsStart: boolean }>;
}

export type EditableFlow = CustomFlowDefinition & { editor_order?: FlowOrderMetadata };

/** Infer once for legacy definitions; persist the result across save/reload. */
export function withOrderMetadata(definition: EditableFlow): EditableFlow {
  if (definition.editor_order) return definition;
  const chains: FlowOrderMetadata['chains'] = [];
  const nodes = definition.nodes;
  let index = 0;
  while (index < nodes.length) {
    const members: string[] = [];
    let exit: string | null = null;
    while (index < nodes.length) {
      const node = nodes[index];
      const following = nodes[index + 1];
      if (node.type !== 'message') break;
      // Nonadjacent jumps belong to their source block, never to a sequence.
      if (node.next !== null && node.next !== following?.id) break;
      members.push(node.id);
      exit = node.next;
      index++;
      if (node.next === null || following?.type !== 'message') break;
    }
    if (members.length > 0) chains.push({ members, exit, followsStart: (definition.start_node ?? nodes[0]?.id) === members[0] });
    else index++;
  }
  return { ...definition, editor_order: { version: 1, chains } };
}

export function reorderFlow(definition: EditableFlow, order: string[]): EditableFlow {
  const source = withOrderMetadata(definition);
  const byId = new Map(source.nodes.map(node => [node.id, node]));
  if (order.length !== source.nodes.length || new Set(order).size !== order.length || order.some(id => !byId.has(id))) {
    throw new Error('invalid_order');
  }
  const positions = new Map(order.map((id, index) => [id, index]));
  const rewired = new Map<string, CustomFlowMessageNode>();
  let start = source.start_node ?? source.nodes[0]?.id;
  const chains = source.editor_order!.chains.map(chain => {
    const members = [...chain.members].sort((a, b) => positions.get(a)! - positions.get(b)!);
    if (chain.followsStart) start = members[0];
    for (let index = 0; index < members.length; index++) {
      const node = byId.get(members[index]);
      if (node?.type !== 'message') throw new Error('invalid_order_metadata');
      rewired.set(node.id, { ...node, next: members[index + 1] ?? chain.exit });
    }
    return { ...chain, members };
  });
  return {
    ...source,
    start_node: start,
    nodes: order.map(id => rewired.get(id) ?? byId.get(id)!),
    editor_order: { version: 1, chains },
  };
}

/** A merchant-selected destination becomes explicit, even if adjacent. */
export function setMessageDestination(definition: EditableFlow, id: string, next: string | null): EditableFlow {
  const source = withOrderMetadata(definition);
  const chains: FlowOrderMetadata['chains'] = [];
  for (const chain of source.editor_order!.chains) {
    const index = chain.members.indexOf(id);
    if (index < 0) { chains.push(chain); continue; }
    const before = chain.members.slice(0, index);
    const after = chain.members.slice(index + 1);
    if (before.length) chains.push({ members: before, exit: id, followsStart: chain.followsStart });
    if (after.length) chains.push({ members: after, exit: chain.exit, followsStart: false });
  }
  return {
    ...source,
    nodes: source.nodes.map(node => node.id === id && node.type === 'message' ? { ...node, next } : node),
    editor_order: { version: 1, chains },
  };
}

export function appendBlock(definition: EditableFlow, node: CustomFlowNode): EditableFlow {
  const source = withOrderMetadata(definition);
  const previous = source.nodes.at(-1);
  const tail = source.editor_order!.chains.find(chain => chain.members.at(-1) === previous?.id && chain.exit === null);
  const chains = source.editor_order!.chains.map(chain => chain === tail
    ? { ...chain, ...(node.type === 'message' ? { members: [...chain.members, node.id] } : { exit: node.id }) }
    : chain);
  if (!tail && node.type === 'message') chains.push({ members: [node.id], exit: node.next, followsStart: source.nodes.length === 0 });
  return { ...source, nodes: [...source.nodes.map(item => item.id === previous?.id && tail && item.type === 'message' ? { ...item, next: node.id } : item), node],
    editor_order: { version: 1, chains } };
}

export function removeBlock(definition: EditableFlow, id: string): EditableFlow {
  // Keep incoming references so validation requires an intentional replacement.
  const source = setMessageDestination(definition, id, null);
  return { ...source, nodes: source.nodes.filter(node => node.id !== id) };
}

export function selectStart(definition: EditableFlow, id: string): EditableFlow {
  const source = withOrderMetadata(definition);
  return { ...source, start_node: id, editor_order: { version: 1, chains: source.editor_order!.chains.map(chain => ({ ...chain, followsStart: chain.members[0] === id })) } };
}
