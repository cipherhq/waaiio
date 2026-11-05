/**
 * Which WhatsApp templates can carry a form invitation. Pure, so the dashboard
 * picker and the server apply exactly the same rule.
 */
export interface InviteTemplateShape {
  status: string;
  category: string;
  language: string;
  components: Array<{ type: string; format?: string; text?: string }>;
}

/** Approved en_US utility/marketing template whose body takes exactly {{1}} and {{2}}. */
export function isInviteCompatible(t: InviteTemplateShape): boolean {
  // MessageSender always sends templates as en_US.
  if (t.status !== 'APPROVED' || t.language !== 'en_US') return false;
  if (t.category !== 'MARKETING' && t.category !== 'UTILITY') return false;
  const body = t.components?.find(c => c.type === 'BODY');
  if (!body?.text) return false;
  for (const c of t.components) {
    if (c.type === 'BODY' || c.type === 'FOOTER') continue;
    // A static text header is fine; anything that needs its own parameters is not.
    if (c.type === 'HEADER' && c.format === 'TEXT' && !/\{\{/.test(c.text || '')) continue;
    return false;
  }
  const slots = [...body.text.matchAll(/\{\{(\d+)\}\}/g)].map(m => m[1]);
  return slots.length === 2 && slots[0] === '1' && slots[1] === '2';
}
