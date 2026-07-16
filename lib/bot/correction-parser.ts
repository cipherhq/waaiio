/**
 * Correction Parser — detects when a user wants to change a previous answer.
 *
 * Examples:
 *   "actually make it 3pm" -> correction to time
 *   "change to tomorrow"   -> correction to date
 *   "no, 4 people"         -> correction to quantity
 *   "not that service"     -> clear service selection
 *   "same as last time"    -> repeat last booking/order
 *
 * All patterns are deterministic regex — no LLM calls.
 */

import type { CorrectionResult } from './conversation-types';
import type { BotSession } from './bot-types';

// ── Deterministic correction patterns ───────────────────

const CORRECTION_PATTERNS: Array<{
  pattern: RegExp;
  field: string;
  extractor: (match: RegExpMatchArray) => unknown;
}> = [
  // Date corrections: "actually today", "actually tomorrow", "actually monday"
  {
    pattern: /^actually\s+(today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday)/i,
    field: 'date',
    extractor: (m) => m[1].toLowerCase(),
  },
  // Date corrections: "change/switch/move it to <day>"
  {
    pattern: /^(?:change|switch|move)\s+(?:it\s+)?to\s+(today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday)/i,
    field: 'date',
    extractor: (m) => m[1].toLowerCase(),
  },
  // Time corrections: "actually 3pm", "i meant 2:30pm"
  {
    pattern: /^(?:actually|i\s+meant)\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)/i,
    field: 'time',
    extractor: (m) => m[1].trim(),
  },
  // Time corrections: "change/make the time to 3pm"
  {
    pattern: /^(?:change|make)\s+(?:it|the\s+time)\s+(?:to\s+)?(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)/i,
    field: 'time',
    extractor: (m) => m[1].trim(),
  },
  // Quantity/party size corrections: "actually 4 people", "make it 3 guests"
  {
    pattern: /^(?:actually|make\s+it|change\s+(?:it\s+)?to)\s+(\d+)\s*(?:people|persons?|guests?|pax)?/i,
    field: 'quantity',
    extractor: (m) => parseInt(m[1], 10),
  },
  // Quantity: "for 4 people", "make it 3 guests"
  {
    pattern: /^(?:for|make\s+it)\s+(\d+)\s*(?:people|persons?|guests?|pax)/i,
    field: 'quantity',
    extractor: (m) => parseInt(m[1], 10),
  },
  // Service rejection: "not that service", "wrong one"
  {
    pattern: /^(?:not\s+that|wrong)\s+(?:service|one|item)/i,
    field: 'service',
    extractor: () => null, // Clear the selection
  },
  // Repeat last: "same as last time", "do it again", "reorder"
  {
    pattern: /^(?:same\s+as\s+(?:last|before|previous)|do\s+(?:it|the\s+same)\s+again|repeat|reorder)/i,
    field: 'repeat_last',
    extractor: () => true,
  },
];

// Quick-check triggers — skip pattern matching if none match
const CORRECTION_TRIGGERS = [
  /\b(actually|change|switch|no\b.*\binstead|correct|update|modify|wrong)\b/i,
  /\b(not\s+\d|not\s+that|i\s+meant?)\b/i,
  /\b(make\s+it|change\s+it\s+to|switch\s+to)\b/i,
  /\b(same\s+as\s+last|do\s+it\s+again|repeat|reorder)\b/i,
  /^for\s+\d+\s+(?:people|persons?|guests?|pax)/i,
];

// Maps correction field names to session_data keys
const FIELD_TO_SESSION_KEY: Record<string, string> = {
  date: 'selected_date',
  time: 'selected_time',
  quantity: 'party_size',
  service: 'selected_service_id',
};

/**
 * Detect if a message is a correction to a previous flow answer.
 * Only runs during active flow sessions (has current_step).
 */
export function detectCorrection(
  text: string,
  session: BotSession,
): CorrectionResult | null {
  if (!session.is_active || !session.current_step) return null;

  const normalized = text.trim();

  // Quick check — does the message look like a correction?
  if (!CORRECTION_TRIGGERS.some(p => p.test(normalized))) {
    return null;
  }

  for (const { pattern, field, extractor } of CORRECTION_PATTERNS) {
    const match = normalized.match(pattern);
    if (match) {
      const newValue = extractor(match);
      const sessionData = session.session_data || {};
      const sessionKey = FIELD_TO_SESSION_KEY[field] || field;
      const oldValue = sessionData[sessionKey] ?? null;

      return {
        field,
        oldValue,
        newValue,
        confidence: 0.90,
      };
    }
  }

  return null;
}

/**
 * Apply a correction to session data.
 * Returns a new session_data object with the correction applied.
 */
export function applyCorrection(
  sessionData: Record<string, unknown>,
  correction: CorrectionResult,
): Record<string, unknown> {
  const updated = { ...sessionData };
  const sessionKey = FIELD_TO_SESSION_KEY[correction.field] || correction.field;

  if (correction.newValue === null) {
    delete updated[sessionKey];
  } else {
    updated[sessionKey] = correction.newValue;
  }

  return updated;
}
