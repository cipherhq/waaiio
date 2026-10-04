/**
 * Correction Parser — deterministic mid-flow edits without LLM calls.
 *
 * Slice 2 (#524) recognizes common correction language across the eight
 * architecture-supported languages. Recognition returns a target authority
 * step where the existing flow must revalidate the correction.
 */
import type { CorrectionResult } from './conversation-types';
import type { BotSession } from './bot-types';
import { normalizeInboundCommand } from './inbound-command-normalization';

const DATE_ALIASES: ReadonlyArray<readonly [string, string]> = [
  // English / Pidgin
  ['today', 'today'], ['todey', 'today'], ['tomorrow', 'tomorrow'], ['2moro', 'tomorrow'],
  ['monday', 'monday'], ['tuesday', 'tuesday'], ['wednesday', 'wednesday'], ['thursday', 'thursday'],
  ['friday', 'friday'], ['saturday', 'saturday'], ['sunday', 'sunday'],
  // Yoruba
  ['loni', 'today'], ['ọla', 'tomorrow'], ['ola', 'tomorrow'],
  // Igbo
  ['taa', 'today'], ['echi', 'tomorrow'],
  // Hausa
  ['yau', 'today'], ['gobe', 'tomorrow'], ['litinin', 'monday'], ['talata', 'tuesday'],
  ['laraba', 'wednesday'], ['alhamis', 'thursday'], ["juma'a", 'friday'], ['asabar', 'saturday'], ['lahadi', 'sunday'],
  // Twi
  ['ɛnnɛ', 'today'], ['enne', 'today'], ['ɔkyena', 'tomorrow'], ['okyena', 'tomorrow'],
  // French
  ["aujourd'hui", 'today'], ['demain', 'tomorrow'], ['lundi', 'monday'], ['mardi', 'tuesday'],
  ['mercredi', 'wednesday'], ['jeudi', 'thursday'], ['vendredi', 'friday'], ['samedi', 'saturday'], ['dimanche', 'sunday'],
  // Spanish
  ['hoy', 'today'], ['mañana', 'tomorrow'], ['manana', 'tomorrow'], ['lunes', 'monday'], ['martes', 'tuesday'],
  ['miércoles', 'wednesday'], ['miercoles', 'wednesday'], ['jueves', 'thursday'], ['viernes', 'friday'],
  ['sábado', 'saturday'], ['sabado', 'saturday'], ['domingo', 'sunday'],
].map(([alias, canonical]) => [normalizeInboundCommand(alias), canonical] as const);

const GENERAL_CORRECTION_CUES = [
  /\b(actually|change|switch|move|correct|update|modify|wrong|instead|meant)\b/,
  /\b(make it|make am|abeg change)\b/,
  /\b(yi|pada|gbanwee|canza|sesa)\b/,
  /\b(changer|changez|plutot)\b/,
  /\b(cambiar|cambia|mejor)\b/,
];

const TIME_CUES = [
  /\b(time|i meant|actually|make it|make am)\b/,
  /\b(akoko|oge|lokaci|bere)\b/,
  /\b(heure|hora)\b/,
];

const QUANTITY_CUES = [
  /\b(quantity|people|persons?|guests?|pax|tickets?|items?|make it|make am)\b/,
  /\b(iye|onu ogugu|adadi|dodow)\b/,
  /\b(quantite|cantidad)\b/,
];

const DATE_RESELECT = new Set([
  'change date', 'change the date', 'different date', 'change date abeg', 'another date abeg',
  'yi ojo pada', 'ojo miiran', 'gbanwee ubochi', 'ubochi ozo', 'canza rana', 'wata rana',
  'sesa da', 'da foforo', 'changer la date', 'autre date', 'cambiar fecha', 'otra fecha',
].map(normalizeInboundCommand));

