import type { CustomFlowNode } from '@/lib/bot/custom-flow/types';
import type { DataColumn } from '@/lib/bot/custom-flow/data';
import type { EditableFlow } from './order';
import { STARTERS, applyStarter, isStarter, type StarterList } from './starters';
import { toggleSection } from './templates';

/**
 * Start screen (#1107): "What should people be able to do?". Each tick is a
 * button on the first menu and the step it opens. A list tick also makes an
 * empty list. Nothing here is a new template or a new request: the flow is
 * created by the existing setup, lists by the existing data `create_table`
 * action and steps by the existing `save` action. A template's own ticks,
 * left as they are, give exactly the flow that template gives today.
 */
export type SetupTemplate = 'festival_info' | 'blank' | keyof typeof STARTERS;
export type AbilityKind = 'list' | 'info' | 'tickets';

export interface Ability {
  key: string;
  /** The tick's words on the start screen. */
  tick: string;
  /** One short line under the tick. */
  hint: string;
  kind: AbilityKind;
  /** The button people tap. */
  button: string;
  list?: StarterList;
  /** A festival section this tick keeps (festival template only). */
  section?: string;
  /** Part of the template as it is today. */
  builtIn?: boolean;
}

const column = (name: string, label: string): DataColumn => ({ name, label, type: 'text', required: true });
const NO_MATCH = 'Nothing matches that yet. Try another word.';
const list = (key: string, name: string, prompt: string, columns: DataColumn[], reply: string, search: string[]): StarterList =>
  ({ key, name, label: name, prompt, columns, reply, search });

/** The ticks every flow can choose from, in the order they are shown. */
export const PRESETS: Ability[] = [
  { key: 'schedule', tick: 'See the schedule', hint: 'A list of what’s on, by day and time', kind: 'list', button: 'Schedule',
    list: list('schedule', 'Schedule', 'Type a day or what’s on.', [column('what', 'What’s on'), column('day', 'Day'), column('time', 'Time'), column('place', 'Where')], '{{what}} — {{day}} {{time}} — {{place}}', ['what', 'day']) },
  { key: 'artists', tick: 'Find an artist', hint: 'A list of artists with their day, time and stage', kind: 'list', button: 'Artists',
    list: list('artists', 'Artists', 'Type an artist’s name or day.', [column('name', 'Name'), column('day', 'Day'), column('time', 'Time'), column('stage', 'Stage'), column('about', 'About')], '{{name}} — {{day}} {{time}} — {{stage}}\n{{about}}', ['name', 'day']) },
  { key: 'vendors', tick: 'Find a vendor', hint: 'A list of vendors, their booth and what they sell', kind: 'list', button: 'Vendors',
    list: list('vendors', 'Vendors', 'Type a vendor’s name or what you want to buy.', [column('name', 'Name'), column('booth', 'Booth'), column('sells', 'What they sell'), column('details', 'Details')], '{{name}} — {{booth}}\n{{sells}}\n{{details}}', ['name', 'sells']) },
  { key: 'badge_pickup', tick: 'Badge pickup', hint: 'Where and when to collect, by ticket type', kind: 'list', button: 'Badge pickup',
    list: list('badge_pickup', 'Badge pickup', 'Type your ticket type.', [column('ticket_type', 'Ticket type'), column('where', 'Where to pick up'), column('when', 'When'), column('bring', 'What to bring')], '{{ticket_type}}: {{where}}, {{when}}. Bring {{bring}}.', ['ticket_type']) },
  { key: 'faqs', tick: 'FAQs', hint: 'Questions people often ask, with your answers', kind: 'list', button: 'FAQs',
    list: list('faqs', 'FAQs', 'Type your question or a keyword.', [column('question', 'Question'), column('answer', 'Answer')], '{{question}}\n{{answer}}', ['question']) },
  { key: 'getting_here', tick: 'Getting here', hint: 'One message: address, parking, directions', kind: 'info', button: 'Getting here' },
  { key: 'tickets', tick: 'Buy tickets', hint: 'Opens your event tickets, with payment', kind: 'tickets', button: 'Buy tickets' },
];

/** Festival sections, as ticks. Stored section ids and labels are unchanged. */
const FESTIVAL_TICKS: Record<string, { key: string; tick: string; hint: string }> = {
  artists: { key: 'artists', tick: 'Find an artist', hint: 'Artists with their day, stage and start time' },
  vendors: { key: 'vendors', tick: 'Find a vendor', hint: 'Vendors, what they sell, where and when' },
  ticket_types: { key: 'badge_pickup', tick: 'Badge pickup', hint: 'Where to pick up, by ticket type' },
  news: { key: 'news', tick: 'News', hint: 'Updates people can search' },
  faqs: { key: 'faqs', tick: 'FAQs', hint: 'Questions people often ask, with your answers' },
};
const FESTIVAL_SECTIONS = ['artists', 'vendors', 'ticket_types', 'news', 'faqs'] as const;
const FESTIVAL_LABELS: Record<string, string> = { artists: 'Artists', vendors: 'Vendors', ticket_types: 'Ticket Types', news: 'News', faqs: 'FAQs' };

