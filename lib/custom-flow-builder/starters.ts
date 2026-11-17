import type { DataColumn } from '@/lib/bot/custom-flow/data';
import type { EditableFlow } from './order';

/**
 * Client-side starters (#1079). They need no new template type: the flow is
 * created by the existing blank setup, its lists by the existing data
 * `create_table` action, and its steps by the existing `save` action, so every
 * server validation rule and the stored format stay as they are. Lists start
 * empty: merchants add their own content.
 */
export type StarterId = 'church_retreat' | 'restaurant_info' | 'salon_info';

export interface StarterList {
  /** Slug for the step id (`lookup_<key>`); ids stay code-safe. */
  key: string;
  /** Stored list name. Any text up to 80 characters is valid (custom_flow_tables.name), so merchants see it as written. */
  name: string;
  label: string;
  prompt: string;
  columns: DataColumn[];
  reply: string;
  search: string[];
}

const column = (name: string, label: string): DataColumn => ({ name, label, type: 'text', required: true });
const questions: StarterList = {
  key: 'faqs', name: 'Questions', label: 'Questions', prompt: 'Type your question or a keyword.',
  columns: [column('question', 'Question'), column('answer', 'Answer')], reply: '{{question}}\n{{answer}}', search: ['question'],
};

export const STARTERS: Record<StarterId, { name: string; menuText: string; lists: StarterList[] }> = {
  church_retreat: {
    name: 'Church retreat', menuText: 'What would you like to know about the retreat?',
    lists: [{
      key: 'program', name: 'Program', label: 'Program', prompt: 'Type a day or session name.',
      columns: [column('session', 'Session'), column('day', 'Day'), column('time', 'Time'), column('place', 'Place')],
      reply: '{{session}} — {{day}} {{time}} — {{place}}', search: ['session', 'day'],
    }, questions],
  },
  restaurant_info: {
    name: 'Restaurant info', menuText: 'What would you like to know?',
    lists: [{
      key: 'menu_items', name: 'Our menu', label: 'Our menu', prompt: 'Type a dish name.',
      columns: [column('dish', 'Dish'), column('description', 'Description'), column('price_note', 'Price')],
      reply: '{{dish}} — {{description}} — {{price_note}}', search: ['dish', 'description'],
    }, questions],
  },
  salon_info: {
    name: 'Salon info', menuText: 'What would you like to know?',
    lists: [{
      key: 'services', name: 'Services', label: 'Services', prompt: 'Type a service name.',
      columns: [column('service', 'Service'), column('duration', 'How long it takes'), column('price_note', 'Price')],
      reply: '{{service}} — {{duration}} — {{price_note}}', search: ['service'],
    }, questions],
  },
};

export const isStarter = (value: string): value is StarterId => value in STARTERS;

/** Steps for a starter, built on the flow the blank setup returned. */
export function applyStarter(base: EditableFlow, id: StarterId): EditableFlow {
  const starter = STARTERS[id];
  const menuId = base.guided?.menu_id ?? 'main_menu';
  const lookups = starter.lists.map(list => ({
    id: `lookup_${list.key}`, type: 'lookup' as const, table: list.name, search_fields: [...list.search],
    prompt: list.prompt, reply: list.reply, no_match: 'Nothing matches that yet. Try another word.', next: menuId,
  }));
  const { editor_order: _ignored, ...rest } = base;
  return {
    ...rest,
    start_node: menuId,
    tables: starter.lists.map(list => list.name),
    nodes: [{ id: menuId, type: 'menu', text: starter.menuText, options: starter.lists.map(list => ({ label: list.label, next: `lookup_${list.key}` })) }, ...lookups],
  };
}
