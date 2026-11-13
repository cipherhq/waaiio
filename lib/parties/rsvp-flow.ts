/**
 * #1005 PR 3b: the reusable WhatsApp RSVP form (Owner decisions 2026-11-13).
 *
 * One static Flow is published per WhatsApp Business Account. At send time the party's questions,
 * guest-count choices and dietary box are passed in as Flow data, so editing questions never needs
 * a new Meta publication. The Flow has a fixed number of question slots; slot N holds question N.
 * A party whose questions cannot be shown faithfully gets null here and falls back to the web link.
 */
import { createHash } from 'crypto';
import { stableJson } from '@/lib/whatsapp-forms/publication';
import { validateAnswers, type PartyAnswers, type PartyQuestion } from './rsvp-questions';

/** M489 allows at most 10 questions per party. */
export const PARTY_RSVP_FLOW_SLOTS = 10;
/** WhatsApp Flow choice titles are limited to 30 characters. */
const OPTION_TITLE_MAX = 30;
/** Same limits as M489 / the RSVP page. */
const TEXT_ANSWER_MAX = 500;
const DIETARY_MAX = 500;
const GUEST_OPTIONS_MAX = 20;
const YES_NO = [{ id: 'yes', title: 'Yes' }, { id: 'no', title: 'No' }];
/** Hidden choice components still need a non-empty list. */
const PLACEHOLDER = [{ id: '_', title: '-' }];

type FlowOption = { id: string; title: string };
const slots = Array.from({ length: PARTY_RSVP_FLOW_SLOTS }, (_, i) => i + 1);
const str = (example: string) => ({ type: 'string', __example__: example });
const bool = (example: boolean) => ({ type: 'boolean', __example__: example });
const options = (example: FlowOption[]) => ({
  type: 'array',
  items: { type: 'object', properties: { id: { type: 'string' }, title: { type: 'string' } } },
  __example__: example,
});

/** The static Flow JSON. Identical for every party and every WhatsApp account. */
export function partyRsvpFlowJson(): Record<string, unknown> {
  const data: Record<string, unknown> = {
    intro: str('Please answer a few questions for the party.'),
    guests_visible: bool(true), guest_options: options([{ id: '0', title: 'Just me' }]),
    dietary_visible: bool(true),
  };
  const children: Record<string, unknown>[] = [
    { type: 'TextBody', text: '${data.intro}' },
    { type: 'Dropdown', name: 'guests', label: 'How many are coming?', 'data-source': '${data.guest_options}',
      required: '${data.guests_visible}', visible: '${data.guests_visible}' },
    { type: 'TextArea', name: 'dietary', label: 'Dietary needs', 'max-length': DIETARY_MAX,
      required: false, visible: '${data.dietary_visible}' },
  ];
  const payload: Record<string, string> = { guests: '${form.guests}', dietary: '${form.dietary}' };
  for (const n of slots) {
    Object.assign(data, {
      [`q${n}_visible`]: bool(true), [`q${n}_text`]: str('Which side are you from?'),
      [`q${n}_t_visible`]: bool(false), [`q${n}_t_required`]: bool(false),
      [`q${n}_c_visible`]: bool(true), [`q${n}_c_required`]: bool(true),
      [`q${n}_options`]: options(YES_NO),
    });
    children.push(
      { type: 'TextBody', text: `\${data.q${n}_text}`, visible: `\${data.q${n}_visible}` },
      { type: 'TextInput', name: `q${n}_t`, label: 'Your answer', 'input-type': 'text', 'max-chars': TEXT_ANSWER_MAX,
        required: `\${data.q${n}_t_required}`, visible: `\${data.q${n}_t_visible}` },
      { type: 'RadioButtonsGroup', name: `q${n}_c`, label: 'Choose one', 'data-source': `\${data.q${n}_options}`,
        required: `\${data.q${n}_c_required}`, visible: `\${data.q${n}_c_visible}` },
    );
    payload[`q${n}_t`] = `\${form.q${n}_t}`;
    payload[`q${n}_c`] = `\${form.q${n}_c}`;
  }
  children.push({ type: 'Footer', label: 'Send RSVP', 'on-click-action': { name: 'complete', payload } });
  return {
    version: '7.3',
    routing_model: { RSVP: [] },
    screens: [{ id: 'RSVP', title: 'RSVP', terminal: true, success: true, data,
      layout: { type: 'SingleColumnLayout', children } }],
  };
}

