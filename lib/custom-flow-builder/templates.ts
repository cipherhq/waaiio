import type { CustomFlowDefinition } from '@/lib/bot/custom-flow/types';
import type { BusinessField, DataColumn, GuidedMetadata } from '@/lib/bot/custom-flow/data';

const column = (name: string, label: string, required = true): DataColumn => ({ name, label, type: 'text', required });
export const FESTIVAL_TABLES = [
  { name: 'artists', label: 'Artists', prompt: 'Type an artist’s name or day.', columns: [column('name','Name'),column('day','Day'),column('stage','Stage'),column('start_time','Start time')], reply: '{{name}} — {{day}} — {{stage}} — {{start_time}}', search: ['name','day'] },
  { name: 'vendors', label: 'Vendors', prompt: 'Type a vendor name or code.', columns: [column('name','Name'),column('description','Description'),column('external_price_information','External price information'),column('location','Location'),column('hours','Hours')], reply: '{{name}} — {{description}} — {{external_price_information}} — {{location}} — {{hours}}', search: ['name','description'] },
  { name: 'ticket_types', label: 'Ticket Types', prompt: 'Type your ticket type.', columns: [column('type','Type'),column('pickup_location','Pickup location'),column('pickup_hours','Pickup hours'),column('what_to_bring','What to bring')], reply: '{{type}} — {{pickup_location}} — {{pickup_hours}} — {{what_to_bring}}', search: ['type'] },
  { name: 'news', label: 'News', prompt: 'Type a news topic.', columns: [column('title','Title'),column('body','Body'),column('date_time','Date/time')], reply: '{{title}} — {{body}} — {{date_time}}', search: ['title','body'] },
  { name: 'faqs', label: 'FAQs', prompt: 'Type a question or keyword.', columns: [column('question','Question'),column('answer','Answer')], reply: '{{question}}\n{{answer}}', search: ['question'] },
] as const;
export const NO_MATCH = 'No matching information is available. Try another name, code or keyword.';

export function createTemplate(args: { id: string; businessId: string; template: 'festival_info' | 'blank'; name: string; keyword: string; language: string; timezone: string; currency: string; bindings: BusinessField[] }) {
  const tables = args.template === 'festival_info' ? FESTIVAL_TABLES.map(t => ({ name: t.name, columns: t.columns })) : [];
  const guided: GuidedMetadata = { version: 1, template: args.template, template_version: 1, menu_id: 'main_menu', sections: args.template === 'festival_info'
    ? FESTIVAL_TABLES.map(t => ({ id: t.name, node_id: `lookup_${t.name}`, table: t.name, label: t.label, enabled: true })) : [] };
  const definition: CustomFlowDefinition = {
    id: args.id, tenant_id: args.businessId, name: args.name, status: 'draft', entry_keyword: args.keyword || null,
    language: args.language, timezone: args.timezone, currency: args.currency,
    greeting: args.bindings.includes('name') ? 'Welcome to {{business.name}}.' : '', fallback_message: NO_MATCH,
    business_bindings: args.bindings, guided, start_node: 'main_menu', tables: tables.map(t => t.name),
    nodes: [{ id: 'main_menu', type: 'menu', text: 'What would you like information about?', options: guided.sections.map(s => ({ label: s.label, next: s.node_id })) },
      ...(args.template === 'festival_info' ? FESTIVAL_TABLES.map(t => ({ id: `lookup_${t.name}`, type: 'lookup' as const, table: t.name, search_fields: [...t.search], prompt: t.prompt, reply: t.reply, no_match: NO_MATCH, next: 'main_menu' })) : [])],
  };
  return { definition, tables };
}

/** Intentional section toggle, never a regeneration of the merchant's graph. */
export function toggleSection<T extends CustomFlowDefinition>(definition: T, id: string): T {
  const section = definition.guided?.sections.find(s => s.id === id);
  const menu = definition.nodes.find(n => n.id === definition.guided?.menu_id);
  const node = definition.nodes.find(n => n.id === section?.node_id);
  if (!section || menu?.type !== 'menu' || node?.type !== 'lookup' || node.table !== section.table) throw Error('custom_section');
  const incoming = definition.nodes.filter(n => n.id !== menu.id && (n.type === 'menu' ? n.options.some(o => o.next === node.id) : n.type !== 'handoff' && n.next === node.id));
  if (incoming.length || definition.start_node === node.id) throw Error('custom_section');
  const existing = menu.options.filter(o => o.next === node.id);
  if ((section.enabled && (existing.length !== 1 || existing[0].label !== section.label)) || (!section.enabled && existing.length)) throw Error('custom_section');
  if (!section.enabled && menu.options.length >= 10) throw Error('custom_section');
  return { ...definition, guided: { ...definition.guided!, sections: definition.guided!.sections.map(s => s.id === id ? { ...s, enabled: !s.enabled } : s) },
    nodes: definition.nodes.map(n => n.id === menu.id ? { ...menu, options: section.enabled ? menu.options.filter(o => o.next !== node.id) : [...menu.options, { label: section.label, next: node.id }] } : n) };
}