const TIME_RESELECT = new Set([
  'change time', 'change the time', 'different time', 'change time abeg', 'another time abeg',
  'yi akoko pada', 'akoko miiran', 'gbanwee oge', 'oge ozo', 'canza lokaci', 'wani lokaci',
  'sesa bere', 'bere foforo', "changer l'heure", 'autre heure', 'cambiar hora', 'otra hora',
].map(normalizeInboundCommand));

const QUANTITY_RESELECT = new Set([
  'change quantity', 'change number', 'different quantity', 'change quantity abeg', 'change number abeg',
  'yi iye pada', 'gbanwee onu', 'canza adadi', 'sesa dodow', 'changer la quantite',
  'changer le nombre', 'cambiar cantidad', 'cambiar numero',
].map(normalizeInboundCommand));

const SERVICE_CORRECTIONS = [
  /^(?:not that|wrong|another|change)\s+(?:service|one|item)$/,
  /^(?:abeg\s+)?change\s+service$/,
  /^yi\s+(?:ise|service)\s+pada$/,
  /^gbanwee\s+(?:oru|service)$/,
  /^canza\s+(?:sabis|service)$/,
  /^sesa\s+service$/,
  /^changer\s+(?:de\s+|le\s+)?service$/,
  /^cambiar\s+(?:el\s+)?servicio$/,
];

const VARIANT_CORRECTIONS = [
  /^(?:change|another|wrong)\s+(?:size|color|colour|variant|option)$/,
  /^(?:abeg\s+)?change\s+(?:size|color|colour|variant|option)$/,
  /^yi\s+(?:size|color|colour|variant|option)\s+pada$/,
  /^gbanwee\s+(?:size|color|colour|variant|option)$/,
  /^canza\s+(?:size|color|colour|variant|option)$/,
  /^sesa\s+(?:size|color|colour|variant|option)$/,
  /^changer\s+(?:la\s+)?(?:taille|couleur|variante|option)$/,
  /^cambiar\s+(?:la\s+)?(?:talla|color|variante|opcion)$/,
];

const REPEAT_PATTERNS = [
  /^(?:same as (?:last|before|previous)(?: time| order| booking)?|do (?:it|the same) again|repeat|reorder)$/,
  /^(?:abeg\s+)?(?:do am again|order am again)$/,
  /^tun\s+(?:se|ra)\b/,
  /^mee\s+ya\s+ozo$/,
  /^sake\s+yi$/,
  /^san\s+ye(?:\s+bio)?$/,
  /^refaire$/,
  /^repeter$/,
  /^repetir$/,
];

const FIELD_TO_TARGET: Readonly<Record<string, string>> = {
  date: 'select_date',
  time: 'select_time',
  quantity: 'select_quantity',
  service: 'select_service',
};

function hasCue(normalized: string, patterns: readonly RegExp[]): boolean {
  return patterns.some(pattern => pattern.test(normalized));
}

function canonicalDateFromText(normalized: string): string | null {
  const padded = ` ${normalized} `;
  const aliases = [...DATE_ALIASES].sort((a, b) => b[0].length - a[0].length);
  for (const [alias, canonical] of aliases) {
    if (padded.includes(` ${alias} `)) return canonical;
  }
  return null;
}

/**
 * Resolve the existing flow step that is allowed to regain authority.
 * Review-stage rewind is deliberately narrow: only scheduling/appointment
 * confirmation can rewind date/time/quantity. Payment/order review remains
 * fail-closed until those flows have an equally authoritative edit path.
 */
function correctionTargetStep(field: string, session: BotSession): string | null {
  const step = session.current_step;
  const cap = String(session.session_data?.active_capability || '');

  if (field === 'repeat_last') return null;

  if (field === 'date') {
    if (step === 'select_date' || step === 'select_time') return 'select_date';
    if (step === 'confirmation' && (cap === 'scheduling' || cap === 'appointment')) return 'select_date';
    return null;
  }

  if (field === 'time') {
    if (step === 'select_time') return 'select_time';
    if (step === 'confirmation' && (cap === 'scheduling' || cap === 'appointment')) return 'select_time';
    return null;
  }

  if (field === 'quantity') {
    if (step === 'select_quantity') return 'select_quantity';
    if (step === 'confirmation' && (cap === 'scheduling' || cap === 'appointment')) return 'select_quantity';
    return null;
  }

  if (field === 'service') {
    return step === 'select_service' ? FIELD_TO_TARGET.service : null;
  }

  if (field === 'variant') {
    return ['select_option_axis', 'select_variant', 'select_variant_error'].includes(step)
      ? step
      : null;
  }

  return null;
}

