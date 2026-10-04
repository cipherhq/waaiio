/**
 * Correction Parser — deterministic mid-flow edits without LLM calls.
 *
 * Slice 2 (#524) recognizes common correction language across the eight
 * architecture-supported languages while failing closed outside steps where
 * the existing flow can safely revalidate downstream authority.
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

const SERVICE_CORRECTIONS = [
  /^(?:not that|wrong|another|change)\s+(?:service|one|item)$/,
  /^(?:abeg\s+)?change\s+service$/,
  /^yi\s+service\s+pada$/,
  /^gbanwee\s+service$/,
  /^canza\s+service$/,
  /^sesa\s+service$/,
  /^changer\s+(?:le\s+)?service$/,
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
  /^san\s+ye$/,
  /^refaire$/,
  /^repetir$/,
];

const SAFE_STEPS: Record<string, ReadonlySet<string>> = {
  date: new Set(['select_date', 'select_time']),
  time: new Set(['select_time']),
  quantity: new Set(['select_quantity']),
  service: new Set(['select_service']),
  variant: new Set(['select_option_axis', 'select_variant', 'select_variant_error']),
};

function hasCue(normalized: string, patterns: readonly RegExp[]): boolean {
  return patterns.some(pattern => pattern.test(normalized));
}

function canonicalDateFromText(normalized: string): string | null {
  const padded = ` ${normalized} `;
  // Prefer longer aliases first (e.g. aujourd'hui before a shorter token).
  const aliases = [...DATE_ALIASES].sort((a, b) => b[0].length - a[0].length);
  for (const [alias, canonical] of aliases) {
    if (padded.includes(` ${alias} `)) return canonical;
  }
  return null;
}

function isSafeAtCurrentStep(field: string, step: string): boolean {
  if (field === 'repeat_last') return true;
  const allowed = SAFE_STEPS[field];
  return !!allowed?.has(step);
}

/**
 * Detect if a message is a safe correction to an active flow answer.
 * Recognition outside a safe pre-confirmation step fails closed so a correction
 * can never carry stale availability, stock, price, or confirmation state.
 */
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
    field = 'repeat_last';
    newValue = true;
  }

  if (!field && SERVICE_CORRECTIONS.some(pattern => pattern.test(normalized))) {
    field = 'service';
    newValue = null;
  }

  if (!field && VARIANT_CORRECTIONS.some(pattern => pattern.test(normalized))) {
    field = 'variant';
    newValue = null;
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

  // Preserve existing concise English forms that do not contain a general cue.
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

  if (!field || !isSafeAtCurrentStep(field, session.current_step)) return null;

  const oldValue = (() => {
    if (field === 'date') return sessionData.date ?? sessionData.selected_date ?? null;
    if (field === 'time') return sessionData.time ?? sessionData.selected_time ?? null;
    if (field === 'quantity') return sessionData.current_quantity ?? sessionData.quantity ?? sessionData.party_size ?? null;
    if (field === 'service') return sessionData.service_id ?? sessionData.selected_service_id ?? null;
    if (field === 'variant') return sessionData.current_variant_id ?? sessionData.variant_id ?? sessionData.selected_variant_id ?? null;
    return sessionData[field] ?? null;
  })();

  return { field, oldValue, newValue, confidence: 0.90 };
}

function clearKeys(target: Record<string, unknown>, keys: readonly string[]): void {
  for (const key of keys) delete target[key];
}

/**
 * Apply only the state mutation that is safe for the current pre-confirmation
 * step, while invalidating any dependent cached/selected authority.
 */
export function applyCorrection(
  sessionData: Record<string, unknown>,
  correction: CorrectionResult,
): Record<string, unknown> {
  const updated = { ...sessionData };

  switch (correction.field) {
    case 'date':
      updated.date = correction.newValue;
      updated.selected_date = correction.newValue;
      clearKeys(updated, [
        'time', 'selected_time', '_selected_slot', 'slot_id', 'booking_slot_id',
        '_availability_checked', '_availability_snapshot',
      ]);
      break;
    case 'time':
      updated.time = correction.newValue;
      updated.selected_time = correction.newValue;
      clearKeys(updated, ['_selected_slot', 'slot_id', 'booking_slot_id', '_availability_checked', '_availability_snapshot']);
      break;
    case 'quantity': {
      const activeCapability = String(updated.active_capability || '');
      if (activeCapability === 'ordering') updated.current_quantity = correction.newValue;
      else if (activeCapability === 'ticketing') updated.quantity = correction.newValue;
      else updated.party_size = correction.newValue;
      clearKeys(updated, ['_price_snapshot', '_availability_snapshot', '_stock_snapshot']);
      break;
    }
    case 'service':
      clearKeys(updated, [
        'service_id', 'selected_service_id', 'service_name', '_service_name', '_service_metadata',
        '_service_is_class', 'staff_id', 'selected_staff_id', 'date', 'selected_date', 'time',
        'selected_time', 'party_size', 'addons', 'selected_addons', '_selected_slot', 'slot_id',
        'booking_slot_id', '_availability_checked', '_availability_snapshot',
      ]);
      break;
    case 'variant':
      clearKeys(updated, [
        'variant_id', 'selected_variant_id', 'current_variant_id', 'current_variant_label',
        'current_selected_options', 'current_option_axis_index', '_variant_hints', '_stock_snapshot',
      ]);
      break;
    default:
      if (correction.newValue === null) delete updated[correction.field];
      else updated[correction.field] = correction.newValue;
      break;
  }

  return updated;
}
