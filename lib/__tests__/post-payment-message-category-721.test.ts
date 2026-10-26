/**
 * Regression test for #721: All proactive post-payment WhatsApp sends must
 * include a messageCategory so the financial authorization gate
 * (M370/M371 authorize_message_send) does not reject with missing_message_category.
 *
 * Free-form transactional sends use 'service' (correct rate for service-window
 * messages; Meta rejects out-of-window free-form sends regardless of category).
 * Engagement CTAs (saved-card offer, recurring offer) use 'marketing'.
 * Template sends resolve category from Meta API per WABA (not static map).
 *
 * This is a structural assertion — it reads source files and verifies every
 * sender.send*(…) call site includes messageCategory within its argument block.
 * If a new send call is added without messageCategory, this test fails.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '../..');

/**
 * Files that contain proactive (webhook/post-payment) WhatsApp sends.
 * These run OUTSIDE the 24-hour service window, so they MUST include
 * messageCategory to pass the financial authorization gate.
 */
const PROACTIVE_SEND_FILES = [
  'lib/payments/send-confirmation.ts',
  'lib/bot/flows/shared/send-tickets.ts',
  'lib/bot/flows/shared/notify-owner.ts',
  'lib/bot/flows/shared/post-completion.ts',
  'lib/payments/saved-card-offer.ts',
  'lib/payments/saved-card-delivery.ts',
  'lib/payments/recurring-offer.ts',
  // recurring-setup.ts: excluded — inbound button-tap replies, sender defaults to 'service'
  // sealed-rule-actions.ts: excluded — sendMessage is merchant-authored (no forced category),
  //   sendTemplate resolves from TEMPLATE_CATEGORY_MAP (tested separately in sealed-rule-actions.test.ts)
];

/** Matches a line that opens a sender.send* call */
const SEND_OPEN_RE = /sender\.send(?:Text|Buttons|Image|Document|List|Audio|Template)[!]?\(/;

describe('#721: Post-payment sends include messageCategory', () => {
  for (const relPath of PROACTIVE_SEND_FILES) {
    it(`${relPath} — every send call includes messageCategory`, () => {
      const src = readFileSync(join(ROOT, relPath), 'utf-8');
      const lines = src.split('\n');
      const violations: string[] = [];

      for (let i = 0; i < lines.length; i++) {
        if (!SEND_OPEN_RE.test(lines[i])) continue;

        // Skip merchant-authored rule callbacks (intentionally no forced category)
        const prevLines = lines.slice(Math.max(0, i - 5), i).join(' ');
        if (prevLines.includes('Merchant-authored')) continue;

        // Single-line call: check this line
        if (lines[i].includes('messageCategory')) continue;

        // Multi-line call: scan forward up to 15 lines for messageCategory
        // before the matching close `)` or `});`
        let found = false;
        for (let j = i + 1; j < Math.min(i + 15, lines.length); j++) {
          if (lines[j].includes('messageCategory')) { found = true; break; }
          // Stop scanning at the closing of the send call
          if (/^\s*\}\);?\s*$/.test(lines[j]) || /^\s*\}\)\s*\.catch/.test(lines[j])) break;
        }

        if (!found) {
          violations.push(`Line ${i + 1}: ${lines[i].trim()}`);
        }
      }

      expect(violations, `Send calls missing messageCategory in ${relPath}:\n${violations.join('\n')}`).toHaveLength(0);
    });
  }
});