/** Detect a deterministic correction. Recognition itself never mutates state. */
export function detectCorrection(
  text: string,
  session: BotSession,
): CorrectionResult | null {
  if (!session.is_active || !session.current_step) return null;

  const normalized = normalizeInboundCommand(text);
  if (!normalized) return null;
  const sessionData = session.session_data || {};

  let field: string | null = null;
  let newValue: unknown = null;

  if (REPEAT_PATTERNS.some(pattern => pattern.test(normalized))) {
    return {
      field: 'repeat_last',
      oldValue: null,
      newValue: true,
      confidence: 0.90,
    };
  }

  if (SERVICE_CORRECTIONS.some(pattern => pattern.test(normalized))) {
    field = 'service';
  } else if (VARIANT_CORRECTIONS.some(pattern => pattern.test(normalized))) {
    field = 'variant';
  } else if (DATE_RESELECT.has(normalized)) {
    field = 'date';
  } else if (TIME_RESELECT.has(normalized)) {
    field = 'time';
  } else if (QUANTITY_RESELECT.has(normalized)) {
    field = 'quantity';
  }

  const hasGeneralCue = hasCue(normalized, GENERAL_CORRECTION_CUES);

  if (!field && hasGeneralCue) {
    const date = canonicalDateFromText(normalized);
    if (date) {
      field = 'date';
      newValue = date;
    }
  }

  if (!field && hasGeneralCue && hasCue(normalized, TIME_CUES)) {
    const timeMatch = normalized.match(/\b(\d{1,2}(?::\d{2})?\s*(?:am|pm))\b/)
      || normalized.match(/\b(\d{1,2}:\d{2})\b/);
    if (timeMatch) {
      field = 'time';
      newValue = timeMatch[1].replace(/\s+/g, '');
    }
  }

  if (!field && hasGeneralCue && hasCue(normalized, QUANTITY_CUES)) {
    const quantityMatch = normalized.match(/\b(\d+)\b/);
    if (quantityMatch) {
      const quantity = Number.parseInt(quantityMatch[1], 10);
      if (Number.isFinite(quantity) && quantity > 0) {
        field = 'quantity';
        newValue = quantity;
      }
    }
  }

  if (!field) {
    const conciseTime = normalized.match(/^(?:actually|i meant)\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)$/);
    if (conciseTime) {
      field = 'time';
      newValue = conciseTime[1].replace(/\s+/g, '');
    }
  }

  if (!field) {
    const conciseQty = normalized.match(/^(?:for|make it|make am)\s+(\d+)\s*(?:people|persons?|guests?|pax|tickets?|items?)?$/);
    if (conciseQty) {
      field = 'quantity';
      newValue = Number.parseInt(conciseQty[1], 10);
    }
  }

  if (!field) return null;
  const targetStep = correctionTargetStep(field, session);
  if (!targetStep) return null;

  const oldValue = (() => {
    if (field === 'date') return sessionData.date ?? sessionData.selected_date ?? null;
    if (field === 'time') return sessionData.time ?? sessionData.selected_time ?? null;
    if (field === 'quantity') return sessionData.current_quantity ?? sessionData.quantity ?? sessionData.party_size ?? null;
    if (field === 'service') return sessionData.service_id ?? sessionData.selected_service_id ?? null;
    if (field === 'variant') return sessionData.current_variant_id ?? sessionData.variant_id ?? sessionData.selected_variant_id ?? null;
    return sessionData[field] ?? null;
  })();

  return { field, oldValue, newValue, confidence: 0.90, targetStep };
}

