// ─────────────────────────────────────────────────────────────────────
// Waaiio Custom Flow — definition validation (Issue #1013, Phase 1)
// Returns plain-English errors. Used by the builder at publish time and
// by the engine at load time (fail closed: an invalid published definition
// is logged and the flow is treated as unavailable, never guessed at).
// ─────────────────────────────────────────────────────────────────────

import type { CustomFlowDefinition, CustomFlowNode } from './types';

/**
 * Words a flow may not claim as its entry keyword. They already mean
 * something to the platform or to the engine's own navigation, so a flow
 * that claimed one would hijack routing that belongs to the existing bot:
 * greetings and restart words, STOP/START, HELP, YES/NO (opt-in), PAY/BOOK
 * (capability routing), BACK/MENU/CONTINUE (navigation), HUMAN/AGENT
 * (handoff), CANCEL/EXIT/QUIT (leaving a flow), ORDER/BUY/TICKET/TABLE/
 * DONATE/GIVE/RESERVE (booking and payment words), MY/SWITCH/CONNECT
 * (discovery and switching), SAVE/REMOVE (saved cards), UPDATES/DIRECTORY
 * (platform features). Mirrored by a DB CHECK on
 * custom_flows.entry_keyword (migration 541).
 */
export const RESERVED_ENTRY_KEYWORDS: ReadonlySet<string> = new Set([
  'HI', 'HELLO', 'MENU', 'STOP', 'START', 'HELP', 'CANCEL', 'YES', 'NO',
  'PAY', 'BOOK', 'BACK', 'RESTART', 'CONTINUE', 'HUMAN', 'AGENT', 'EXIT', 'QUIT',
  'ORDER', 'BUY', 'TICKET', 'TABLE', 'DONATE', 'GIVE', 'RESERVE', 'MY',
  'SWITCH', 'CONNECT', 'SAVE', 'REMOVE', 'UPDATES', 'DIRECTORY',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validate a parsed flow definition. Returns a list of errors in plain
 * English; an empty list means the definition is usable.
 */
export function validateDefinition(definition: unknown): string[] {
  const errors: string[] = [];
  if (!isRecord(definition)) {
    return ['The flow definition must be an object.'];
  }

  const def = definition as unknown as Partial<CustomFlowDefinition>;

  if (typeof def.name !== 'string' || def.name.trim().length === 0) {
    errors.push('The flow needs a name.');
  }
  if (typeof def.greeting !== 'string' || def.greeting.trim().length === 0) {
    errors.push('The flow needs a greeting message.');
  }
  if (typeof def.fallback_message !== 'string' || def.fallback_message.trim().length === 0) {
    errors.push('The flow needs a fallback message for input it does not understand.');
  }
  if (def.entry_keyword !== undefined && def.entry_keyword !== null) {
    if (typeof def.entry_keyword !== 'string' || def.entry_keyword.trim().length === 0) {
      errors.push('The entry keyword must be a word, or left empty.');
    } else if (def.entry_keyword !== def.entry_keyword.toUpperCase()) {
      errors.push('The entry keyword must be uppercase (for example AFROFEST).');
    } else if (/\s/.test(def.entry_keyword)) {
      // The engine matches the whole message, so a multi-word keyword
      // could never trigger the flow.
      errors.push('The entry keyword must be a single word (no spaces).');
    } else if (RESERVED_ENTRY_KEYWORDS.has(def.entry_keyword)) {
      errors.push(`The entry keyword "${def.entry_keyword}" is reserved for the platform. Choose a different starter word.`);
    }
  }
  if (!Array.isArray(def.nodes) || def.nodes.length === 0) {
    errors.push('The flow needs at least one node.');
    return errors;
  }

  const ids = new Set<string>();
  for (const node of def.nodes as CustomFlowNode[]) {
    if (!isRecord(node) || typeof node.id !== 'string' || node.id.trim().length === 0) {
      errors.push('Every node needs an id.');
      continue;
    }
    if (ids.has(node.id)) {
      errors.push(`Two nodes share the id "${node.id}". Node ids must be unique.`);
    }
    ids.add(node.id);
  }

  const startId = typeof def.start_node === 'string' && def.start_node
    ? def.start_node
    : (def.nodes[0] as CustomFlowNode).id;
  if (!ids.has(startId)) {
    errors.push(`The start node "${startId}" does not exist.`);
  }

  const checkTarget = (nodeId: string, target: unknown, label: string) => {
    if (typeof target !== 'string' || target.trim().length === 0) return;
    if (!ids.has(target)) {
      errors.push(`Node "${nodeId}" points to "${target}" for ${label}, but no node has that id.`);
    }
  };

  for (const node of def.nodes as CustomFlowNode[]) {
    if (!isRecord(node)) continue;
    switch (node.type) {
      case 'message': {
        if (typeof node.text !== 'string' || node.text.trim().length === 0) {
          errors.push(`Message node "${node.id}" has no text.`);
        }
        if (node.next !== null && node.next !== undefined) {
          checkTarget(node.id, node.next, 'its next step');
        }
        break;
      }
      case 'menu': {
        if (typeof node.text !== 'string' || node.text.trim().length === 0) {
          errors.push(`Menu node "${node.id}" has no prompt text.`);
        }
        if (!Array.isArray(node.options) || node.options.length === 0) {
          errors.push(`Menu node "${node.id}" has no options. Add at least one choice.`);
        } else {
          if (node.options.length > 10) {
            errors.push(`Menu node "${node.id}" has more than 10 options. Split it into sub-menus.`);
          }
          for (const option of node.options) {
            if (!isRecord(option) || typeof option.label !== 'string' || option.label.trim().length === 0) {
              errors.push(`Menu node "${node.id}" has an option with no label.`);
              continue;
            }
            if (typeof option.next !== 'string' || option.next.trim().length === 0) {
              errors.push(`Menu option "${option.label}" in node "${node.id}" leads nowhere. Choose where it goes.`);
            } else {
              checkTarget(node.id, option.next, `option "${option.label}"`);
            }
          }
        }
        break;
      }
      case 'lookup': {
        if (typeof node.table !== 'string' || node.table.trim().length === 0) {
          errors.push(`Lookup node "${node.id}" has no table. Choose which table it searches.`);
        }
        if (!Array.isArray(node.search_fields) || node.search_fields.length === 0) {
          errors.push(`Lookup node "${node.id}" has no search fields. Choose at least one column to search.`);
        }
        if (typeof node.reply !== 'string' || node.reply.trim().length === 0) {
          errors.push(`Lookup node "${node.id}" has no reply template.`);
        }
        if (typeof node.no_match !== 'string' || node.no_match.trim().length === 0) {
          errors.push(`Lookup node "${node.id}" has no message for when nothing matches.`);
        }
        if (node.next !== null && node.next !== undefined) {
          checkTarget(node.id, node.next, 'its next step');
        }
        break;
      }
      default: {
        errors.push(`Node "${(node as { id?: string }).id ?? '?'}" has an unknown type "${(node as { type?: string }).type}".`);
        break;
      }
    }
  }

  // Message nodes auto-advance without waiting for the customer, so a
  // message -> message chain that loops would send forever (one WhatsApp
  // send + one session write per hop). Menu and lookup nodes wait for
  // input, so only message-to-message links can loop unboundedly.
  const byId = new Map<string, CustomFlowNode>();
  for (const node of def.nodes as CustomFlowNode[]) {
    if (isRecord(node) && typeof node.id === 'string') byId.set(node.id, node);
  }
  for (const node of def.nodes as CustomFlowNode[]) {
    if (!isRecord(node) || node.type !== 'message') continue;
    if (typeof node.next !== 'string' || !ids.has(node.next)) continue;
    const visited = new Set<string>([node.id]);
    let current = byId.get(node.next);
    while (current && current.type === 'message' && typeof current.next === 'string' && ids.has(current.next)) {
      if (visited.has(current.id)) {
        errors.push(`Message node "${node.id}" loops back to "${current.id}". Message steps must lead somewhere new.`);
        break;
      }
      visited.add(current.id);
      current = byId.get(current.next);
    }
  }

  return errors;
}

/** Parse a stored JSON definition; returns null when it is not an object. */
export function parseDefinition(value: unknown): CustomFlowDefinition | null {
  if (!isRecord(value)) return null;
  return value as unknown as CustomFlowDefinition;
}