/** Publication revision: changes only when the static Flow changes. */
export function partyRsvpFlowRevision(): string {
  return createHash('sha256').update(stableJson(partyRsvpFlowJson())).digest('hex');
}

export interface PartyRsvpFlowInput {
  partyName: string;
  questions: PartyQuestion[];
  askDietary: boolean;
  /** From maxPlusOnes(); 0 hides the guest-count choice. */
  maxPlusOnes: number;
}

/** Send-time Flow data for one invitation, or null when the form cannot show this party faithfully. */
export function buildPartyRsvpFlowData(input: PartyRsvpFlowInput): Record<string, unknown> | null {
  const { questions } = input;
  if (!Array.isArray(questions) || questions.length === 0 || questions.length > PARTY_RSVP_FLOW_SLOTS) return null;
  const maxPlus = Math.min(Math.max(0, Math.floor(input.maxPlusOnes)), GUEST_OPTIONS_MAX - 1);
  const guestOptions = Array.from({ length: maxPlus + 1 }, (_, n) => ({
    id: String(n), title: n === 0 ? 'Just me' : `Me + ${n} guest${n === 1 ? '' : 's'}`,
  }));
  const data: Record<string, unknown> = {
    intro: `You're coming to ${input.partyName}! Please answer the questions below.`,
    guests_visible: maxPlus > 0, guest_options: maxPlus > 0 ? guestOptions : PLACEHOLDER,
    dietary_visible: input.askDietary === true,
  };
  for (const n of slots) {
    const q = questions[n - 1];
    let choice: FlowOption[] | null = null;
    if (q?.type === 'yes_no') choice = YES_NO;
    if (q?.type === 'single_choice') {
      if (!q.options?.length || q.options.some(o => o.label.trim().length > OPTION_TITLE_MAX)) return null;
      choice = q.options.map(o => ({ id: o.id, title: o.label.trim() }));
    }
    const text = q?.type === 'short_text';
    Object.assign(data, {
      [`q${n}_visible`]: !!q, [`q${n}_text`]: q ? q.label : '',
      [`q${n}_t_visible`]: text, [`q${n}_t_required`]: text && q.required,
      [`q${n}_c_visible`]: !!choice, [`q${n}_c_required`]: !!choice && q!.required,
      [`q${n}_options`]: choice ?? PLACEHOLDER,
    });
  }
  return data;
}

export interface PartyRsvpFlowPayload {
  status: 'accepted';
  plus_ones: number;
  answers: PartyAnswers;
  dietary_notes?: string | null;
}

/**
 * Turn the Flow's response into an M489 payload, using the questions at the revision the token
 * was issued for. Throws a guest-safe message when an answer is missing or invalid.
 */
export function readPartyRsvpFlowResponse(
  response: Record<string, unknown>, questions: PartyQuestion[], askDietary: boolean,
): PartyRsvpFlowPayload {
  const raw: Record<string, unknown> = {};
  questions.forEach((q, i) => {
    const text = response[`q${i + 1}_t`], choice = response[`q${i + 1}_c`];
    if (q.type === 'short_text' && typeof text === 'string' && text.trim()) raw[q.id] = text.trim();
    if (q.type === 'yes_no' && (choice === 'yes' || choice === 'no')) raw[q.id] = choice === 'yes';
    if (q.type === 'single_choice' && typeof choice === 'string' && choice) raw[q.id] = choice;
  });
  const answers = validateAnswers(questions, raw);
  const guests = response.guests;
  let plusOnes = 0;
  if (guests !== undefined && guests !== null && guests !== '') {
    if (typeof guests !== 'string' || !/^\d{1,2}$/.test(guests)) throw new Error('Choose how many are coming.');
    plusOnes = Number(guests);
  }
  const payload: PartyRsvpFlowPayload = { status: 'accepted', plus_ones: plusOnes, answers };
  // Like the RSVP page and the bot, a blank box clears an earlier note when the party asks.
  const dietary = typeof response.dietary === 'string' ? response.dietary.trim() : '';
  if (askDietary) {
    if (dietary.length > DIETARY_MAX) throw new Error('Use at most 500 characters for dietary needs.');
    payload.dietary_notes = dietary || null;
  }
  return payload;
}
