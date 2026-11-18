import type { EditableFlow } from './order';
import { stepLabel } from './block-label';

/**
 * Display only (#1079). The server keeps returning the validator's messages
 * from lib/bot/custom-flow/definition.ts unchanged; the builder shows each one
 * in plain English and names the step by its position and visible label, so a
 * merchant never sees step ids or words like "node" or "template".
 */
export const FRIENDLY_FALLBACK = 'Something in this flow needs fixing. Check each step’s settings, then try again.';

// Words and characters that mean a message was written for engineers.
const CODE_WORDS = /["{}<>_\\]|\b(nodes?|lookups?|templates?|tables?|definitions?|ids?|keywords?|fallback|object|json|null|undefined|uuid|schema)\b/i;
const LONG_HEX = /[0-9a-f]{8,}/i;

type Rule = [RegExp, (step: (id: string) => string, match: RegExpMatchArray) => string];

const SETTINGS_WORD = 'The word people send to start';
const RULES: Rule[] = [
  [/^The flow needs a name\.$/, () => 'Add a Flow name in Settings.'],
  [/^The flow needs a greeting message\.$/, () => 'Add a Greeting in Settings.'],
  [/^The flow needs a fallback message/, () => 'Add a “When we don’t understand” message in Settings.'],
  [/^The entry keyword must be a word, or left empty\.$/, () => `${SETTINGS_WORD} must be a word, or left empty. Change it in Settings.`],
  [/^The entry keyword must be uppercase/, () => `${SETTINGS_WORD} must be in capital letters, like RETREAT. Change it in Settings.`],
  [/^The entry keyword must be a single word/, () => `${SETTINGS_WORD} must be one word with no spaces. Change it in Settings.`],
  [/^The entry keyword "(.*)" is reserved/, (_, m) => `“${m[1]}” is already used by Waaiio. Choose a different word people send to start, in Settings.`],
  [/^The flow needs at least one node\.$/, () => 'Add at least one step to your flow.'],
  [/^Every node needs an id\.$|^Two nodes share the id /, () => 'One of your steps can’t be read. Remove it and add it again.'],
  [/^The start node "(.*)" does not exist\.$/, () => 'Choose a First step in Settings.'],
  [/^Message node "(.*)" has no text\.$/, (step, m) => `${step(m[1])} has no text yet.`],
  [/^Message node "(.*)" loops back to "(.*)"\./, (step, m) => `${step(m[1])} leads back to ${lower(step(m[2]))} without waiting for a reply. Point one of these messages somewhere new.`],
  [/^Menu node "(.*)" has no prompt text\.$/, (step, m) => `${step(m[1])} needs a message above the buttons.`],
  [/^Menu node "(.*)" has no options\./, (step, m) => `${step(m[1])} has no buttons yet. Add at least one button.`],
  [/^Menu node "(.*)" has more than 10 options\./, (step, m) => `${step(m[1])} has more than 10 buttons. Remove some, or add another Show buttons step.`],
  [/^Menu node "(.*)" has an option with no label\.$/, (step, m) => `A button in ${lower(step(m[1]))} has no text yet.`],
  [/^Menu option "(.*)" in node "(.*)" leads nowhere\./, (step, m) => `The “${m[1]}” button in ${lower(step(m[2]))} doesn’t go anywhere yet. Choose where it goes.`],
  [/^Node "(.*)" points to "(.*)" for its next step, but no node has that id\.$/, (step, m) => `${step(m[1])} goes to a step that no longer exists. Choose where it goes next.`],
  [/^Node "(.*)" points to "(.*)" for option "(.*)", but no node has that id\.$/, (step, m) => `The “${m[3]}” button in ${lower(step(m[1]))} goes to a step that no longer exists. Choose where it goes.`],
  [/^Lookup node "(.*)" has no table\./, (step, m) => `${step(m[1])} needs a list. Choose one in Which list.`],
  [/^Lookup node "(.*)" has no search fields\./, (step, m) => `${step(m[1])} needs at least one column in Search by.`],
  [/^Lookup node "(.*)" has no reply template\.$/, (step, m) => `${step(m[1])} needs a Reply.`],
  [/^Lookup node "(.*)" has no message for when nothing matches\.$/, (step, m) => `${step(m[1])} needs a “When nothing matches” message.`],
  [/^Handoff node "(.*)" has no feature\./, (step, m) => `${step(m[1])} needs a feature. Choose one in Which feature.`],
  [/^Handoff node "(.*)" opens a chat, which cannot start with a record\.$/, (step, m) => `${step(m[1])} opens a chat, so it can’t start with an event or option. Remove it and add it again.`],
  [/^Handoff node "(.*)" has a record that cannot be read\./, (step, m) => `${step(m[1])} uses an event or option that can’t be found. Choose it again.`],
  [/^Question node "(.*)" has an id with characters that can't be stored\.$/, (step, m) => `${step(m[1])} can’t be read. Remove it and add it again.`],
  [/^Question node "(.*)" has no answer type\./, (step, m) => `${step(m[1])} can’t be read. Remove it and add it again.`],
  [/^Question node "(.*)" has no question\.$/, (step, m) => `${step(m[1])} needs a question.`],
  [/^Question node "(.*)" has a question longer than 1000 characters\.$/, (step, m) => `${step(m[1])} has a question that is too long. Keep it under 1000 characters.`],
  [/^Question node "(.*)" needs 2 to 10 choices\.$/, (step, m) => `${step(m[1])} needs 2 to 10 choices.`],
  [/^Question node "(.*)" has a choice that is empty or longer than 24 characters\.$/, (step, m) => `${step(m[1])} has a choice that is empty or longer than 24 letters.`],
  [/^Question node "(.*)" has a button choice longer than 20 characters\.$/, (step, m) => `${step(m[1])} has a choice longer than 20 letters. With 3 choices or fewer they show as buttons, which hold 20 letters.`],
  [/^Question node "(.*)" has two choices with the same words\.$/, (step, m) => `${step(m[1])} has two choices with the same words. Make each one different.`],
  [/^Question node "(.*)" has choices, but only/, (step, m) => `${step(m[1])} can’t be read. Remove it and add it again.`],
  [/^Question node "(.*)" has an unreadable date setting\.$/, (step, m) => `${step(m[1])} can’t be read. Remove it and add it again.`],
  [/^Question node "(.*)" has a retry message longer than 500 characters\.$/, (step, m) => `${step(m[1])} has an “If the answer can’t be used” message that is too long. Keep it under 500 characters.`],
  [/^Node "(.*)" has an unknown type/, (step, m) => `${step(m[1])} is a kind of step this page can’t edit. Remove it and add it again.`],
];

// "One of your steps" reads naturally mid-sentence as "one of your steps".
function lower(text: string) { return text.startsWith('One ') ? `o${text.slice(1)}` : text; }

/** "Step 3 (Send a message)", or "One of your steps" when the id is not in the draft. */
export function stepName(draft: EditableFlow | null, id: string): string {
  const index = draft?.nodes.findIndex(node => node.id === id) ?? -1;
  if (!draft || index < 0) return 'One of your steps';
  return `Step ${index + 1} (${stepLabel(draft, draft.nodes[index])})`;
}

export function friendlyError(message: unknown, draft: EditableFlow | null): string {
  if (typeof message !== 'string') return FRIENDLY_FALLBACK;
  const text = message.trim();
  const step = (id: string) => stepName(draft, id);
  for (const [pattern, write] of RULES) {
    const match = text.match(pattern);
    if (match) return write(step, match);
  }
  // Unknown messages are shown only when they are already plain English.
  return !text || CODE_WORDS.test(text) || LONG_HEX.test(text) ? FRIENDLY_FALLBACK : text;
}

/** Plain-English messages for a server error list, without repeats. */
export function friendlyErrors(messages: unknown, draft: EditableFlow | null): string[] {
  if (!Array.isArray(messages)) return [];
  return [...new Set(messages.map(message => friendlyError(message, draft)))];
}