function clearKeys(target: Record<string, unknown>, keys: readonly string[]): void {
  for (const key of keys) delete target[key];
}

/**
 * Prepare state for an authoritative correction re-entry. This deliberately
 * DOES NOT apply the user's new value. FlowExecutor's existing validator owns
 * that value and persists it through the normal CAS path.
 */
export function prepareCorrectionReentry(
  sessionData: Record<string, unknown>,
  correction: CorrectionResult,
): Record<string, unknown> {
  const updated = { ...sessionData };

  switch (correction.field) {
    case 'date':
      clearKeys(updated, [
        'date', 'selected_date', 'time', 'selected_time',
        'staff_id', 'selected_staff_id', 'staff_name', '_available_staff', '_staff_unavailable',
        '_selected_slot', 'slot_id', 'selected_slot_id', 'booking_slot_id',
        '_availability_checked', '_availability_snapshot', 'confirmation', 'confirmed',
      ]);
      break;
    case 'time':
      clearKeys(updated, [
        'time', 'selected_time', '_selected_slot', 'slot_id', 'selected_slot_id', 'booking_slot_id',
        '_availability_checked', '_availability_snapshot', 'confirmation', 'confirmed',
      ]);
      break;
    case 'quantity':
      clearKeys(updated, [
        'party_size', 'current_quantity', 'quantity', 'guest_list',
        '_price_snapshot', '_availability_snapshot', '_stock_snapshot',
        'confirmation', 'confirmed',
      ]);
      break;
    case 'service':
      clearKeys(updated, [
        'service_id', 'selected_service_id', 'service_name', '_service_name', '_service_metadata',
        '_service_is_class', 'staff_id', 'selected_staff_id', 'staff_name', 'date', 'selected_date',
        'time', 'selected_time', 'party_size', 'guest_list', 'addons', 'selected_addons',
        '_selected_slot', 'slot_id', 'selected_slot_id', 'booking_slot_id',
        '_availability_checked', '_availability_snapshot', 'confirmation', 'confirmed',
      ]);
      break;
    case 'variant':
      clearKeys(updated, [
        'variant_id', 'selected_variant_id', 'current_variant_id', 'current_variant_label',
        'current_selected_options', 'current_option_axis_index', '_variant_hints', '_stock_snapshot',
        'confirmation', 'confirmed',
      ]);
      break;
  }

  if (correction.targetStep) {
    const history = Array.isArray(updated._step_history)
      ? [...(updated._step_history as string[])]
      : [];
    const targetIndex = history.lastIndexOf(correction.targetStep);
    updated._step_history = targetIndex >= 0
      ? history.slice(0, targetIndex + 1)
      : [...history, correction.targetStep];
  }

  return updated;
}

/**
 * Legacy data-only application for targetless consumers. Runtime target-step
 * corrections are intercepted earlier and revalidated by FlowExecutor.
 */
export function applyCorrection(
  sessionData: Record<string, unknown>,
  correction: CorrectionResult,
): Record<string, unknown> {
  const updated = prepareCorrectionReentry(sessionData, correction);

  switch (correction.field) {
    case 'date':
      if (correction.newValue !== null) {
        updated.date = correction.newValue;
        updated.selected_date = correction.newValue;
      }
      break;
    case 'time':
      if (correction.newValue !== null) {
        updated.time = correction.newValue;
        updated.selected_time = correction.newValue;
      }
      break;
    case 'quantity': {
      if (correction.newValue === null) break;
      const activeCapability = String(updated.active_capability || '');
      if (activeCapability === 'ordering') updated.current_quantity = correction.newValue;
      else if (activeCapability === 'ticketing') updated.quantity = correction.newValue;
      else updated.party_size = correction.newValue;
      break;
    }
    case 'service':
    case 'variant':
      break;
    default:
      if (correction.newValue === null) delete updated[correction.field];
      else updated[correction.field] = correction.newValue;
      break;
  }

  return updated;
}