/** A starter list stands in for the preset with the same meaning. */
const STARTER_TICKS: Record<string, { key: string; tick: string; hint: string }> = {
  program: { key: 'schedule', tick: 'See the schedule', hint: 'Your program: session, day, time and place' },
  menu_items: { key: 'menu', tick: 'See the menu', hint: 'Your dishes with a description and price' },
  services: { key: 'services', tick: 'See services and prices', hint: 'Your services, how long they take and the price' },
  faqs: { key: 'faqs', tick: 'FAQs', hint: 'Questions people often ask, with your answers' },
};

/** The ticks a template offers: its own first (ticked), then the other presets. */
export function abilitiesFor(template: SetupTemplate): Ability[] {
  let own: Ability[] = [];
  if (template === 'festival_info') {
    own = FESTIVAL_SECTIONS.map(id => ({ ...FESTIVAL_TICKS[id], kind: 'list' as const, button: FESTIVAL_LABELS[id], section: id, builtIn: true }));
  } else if (isStarter(template)) {
    own = STARTERS[template].lists.map(item => ({ ...STARTER_TICKS[item.key], kind: 'list' as const, button: item.label, list: item, builtIn: true }));
  }
  return [...own, ...PRESETS.filter(preset => !own.some(item => item.key === preset.key))];
}

export const defaultTicks = (template: SetupTemplate) => abilitiesFor(template).filter(item => item.builtIn).map(item => item.key);

/** A tick the merchant made up: a message or a list, with the button name they typed. */
export function customAbility(key: string, name: string, kind: 'info' | 'list'): Ability {
  const label = name.trim();
  return { key, tick: label, hint: kind === 'list' ? 'A list people search' : 'One message', kind, button: label,
    ...(kind === 'list' ? { list: list(key, label, 'Type a name.', [column('name', 'Name'), column('details', 'Details')], '{{name}}\n{{details}}', ['name']) } : {}) };
}

/** WhatsApp and the builder allow up to 10 buttons on one menu. */
export const MAX_BUTTONS = 10;

export interface FlowPlan {
  /** The ticks are the template's own: the existing setup gives the flow. */
  unchanged: boolean;
  /** Lists to create with the existing `create_table` action, in order. */
  lists: StarterList[];
  /** Steps and buttons, built on the flow the setup returned. */
  build: (base: EditableFlow) => EditableFlow;
}

export function planFlow(template: SetupTemplate, chosen: Ability[]): FlowPlan {
  const defaults = defaultTicks(template);
  const keys = chosen.map(item => item.key);
  const unchanged = keys.length === defaults.length && keys.every((key, index) => key === defaults[index]);
  // New lists get a name no other list in this flow has.
  const taken = new Set<string>(template === 'festival_info' ? FESTIVAL_SECTIONS : []);
  const lists: StarterList[] = [];
  const named = new Map<string, StarterList>();
  for (const item of chosen) {
    if (!item.list || item.section) continue;
    let name = item.list.name.slice(0, 80);
    for (let n = 2; taken.has(name); n++) name = `${item.list.name.slice(0, 76)} ${n}`;
    taken.add(name);
    const made = { ...item.list, name };
    lists.push(made);
    named.set(item.key, made);
  }

  function step(item: Ability, menuId: string): CustomFlowNode {
    const made = named.get(item.key);
    if (made) return { id: `lookup_${made.key}`, type: 'lookup', table: made.name, search_fields: [...made.search], prompt: made.prompt, reply: made.reply, no_match: NO_MATCH, next: menuId };
    if (item.kind === 'tickets') return { id: `tickets_${item.key}`, type: 'handoff', capability: 'ticketing' };
    return { id: `info_${item.key}`, type: 'message', text: '', next: menuId };
  }

  function build(base: EditableFlow): EditableFlow {
    if (unchanged && template !== 'festival_info' && isStarter(template)) return applyStarter(base, template);
    const { editor_order: _ignored, ...rest } = base;
    let flow: EditableFlow = rest;
    const menuId = flow.guided?.menu_id ?? 'main_menu';
    if (template === 'festival_info') {
      // Unticked sections are turned off the existing way, so they can be turned on again later.
      for (const section of FESTIVAL_SECTIONS) if (!chosen.some(item => item.section === section)) flow = toggleSection(flow, section);
    }
    const extras = chosen.filter(item => !item.section);
    const nodes = extras.map(item => step(item, menuId));
    const options = extras.map((item, index) => ({ label: item.button, next: nodes[index].id }));
    if (template === 'festival_info') {
      return { ...flow, tables: [...new Set([...(flow.tables ?? []), ...lists.map(item => item.name)])],
        nodes: [...flow.nodes.map(node => node.id === menuId && node.type === 'menu' ? { ...node, options: [...node.options, ...options] } : node), ...nodes] };
    }
    const menuText = isStarter(template) ? STARTERS[template].menuText : 'What would you like to know?';
    return { ...flow, start_node: menuId, tables: lists.map(item => item.name),
      nodes: [{ id: menuId, type: 'menu', text: menuText, options }, ...nodes] };
  }
  return { unchanged, lists, build };
}
