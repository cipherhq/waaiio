import type { CustomFlowNode } from '@/lib/bot/custom-flow/types';
import { businessValue, completeRow, hasValue, variablesIn, type BusinessField, type DataColumn } from '@/lib/bot/custom-flow/data';
import { YES_NO_LABELS } from '@/lib/bot/custom-flow/answers';
import { upcomingDateOptions } from '@/lib/bot/custom-flow/dates';
import { handoffPreviewNote } from '@/lib/bot/custom-flow/handoff-copy';
import type { EditableFlow } from './order';
import type { PreviewMessage } from './preview';

/**
 * Live phone preview for the builder (#1079 polish). Pure and client-side:
 * no request, no session, no engine instance. It mirrors the engine's
 * rendering rules (lib/bot/custom-flow/engine.ts) using the same shared,
 * client-safe helpers: greeting first (skipped when the start menu's text
 * is the greeting), message chains up to 10 hops, buttons for up to 3
 * choices (20 letters) and a list for more (24 letters), the date list from
 * upcomingDateOptions, and the handoff note. "Try it" stays the interactive,
 * server-run test chat; this only shows what the flow sends first.
 */
export interface LiveMessage extends PreviewMessage {
  /** Set when WhatsApp shows the options as a list behind this button. */
  listButton?: string;
  /** Some option was longer than WhatsApp allows: the letter limit it was cut to, as the bot does. */
  shortenedTo?: number;
}
export interface LivePreview { label: string; messages: LiveMessage[] }

/** Same as the engine's MAX_MESSAGE_HOPS. */
const MAX_MESSAGE_HOPS = 10;
const BUTTON_MAX = 20;
const LIST_ROW_MAX = 24;

/**
 * Same token rule as the engine's substitute(); engine.ts itself imports
 * server-only modules, so it cannot be bundled into the dashboard. Values
 * only known in a real chat (a found row, an answer) show as "[name]" so the
 * merchant can see where they go, instead of the blank the engine would send
 * with no value.
 */
function substitute(template: string, vars: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g, (_match, key: string) => {
    const value = vars[key];
    return value === undefined || value === null ? `[${key}]` : String(value);
  });
}

/** Only a finished picture link is shown, so typing one doesn't fetch every partial address. */
export function completeImageUrl(url: string | null | undefined): string | null {
  const value = url?.trim() ?? '';
  return /^https:\/\/[^\s/]+\.[^\s/]+\/\S+\.(jpe?g|png|webp|gif)(\?\S*)?$/i.test(value) ? value : null;
}

function choices(labels: string[]): Pick<LiveMessage, 'options' | 'listButton' | 'shortenedTo'> {
  const asList = labels.length > 3;
  const max = asList ? LIST_ROW_MAX : BUTTON_MAX;
  return {
    options: labels.map((label, index) => ({ label: label.slice(0, max), value: String(index) })),
    ...(asList ? { listButton: 'Choose' } : {}),
    ...(labels.some(label => label.length > max) ? { shortenedTo: max } : {}),
  };
}

/** A list's saved entries, as the builder loaded them (#1107). */
export interface PreviewList { columns: DataColumn[]; rows: Array<{ row_code: string; data: Record<string, unknown>; hidden: boolean }> }

/** Same as the engine's MIN_LOOKUP_QUERY_LENGTH and BROWSE_LIMIT. */
const MIN_QUERY = 2;
const BROWSE_LIMIT = 30;

/** The engine's findRows: exact code, then whole words, then part of a word. */
export function matchRows<R extends { row_code: string; data: Record<string, unknown> }>(rows: R[], fields: string[], query: string): R[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const byCode = rows.find(row => row.row_code.toLowerCase() === q);
  if (byCode) return [byCode];
  if (q.length < MIN_QUERY) return [];
  const value = (row: R, field: string) => row.data[field] === undefined || row.data[field] === null ? null : String(row.data[field]).toLowerCase();
  const whole = rows.filter(row => fields.some(field => value(row, field)?.split(/[^a-z0-9]+/).includes(q)));
  return whole.length ? whole : rows.filter(row => fields.some(field => value(row, field)?.includes(q)));
}

