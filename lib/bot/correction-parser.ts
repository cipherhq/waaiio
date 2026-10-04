/**
 * Deterministic correction recognition. Recognition never selects a tenant,
 * confirms an irreversible action, or calls an LLM.
 */
import type { CorrectionResult } from './conversation-types';
import type { BotSession } from './bot-types';
import { normalizeInboundCommandText } from './inbound-command-normalization';

const FIELD_TO_SESSION_KEY: Record<string, string> = {
  date: 'date',
  time: 'time',
  quantity: 'party_size',
  service: 'selected_service_id',
};

const RESELECT: Array<{ field: string; targetStep: string; phrases: string[] }> = [
  {
    field: 'date', targetStep: 'select_date', phrases: [
      'change date', 'change the date', 'different date',
      'change date abeg', 'another date abeg',
      'yi ojo pada', 'ojo miiran',
      'gbanwee ubochi', 'ubochi ozo',
      'canza rana', 'wata rana',
      'sesa da', 'da foforo',
      'changer la date', 'autre date',
      'cambiar fecha', 'otra fecha',
    ],
  },
  {
    field: 'time', targetStep: 'select_time', phrases: [
      'change time', 'change the time', 'different time',
      'change time abeg', 'another time abeg',
      'yi akoko pada', 'akoko miiran',
      'gbanwee oge', 'oge ozo',
      'canza lokaci', 'wani lokaci',
      'sesa bere', 'bere foforo',
      'changer l heure', 'autre heure',
      'cambiar hora', 'otra hora',
    ],
  },
  {
    field: 'quantity', targetStep: 'select_party_size', phrases: [
      'change quantity', 'change number', 'different quantity',
      'change quantity abeg', 'change number abeg',
      'yi iye pada',
      'gbanwee onu',
      'canza adadi',
      'sesa dodow',
      'changer la quantite', 'changer le nombre',
      'cambiar cantidad', 'cambiar numero',
    ],
  },
  {
    field: 'service', targetStep: 'select_service', phrases: [
      'change service', 'different service', 'another service', 'not that service', 'wrong service',
      'change service abeg', 'another service abeg',
      'yi ise pada', 'ise miiran',
      'gbanwee oru', 'oru ozo',
      'canza sabis', 'wani sabis',
      'sesa service',
      'changer de service', 'autre service',
      'cambiar servicio', 'otro servicio',
    ],
  },
];

const REPEAT_PHRASES = new Set([
  'same as last time', 'same as before', 'same as previous', 'do it again', 'do the same again', 'repeat', 'reorder',
  'same thing again abeg', 'do am again',
  'tun se', 'mee ya ozo', 'sake yi', 'san ye bio',
  'repeter', 'refaire', 'repetir', 'hacerlo de nuevo',
]);

function quantityTarget(session: BotSession): string {
  const cap = String(session.session_data?.active_capability || '');
  return ['ordering', 'order', 'ticketing', 'ticket', 'retail'].includes(cap)
    ? 'select_quantity'
    : 'select_party_size';
}

export function detectCorrection(text: string, session: BotSession): CorrectionResult | null {
  if (!session.is_active || !session.current_step) return null;
  const normalized = normalizeInboundCommandText(text);
  if (!normalized) return null;

  // Explicit English numeric corrections retain their supplied value. They are
  // still revalidated by the target flow step; this parser never authorizes it.
  let m = normalized.match(/^(?:actually|i meant|change(?: the)? time(?: to)?|make (?:it|the time)(?: to)?)\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)$/);
  if (m) return correction(session, 'time', m[1].trim(), 'select_time');

  m = normalized.match(/^(?:actually|make it|change(?: it)? to|for)\s+(\d+)\s*(?:people|persons?|guests?|pax|items?|tickets?)?$/);
  if (m) return correction(session, 'quantity', parseInt(m[1], 10), quantityTarget(session));

  m = normalized.match(/^(?:actually|change|switch|move)(?: it)?(?: to)?\s+(today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday)$/);
  if (m) return correction(session, 'date', m[1], 'select_date');

  for (const rule of RESELECT) {
    if (rule.phrases.includes(normalized)) {
      return correction(
        session,
        rule.field,
        null,
        rule.field === 'quantity' ? quantityTarget(session) : rule.targetStep,
      );
    }
  }

  if (REPEAT_PHRASES.has(normalized)) {
    return {
      field: 'repeat_last', oldValue: null, newValue: true, confidence: 0.9,
    };
  }
  return null;
}

function correction(
  session: BotSession,
  field: string,
  newValue: unknown,
  targetStep: string,
): CorrectionResult {
  const key = FIELD_TO_SESSION_KEY[field] || field;
  return {
    field,
    oldValue: session.session_data?.[key] ?? null,
    newValue,
    confidence: 0.9,
    targetStep,
  };
}

/**
 * Apply only data changes/invalidation. The existing BotService CAS +
 * FlowExecutor own persistence and execution. Downstream values are cleared so
 * no stale availability, price, stock or confirmation can survive a correction.
 */
export function applyCorrection(
  sessionData: Record<string, unknown>,
  correctionResult: CorrectionResult,
): Record<string, unknown> {
  const updated = { ...sessionData };
  const sessionKey = FIELD_TO_SESSION_KEY[correctionResult.field] || correctionResult.field;

  if (correctionResult.newValue === null) delete updated[sessionKey];
  else updated[sessionKey] = correctionResult.newValue;

  const clear = (...keys: string[]) => keys.forEach(k => delete updated[k]);
  switch (correctionResult.field) {
    case 'service':
      clear('selected_staff_id', 'staff_id', 'date', 'time', 'selected_date', 'selected_time', 'slot_id', 'selected_slot_id', 'availability', 'booking_id', 'confirmation', 'confirmed');
      break;
    case 'date':
      clear('time', 'selected_time', 'slot_id', 'selected_slot_id', 'availability', 'booking_id', 'confirmation', 'confirmed');
      break;
    case 'time':
      clear('slot_id', 'selected_slot_id', 'availability', 'booking_id', 'confirmation', 'confirmed');
      break;
    case 'quantity':
      clear('price', 'total', 'total_amount', 'stock_reservation_id', 'reservation_id', 'payment_url', 'payment_reference', 'confirmation', 'confirmed');
      break;
  }
  return updated;
}
