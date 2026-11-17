import { describe, expect, it } from 'vitest';
import { FRIENDLY_FALLBACK, friendlyError, friendlyErrors } from './friendly-errors';
import type { EditableFlow } from './order';

const id = '0b6f7c1e-1f2a-4c3d-9e8f-123456789abc';
const draft = { id: 'f', name: 'F', greeting: 'Hi', fallback_message: 'x', nodes: [
  { id: 'menu', type: 'menu', text: '', options: [{ label: 'Day', next: 'gone' }] },
  { id, type: 'message', text: '', next: null },
  { id: 'find', type: 'lookup', table: 'program', search_fields: [], reply: '', no_match: '' },
] } as unknown as EditableFlow;

describe('friendly validation messages (#1079)', () => {
  it('names steps by position and label for every per-step server message', () => {
    expect(friendlyError(`Message node "${id}" has no text.`, draft)).toBe('Step 2 (Send a message) has no text yet.');
    expect(friendlyError('Menu node "menu" has no prompt text.', draft)).toBe('Step 1 (Show buttons) needs a message above the buttons.');
    expect(friendlyError('Node "menu" points to "gone" for option "Day", but no node has that id.', draft)).toBe('The “Day” button in Step 1 (Show buttons) goes to a step that no longer exists. Choose where it goes.');
    expect(friendlyError('Lookup node "find" has no reply template.', draft)).toBe('Step 3 (Search Program) needs a Reply.');
    expect(friendlyError('Lookup node "find" has no search fields. Choose at least one column to search.', draft)).toBe('Step 3 (Search Program) needs at least one column in Search by.');
    expect(friendlyError('Lookup node "missing" has no table. Choose which table it searches.', draft)).toBe('One of your steps needs a list. Choose one in Which list.');
    expect(friendlyError('The flow needs at least one node.', draft)).toBe('Add at least one step to your flow.');
    expect(friendlyError('The flow needs a fallback message for input it does not understand.', draft)).toBe('Add a “When we don’t understand” message in Settings.');
    expect(friendlyError('The entry keyword must be uppercase (for example AFROFEST).', draft)).toMatch(/^The word people send to start/);
  });

  it('falls back to plain English for unknown or code-like messages', () => {
    for (const message of [`Something odd about "${id}".`, 'The flow definition must be an object.', 'Bad {{token}}', 'abcdef0123456789 failed', 42, ''])
      expect(friendlyError(message, draft)).toBe(FRIENDLY_FALLBACK);
    expect(friendlyError('A selected section needs information.', draft)).toBe('A selected section needs information.');
    expect(friendlyErrors(['x_y', 'a_b'], draft)).toEqual([FRIENDLY_FALLBACK]);
  });
});
