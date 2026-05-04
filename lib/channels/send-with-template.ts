import type { MessageSender } from './message-sender';
import { logger } from '@/lib/logger';

/**
 * Send a business-initiated WhatsApp message with template fallback.
 *
 * Business-initiated messages (outside 24h window) require an approved
 * template to open the conversation. This helper:
 *
 * 1. Tries to send via template first (works outside 24h)
 * 2. If template succeeds, sends the actual content (buttons/text) as follow-up
 * 3. If no template available, sends content directly (only works within 24h)
 *
 * The template opens the conversation window, allowing follow-up messages.
 */

interface SendOptions {
  sender: MessageSender;
  to: string;
  /** Template name to use for opening conversation */
  templateName: string;
  /** Template parameters (strings only) */
  templateParams: string[];
  /** The actual content to send after template opens the window */
  followUpFn?: (sender: MessageSender, to: string) => Promise<void>;
  /** If true, only send template (no follow-up) */
  templateOnly?: boolean;
}

export async function sendWithTemplate(opts: SendOptions): Promise<{ sent: boolean; messageId?: string }> {
  const { sender, to, templateName, templateParams, followUpFn, templateOnly } = opts;

  // 1. Try template first
  if (sender.sendTemplate) {
    try {
      const result = await sender.sendTemplate({
        to,
        templateName,
        templateParams,
      });

      if (result.success !== false) {
        logger.debug(`[SEND] Template ${templateName} sent to ${to}`);

        // 2. Send follow-up content (template opened the 24h window)
        if (!templateOnly && followUpFn) {
          // Small delay to ensure template is delivered first
          await new Promise(resolve => setTimeout(resolve, 500));
          try {
            await followUpFn(sender, to);
          } catch (err) {
            logger.error(`[SEND] Follow-up after template failed for ${to}:`, err);
          }
        }

        return { sent: true, messageId: result.messageId };
      }
    } catch (err) {
      logger.warn(`[SEND] Template ${templateName} failed for ${to}:`, err);
    }
  }

  // 3. Fallback: send content directly (only works within 24h window)
  if (followUpFn) {
    try {
      await followUpFn(sender, to);
      return { sent: true };
    } catch (err) {
      logger.error(`[SEND] Direct send failed for ${to}:`, err);
    }
  }

  return { sent: false };
}
