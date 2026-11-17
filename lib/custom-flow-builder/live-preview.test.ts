import { describe, expect, it } from 'vitest';
import type { CustomFlowNode } from '@/lib/bot/custom-flow/types';
import { handoffPreviewNote } from '@/lib/bot/custom-flow/handoff-copy';
import { completeImageUrl, livePreview } from './live-preview';
import type { EditableFlow } from './order';

// Unit tests for the builder's live phone preview (#1079 polish). Pure: no
// request, no engine instance. Rules mirror lib/bot/custom-flow/engine.ts.
function flow(nodes: CustomFlowNode[], extra: Partial<EditableFlow> = {}): EditableFlow {
  return { id: 'f', name: 'Flow', status: 'draft', greeting: 'Hi', fallback_message: 'Sorry, try again.', nodes, ...extra } as EditableFlow;
}
const texts = (preview: ReturnType<typeof livePreview>) => preview.messages.map(message => message.text);

describe('livePreview', () => {
  it('shows the greeting, then the first step', () => {
    const preview = livePreview(flow([{ id: 'a', type: 'message', text: 'First', next: null }]), {});
    expect(preview.label).toBe('Preview: start');
    expect(texts(preview)).toEqual(['Hi', 'First']);
  });

  it('skips the greeting when the start menu repeats it, like the engine', () => {
    const preview = livePreview(flow([{ id: 'm', type: 'menu', text: 'Hi', options: [{ label: 'One', next: 'm' }] }]), {});
    expect(texts(preview)).toEqual(['Hi']);
    expect(preview.messages[0].options?.map(option => option.label)).toEqual(['One']);
  });

  it('shows up to 3 choices as buttons (20 letters) and more as a list (24 letters)', () => {
    const long = 'Twenty-five letters long!';
    const buttons = livePreview(flow([{ id: 'm', type: 'menu', text: 'Pick', options: [{ label: long, next: 'm' }, { label: 'B', next: 'm' }] }]), {}).messages[1];
    expect(buttons.listButton).toBeUndefined();
    expect(buttons.options!.map(option => option.label)).toEqual([long.slice(0, 20), 'B']);
    expect(buttons.shortenedTo).toBe(20);
    const list = livePreview(flow([{ id: 'm', type: 'menu', text: 'Pick', options: ['A', 'B', 'C', long].map(label => ({ label, next: 'm' })) }]), {}).messages[1];
    expect(list.listButton).toBe('Choose');
    expect(list.options!.map(option => option.label)).toEqual(['A', 'B', 'C', long.slice(0, 24)]);
    expect(list.shortenedTo).toBe(24);
  });

  it('shows Yes/No buttons, a choice list and the date list for questions', () => {
    const yesNo = livePreview(flow([{ id: 'q', type: 'ask', answer_type: 'yes_no', question: 'Staying?', next: null }]), {}).messages[1];
    expect(yesNo.options!.map(option => option.label)).toEqual(['Yes', 'No']);
    const choice = livePreview(flow([{ id: 'q', type: 'ask', answer_type: 'choice', question: 'Meal?', options: ['A', 'B', 'C', 'D'], next: null }]), {}).messages[1];
    expect(choice.listButton).toBe('Choose');
    const date = livePreview(flow([{ id: 'q', type: 'ask', answer_type: 'date', question: 'Which day?', next: null }], { timezone: 'Africa/Lagos' }), { country: 'NG' }).messages[1];
    expect(date.text).toBe('Which day?');
    expect(date.listButton).toBe('Choose a date');
    expect(date.options).toHaveLength(8);
    expect(date.options!.at(-1)!.label).toBe('Another date');
    const text = livePreview(flow([{ id: 'q', type: 'ask', answer_type: 'text', question: 'Name?', next: null }]), {}).messages[1];
    expect(text).toEqual({ text: 'Name?' });
  });

  it('shows a search prompt, or a note when the search has no prompt', () => {
    const lookup: Extract<CustomFlowNode, { type: 'lookup' }> = { id: 'l', type: 'lookup', table: 'faqs', search_fields: ['q'], reply: '{{answer}}', no_match: 'None' };
    expect(texts(livePreview(flow([{ ...lookup, prompt: 'Type a word.' }]), {}))).toEqual(['Hi', 'Type a word.']);
    const silent = livePreview(flow([lookup]), {}).messages[1];
    expect(silent.note).toBe(true);
    expect(silent.text).toBe('Waits for people to type a word to search.');
  });

  it('shows the handoff note', () => {
    const preview = livePreview(flow([{ id: 'h', type: 'handoff', capability: 'chat' }]), {});
    expect(preview.messages[1]).toEqual({ text: handoffPreviewNote({ capability: 'chat', recordName: null }), note: true });
  });

  it('fills bound business details, and sends the fallback when one is missing', () => {
    const nodes: CustomFlowNode[] = [{ id: 'a', type: 'message', text: 'Visit {{business.address}}', next: null }];
    expect(texts(livePreview(flow(nodes, { business_bindings: ['address'] }), { business: { address: '1 Main St' } }))).toEqual(['Hi', 'Visit 1 Main St']);
    expect(texts(livePreview(flow(nodes, { business_bindings: ['address'] }), { business: {} }))).toEqual(['Hi', 'Sorry, try again.']);
  });

  it('shows answer and row details as readable placeholders instead of blanks', () => {
    const preview = livePreview(flow([{ id: 'a', type: 'message', text: 'Thanks {{name}}!', next: null }]), {});
    expect(texts(preview)).toEqual(['Hi', 'Thanks [name]!']);
  });

  it('follows message chains, stops at a cycle after 10 messages and at a missing next step', () => {
    const loop = livePreview(flow([
      { id: 'a', type: 'message', text: 'A', next: 'b' },
      { id: 'b', type: 'message', text: 'B', next: 'a' },
    ]), {});
    expect(texts(loop)).toHaveLength(1 + 10);
    const missing = livePreview(flow([{ id: 'a', type: 'message', text: 'A', next: 'gone' }]), {});
    expect(texts(missing)).toEqual(['Hi', 'A']);
  });

  it('shows the edited step and the messages after it, without the greeting', () => {
    const nodes: CustomFlowNode[] = [
      { id: 'm', type: 'menu', text: 'Pick', options: [{ label: 'Go', next: 'b' }] },
      { id: 'b', type: 'message', text: 'B', next: 'c' },
      { id: 'c', type: 'message', text: 'C', next: 'm' },
    ];
    const preview = livePreview(flow(nodes), { focusId: 'b' });
    expect(preview.label).toBe('Preview: step 2');
    expect(texts(preview)).toEqual(['B', 'C', 'Pick']);
    // Editing the first step shows the opening, labelled with its number.
    expect(livePreview(flow(nodes), { focusId: 'm' }).label).toBe('Preview: step 1');
  });

  it('shows a picture only once its link looks complete', () => {
    expect(completeImageUrl('https://ex')).toBeNull();
    expect(completeImageUrl('https://example.com/poster')).toBeNull();
    expect(completeImageUrl('http://example.com/poster.jpg')).toBeNull();
    expect(completeImageUrl(' https://example.com/poster.jpg ')).toBe('https://example.com/poster.jpg');
    expect(completeImageUrl('https://cdn.example.com/a/b.PNG?v=2')).toBe('https://cdn.example.com/a/b.PNG?v=2');
    const partial = livePreview(flow([{ id: 'a', type: 'message', text: 'Look', image: 'https://exa', next: null }]), {});
    expect(partial.messages[1].image).toBeUndefined();
  });
});
