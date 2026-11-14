import { describe, expect, it } from 'vitest';
import { excessiveMessageChains, readDraft } from './definition';

const draft = (id: string) => ({ name: 'Test', greeting: '', fallback_message: '', nodes: [{ id, type: 'message', text: 'Hello', next: null }] });

describe('builder runtime identifier boundaries', () => {
  it('accepts the database maximum of 80 characters', () => {
    expect(readDraft(draft('a'.repeat(80)), 'flow', 'business').nodes[0].id).toHaveLength(80);
  });
  it('rejects identifiers too long for runtime sessions and logs', () => {
    expect(() => readDraft(draft('a'.repeat(81)), 'flow', 'business')).toThrow('invalid_definition');
  });
  it.each(['start', 'message', 'menu', 'lookup'])('rejects oversized %s references', kind => {
    const value: any = draft('a');
    const target = 'b'.repeat(81);
    if (kind === 'start') value.start_node = target;
    if (kind === 'message') value.nodes[0].next = target;
    if (kind === 'menu') value.nodes = [{ id: 'a', type: 'menu', text: 'Choose', options: [{ label: 'Go', next: target }] }];
    if (kind === 'lookup') value.nodes = [{ id: 'a', type: 'lookup', table: 'items', search_fields: ['name'], reply: 'Found', no_match: 'Missing', next: target }];
    expect(() => readDraft(value, 'flow', 'business')).toThrow('invalid_definition');
  });
});


describe('existing engine message hop limit', () => {
  it.each([
    [9, 'menu', false], [10, 'menu', true],
    [9, 'lookup', false], [10, 'lookup', true],
    [10, 'end', false], [11, 'end', true],
  ] as const)('%s messages followed by %s: excessive=%s', (count, exit, excessive) => {
    const nodes: any[] = Array.from({ length: count }, (_, i) => ({
      id: `m${i}`, type: 'message', text: 'Hello', next: i + 1 < count ? `m${i + 1}` : exit === 'end' ? null : exit,
    }));
    if (exit === 'menu') nodes.push({ id: exit, type: 'menu', text: 'Choose', options: [] });
    if (exit === 'lookup') nodes.push({ id: exit, type: 'lookup', table: 'items', search_fields: ['name'], reply: 'Found', no_match: 'Missing' });
    const definition = readDraft({ ...draft('a'), nodes }, 'flow', 'business');
    expect(excessiveMessageChains(definition).length > 0).toBe(excessive);
  });
});