export function livePreview(draft: EditableFlow, options: {
  /** The step being edited; its message is shown instead of the opening. */
  focusId?: string | null;
  business?: Partial<Record<BusinessField, unknown>>;
  country?: string | null;
  /** Saved entries by list name, so a list step shows real answers (#1107). */
  lists?: Record<string, PreviewList>;
  /** An entry being typed in the focused list step: shown as if someone searched for it. */
  draftEntry?: Record<string, unknown> | null;
  /** A word the merchant typed in the phone to test the focused list step. */
  query?: string;
}): LivePreview {
  const business = options.business ?? {};
  const vars: Record<string, unknown> = {};
  for (const field of draft.business_bindings ?? []) vars[`business.${field}`] = businessValue(field, business[field]);
  // Engine renderText: a missing bound business detail sends the fallback message instead.
  const render = (text: string) => draft.business_bindings
    && variablesIn(text).some(key => key.startsWith('business.') && !hasValue(vars[key]))
    ? substitute(draft.fallback_message ?? '', vars)
    : substitute(text ?? '', vars);
  const dateContext = { timezone: draft.timezone || 'UTC', language: draft.language || 'en', country: options.country || 'GB' };

  function renderNode(node: CustomFlowNode): LiveMessage[] {
    switch (node.type) {
      case 'message':
      {
        const image = completeImageUrl(node.image);
        return [{ text: render(node.text), ...(image ? { image } : {}) }];
      }
      case 'menu':
        return [{ text: render(node.text), ...choices(node.options.map(option => option.label)) }];
      case 'lookup': {
        const rows = visibleRows(node);
        if ((node.mode === 'browse' || node.mode === 'both') && rows.length) {
          const prompt = node.prompt ? render(node.prompt) : '';
          const shown = rows.slice(0, BROWSE_LIMIT);
          const list = shown.map((row, index) => `${index + 1}. ${browseLabel(row, node.search_fields)}`).join('\n');
          const more = rows.length > shown.length ? `\n…and ${rows.length - shown.length} more.` : '';
          return [{ text: `${prompt ? `${prompt}\n\n` : ''}${list}${more}` }];
        }
        // The engine stays silent without a prompt and waits for a search word.
        return node.prompt ? [{ text: render(node.prompt) }] : [{ text: 'Waits for people to type a word to search.', note: true }];
      }
      case 'handoff':
        return [{ text: handoffPreviewNote({ capability: node.capability, recordName: null }), note: true }];
      case 'ask': {
        const body = render(node.question);
        if (node.answer_type === 'yes_no') return [{ text: body, ...choices([...YES_NO_LABELS]) }];
        if (node.answer_type === 'choice') return [{ text: body, ...choices(node.options ?? []) }];
        if (node.answer_type === 'date') return [{ text: body, listButton: 'Choose a date',
          options: upcomingDateOptions(dateContext).map(row => ({ label: row.title, value: row.id })) }];
        return [{ text: body }];
      }
      default:
        return [];
    }
  }

  /** A node and, for messages, the chain that follows it until a step that waits. */
  function renderChain(first: CustomFlowNode): LiveMessage[] {
    const messages: LiveMessage[] = [];
    let node: CustomFlowNode | undefined = first;
    for (let hops = 0; node && hops < MAX_MESSAGE_HOPS; hops++) {
      messages.push(...renderNode(node));
      if (node.type !== 'message' || !node.next) break;
      const nextId: string = node.next;
      node = draft.nodes.find(item => item.id === nextId);
    }
    return messages;
  }

  /** Rows people would get: shown, and with every detail the reply needs (engine loadAnswerRows). */
  function visibleRows(node: Extract<CustomFlowNode, { type: 'lookup' }>) {
    const list = options.lists?.[node.table];
    if (!list) return [];
    return list.rows.filter(row => !row.hidden && (!!row.data._source || completeRow(row.data, list.columns, node.reply, vars)));
  }
  function browseLabel(row: { row_code: string; data: Record<string, unknown> }, fields: string[]) {
    const first = fields.map(field => row.data[field]).find(value => value !== undefined && value !== null && String(value).trim() !== '');
    return first === undefined ? row.row_code : String(first);
  }
  /** What a search for `query` answers, worked out like the engine does. */
  function answer(node: Extract<CustomFlowNode, { type: 'lookup' }>, query: string): LiveMessage[] {
    const rows = visibleRows(node);
    const browsing = node.mode === 'browse' || node.mode === 'both';
    const number = Number(query.trim());
    if (browsing && Number.isInteger(number) && number >= 1 && number <= Math.min(rows.length, BROWSE_LIMIT)) {
      return [{ text: substitute(node.reply, { ...vars, ...rows[number - 1].data }) }];
    }
    const matches = node.mode === 'browse' ? [] : matchRows(rows, node.search_fields, query);
    if (!matches.length) return [{ text: substitute(node.no_match, { ...vars, query: query.trim() }) }];
    if (matches.length === 1) return [{ text: substitute(node.reply, { ...vars, ...matches[0].data }) }];
    const list = matches.map((row, index) => {
      const first = node.search_fields.map(field => row.data[field]).find(value => value !== undefined && value !== null && String(value).trim() !== '');
      return `${index + 1}. ${first === undefined ? row.row_code : `${row.row_code} — ${String(first)}`}`;
    }).join('\n');
    return [{ text: `I found a few matches:\n${list}\nReply with the number or code.` }];
  }

  const startId = draft.start_node ?? draft.nodes[0]?.id;
  const focusIndex = options.focusId ? draft.nodes.findIndex(node => node.id === options.focusId) : -1;
  const focused = focusIndex >= 0 ? draft.nodes[focusIndex] : null;
  if (focused?.type === 'lookup' && (options.query?.trim() || options.draftEntry)) {
    // A list step being filled or tested: its opening message, what someone types, and the reply.
    const messages = renderChain(focused);
    if (options.query?.trim()) messages.push({ text: options.query.trim(), input: true }, ...answer(focused, options.query));
    else if (options.draftEntry) {
      const typed = focused.search_fields.map(field => options.draftEntry![field]).find(value => hasValue(value));
      messages.push({ text: typed === undefined ? '…' : String(typed), input: true }, { text: substitute(focused.reply, { ...vars, ...options.draftEntry }) });
    }
    return { label: `Preview: step ${focusIndex + 1}`, messages };
  }
  if (focusIndex >= 0 && draft.nodes[focusIndex].id !== startId) {
    // Like the engine, a message carries on through the messages after it (up to 10).
    return { label: `Preview: step ${focusIndex + 1}`, messages: renderChain(draft.nodes[focusIndex]) };
  }
  const start = draft.nodes.find(node => node.id === startId);
  const label = focusIndex >= 0 ? `Preview: step ${focusIndex + 1}` : 'Preview: start';
  const greeting = render(draft.greeting ?? '');
  const messages: LiveMessage[] = [];
  if (!(start?.type === 'menu' && render(start.text) === greeting) && greeting.trim()) messages.push({ text: greeting });
  if (start) messages.push(...renderChain(start));
  return { label, messages };
}
