/**
 * Safe interactive message composition for WhatsApp.
 *
 * #268 Blocker 6: WhatsApp interactive message bodies are limited to 1024 chars.
 * If a consolidated buttons message exceeds this limit, fall back to a text summary
 * + short buttons message. Never truncate payment URLs, T&C links, amounts,
 * references, or other protected content.
 */

import type { PromptMessage } from '../types';

/** WhatsApp interactive body character limit */
const INTERACTIVE_BODY_MAX = 1024;

/**
 * Build a safe buttons message. If `body` fits within the WhatsApp interactive
 * body limit, returns a single buttons message. If it exceeds the limit,
 * returns a text message with the full content + a short buttons message.
 *
 * This prevents silent truncation of payment URLs, T&C links, amounts, etc.
 */
export function safeButtons(
  body: string,
  buttons: Array<{ id: string; title: string }>,
  footer?: string,
): PromptMessage[] {
  if (body.length <= INTERACTIVE_BODY_MAX) {
    return [{
      type: 'buttons',
      body,
      buttons,
      ...(footer ? { footer } : {}),
    }];
  }

  // Body exceeds limit — split into text + short buttons
  return [
    { type: 'text', text: body },
    {
      type: 'buttons',
      body: 'Select an option below:',
      buttons,
      ...(footer ? { footer } : {}),
    },
  ];
}
