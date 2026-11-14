import { describe, expect, it } from 'vitest';
import { readDraft } from './definition';
import { validateDefinition } from '@/lib/bot/custom-flow/definition';
import { appendBlock, removeBlock, selectStart, reorderFlow, setMessageDestination, withOrderMetadata, type EditableFlow } from './order';

const message = (id: string, next: string | null) => ({ id, type: 'message' as const, text: id, next });
function flow(nodes: EditableFlow['nodes'], start_node?: string): EditableFlow {
  return { id: 'flow', name: 'Test', status: 'draft', greeting: 'Welcome', fallback_message: 'Try again', nodes, start_node };
}
function path(definition: EditableFlow): string[] {
  const visited: string[] = [];
  let id: string | null = definition.start_node ?? definition.nodes[0]?.id;
  while (id) {
    if (visited.includes(id)) throw new Error('cycle');
    visited.push(id);
    const node = definition.nodes.find(node => node.id === id);
    if (!node || node.type !== 'message') break;
    id = node.next;
  }
  return visited;
}

describe('Owner-approved message sequence reordering', () => {
  it('moves the start and terminal with a sequence and restores it on a round trip', () => {
    const original = flow([message('a', 'b'), message('b', null)]);
    const swapped = reorderFlow(original, ['b', 'a']);
    expect(path(swapped)).toEqual(['b', 'a']);
    expect(path(reorderFlow(swapped, ['a', 'b']))).toEqual(['a', 'b']);
    expect(original.nodes).toEqual([message('a', 'b'), message('b', null)]);
  });

  it.each([['c', 'a', 'b'], ['b', 'a', 'c'], ['b', 'c', 'a']])('visits every member once for %s,%s,%s', (...order) => {
    const original = flow([message('a', 'b'), message('b', 'c'), message('c', null)], 'a');
    expect(path(reorderFlow(original, order))).toEqual(order);
  });

  it('retains a menu exit and its incoming branch targets', () => {
    const menu = { id: 'menu', type: 'menu' as const, text: 'Choose', options: [{ label: 'B', next: 'b' }] };
    const result = reorderFlow(flow([message('a', 'b'), message('b', 'menu'), menu]), ['b', 'a', 'menu']);
    expect(path(result)).toEqual(['b', 'a', 'menu']);
    expect(result.nodes[2]).toEqual(menu);
  });

  it('preserves explicit jump sources and destinations as boundaries', () => {
    const original = flow([message('a', 'b'), message('b', 'jump'), message('jump', 'x'), message('gap', null), message('x', null)]);
    const result = reorderFlow(original, ['b', 'jump', 'gap', 'a', 'x']);
    expect(path(result)).toEqual(['b', 'a', 'jump', 'x']);
    expect(result.nodes.find(node => node.id === 'jump')).toEqual(message('jump', 'x'));
  });

  it('retains chain identity across interleaving, JSON save/reload and repeated moves', () => {
    const menu = { id: 'menu', type: 'menu' as const, text: 'Choose', options: [{ label: 'B', next: 'b' }] };
    const first = reorderFlow(flow([message('a', 'b'), message('b', null), menu]), ['a', 'menu', 'b']);
    const reloaded = JSON.parse(JSON.stringify(first)) as EditableFlow;
    expect(path(reorderFlow(reloaded, ['b', 'menu', 'a']))).toEqual(['b', 'a']);
  });

  it('preserves an explicit start at an inner node and independent sequences', () => {
    const result = reorderFlow(flow([message('a', 'b'), message('b', null), message('c', 'd'), message('d', null)], 'b'), ['c', 'b', 'a', 'd']);
    expect(result.start_node).toBe('b');
    expect(path(result)).toEqual(['b', 'a']);
    expect(result.nodes.find(node => node.id === 'c')).toEqual(message('c', 'd'));
    expect(reorderFlow(result, ['a', 'b', 'c', 'd']).start_node).toBe('b');
  });

  it('preserves a deliberately selected adjacent jump', () => {
    const original = setMessageDestination(flow([message('a', 'b'), message('b', null)]), 'a', 'b');
    const result = reorderFlow(original, ['b', 'a']);
    expect(result.nodes.find(node => node.id === 'a')).toEqual(message('a', 'b'));
    expect(result.start_node).toBe('a');
  });

  it('does not repair a cycle created by preserved explicit links', () => {
    const original = withOrderMetadata(flow([message('a', 'b'), message('b', 'jump'), message('jump', 'a')]));
    const result = reorderFlow(original, ['b', 'a', 'jump']);
    expect(() => path(result)).toThrow('cycle');
    expect(validateDefinition(result).some(error => error.includes('loops back'))).toBe(true);
    expect(result.nodes.find(node => node.id === 'jump')).toEqual(message('jump', 'a'));
  });

  it('rejects missing, duplicated and foreign IDs', () => {
    const original = flow([message('a', 'b'), message('b', null)]);
    for (const order of [['a'], ['a', 'a'], ['a', 'foreign']]) expect(() => reorderFlow(original, order)).toThrow('invalid_order');
  });
});


describe('editing sequences across draft round trips', () => {
  const roundTrip = (value: EditableFlow) => readDraft(JSON.parse(JSON.stringify(value)), 'flow', 'business');
  it('appends to a terminal chain and preserves reordering after reload', () => {
    const edited = roundTrip(appendBlock(flow([message('a', null)]), message('b', null)));
    expect(path(reorderFlow(edited, ['b', 'a']))).toEqual(['b', 'a']);
  });
  it('preserves an explicit start inside a chain across reload and reorder', () => {
    const edited = roundTrip(selectStart(flow([message('a', 'b'), message('b', null)]), 'b'));
    expect(reorderFlow(edited, ['b', 'a']).start_node).toBe('b');
  });
  it('retains dangling incoming edges after removal for intentional repair', () => {
    const edited = roundTrip(removeBlock(flow([message('a', 'b'), message('b', 'c'), message('c', null)]), 'b'));
    const reordered = reorderFlow(edited, ['c', 'a']);
    expect(reordered.nodes.find(node => node.id === 'a')).toMatchObject({ next: 'b' });
    expect(validateDefinition(reordered).length).toBeGreaterThan(0);
  });
  it('keeps a manually chosen adjacent destination explicit after reload', () => {
    const edited = roundTrip(setMessageDestination(flow([message('a', 'b'), message('b', null)]), 'a', 'b'));
    expect(reorderFlow(edited, ['b', 'a']).nodes.find(node => node.id === 'a')).toMatchObject({ next: 'b' });
  });
});
