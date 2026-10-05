/**
 * Outbound Localization Boundary — Slice 3 (#524)
 *
 * Single reusable helper for localizing Waaiio-owned outbound messages.
 * Sits above MessageSender/transport. Reuses translateBotResponse,
 * TranslationContext, and LanguageEntitlement.
 *
 * Design principles:
 * - Waaiio-owned text is localized; merchant/human content passes through.
 * - Protected dynamic values (merchant names, URLs, amounts, references)
 *   are preserved byte-for-byte via placeholder protection.
 * - Action IDs / postback IDs are NEVER translated.
 * - Entitlement + certification gates are enforced by translateBotResponse.
 */

import { translateBotResponse, type TranslationContext, type TranslateOptions } from './translate';
import type { PromptMessage, PromptList, PromptButtons } from './flows/types';

/**
 * Localize a single PromptMessage through the canonical translation boundary.
 *
 * - text body, button titles, list title/body/buttonLabel/section titles,
 *   image/document captions — Waaiio-owned presentation fields are translated.
 * - button IDs, list item postbackText — machine action authority, never translated.
 * - list item titles — merchant-entered by default; only translated if
 *   `waaiioOwnedItemTitles` is true (e.g. capability menu, navigation lists).
 * - list item descriptions — Waaiio-owned, translated.
 *
 * @param msg - The prompt message to localize
 * @param lang - Target language code
 * @param tCtx - Translation context with entitlement
 * @param opts - Optional: protectedValues (merchant names, URLs, etc.),
 *               waaiioOwnedItemTitles (for Waaiio navigation/menu lists)
 */
export async function localizeMessage(
  msg: PromptMessage,
  lang: string,
  tCtx: TranslationContext,
  opts?: TranslateOptions & { waaiioOwnedItemTitles?: boolean },
): Promise<PromptMessage> {
  const tOpts: TranslateOptions | undefined = opts?.protectedValues?.length ? { protectedValues: opts.protectedValues } : undefined;

  switch (msg.type) {
    case 'text':
      return { ...msg, text: await translateBotResponse(msg.text, lang, tCtx, tOpts) };

    case 'buttons':
      return localizeButtons(msg, lang, tCtx, tOpts);

    case 'list':
      return localizeList(msg, lang, tCtx, tOpts, opts?.waaiioOwnedItemTitles);

    case 'image':
      return {
        ...msg,
        caption: msg.caption ? await translateBotResponse(msg.caption, lang, tCtx, tOpts) : msg.caption,
      };

    case 'document':
      return {
        ...msg,
        caption: msg.caption ? await translateBotResponse(msg.caption, lang, tCtx, tOpts) : msg.caption,
      };

    default:
      return msg;
  }
}

async function localizeButtons(
  msg: PromptButtons,
  lang: string,
  tCtx: TranslationContext,
  tOpts?: TranslateOptions,
): Promise<PromptButtons> {
  return {
    ...msg,
    body: await translateBotResponse(msg.body, lang, tCtx, tOpts),
    // Footer is navigation commands — translate as Waaiio-owned UI
    footer: msg.footer ? await translateBotResponse(msg.footer, lang, tCtx, tOpts) : msg.footer,
    buttons: await Promise.all(msg.buttons.map(async b => ({
      ...b,
      // ID is machine authority — NEVER translated
      title: await translateBotResponse(b.title, lang, tCtx, tOpts),
    }))),
  };
}

async function localizeList(
  msg: PromptList,
  lang: string,
  tCtx: TranslationContext,
  tOpts?: TranslateOptions,
  waaiioOwnedItemTitles?: boolean,
): Promise<PromptList> {
  const localizedItems = await Promise.all(msg.items.map(async item => ({
    ...item,
    // postbackText is machine authority — NEVER translated
    title: waaiioOwnedItemTitles
      ? await translateBotResponse(item.title, lang, tCtx, tOpts)
      : item.title, // merchant-entered by default
    description: item.description
      ? await translateBotResponse(item.description, lang, tCtx, tOpts)
      : item.description,
  })));

  const localizedSections = msg.sections
    ? await Promise.all(msg.sections.map(async section => ({
        ...section,
        title: await translateBotResponse(section.title, lang, tCtx, tOpts),
        items: await Promise.all(section.items.map(async item => ({
          ...item,
          // postbackText is machine authority — NEVER translated
          title: waaiioOwnedItemTitles
            ? await translateBotResponse(item.title, lang, tCtx, tOpts)
            : item.title,
          description: item.description
            ? await translateBotResponse(item.description, lang, tCtx, tOpts)
            : item.description,
        }))),
      })))
    : msg.sections;

  return {
    ...msg,
    title: await translateBotResponse(msg.title, lang, tCtx, tOpts),
    body: await translateBotResponse(msg.body, lang, tCtx, tOpts),
    buttonLabel: await translateBotResponse(msg.buttonLabel, lang, tCtx, tOpts),
    footer: msg.footer ? await translateBotResponse(msg.footer, lang, tCtx, tOpts) : msg.footer,
    items: localizedItems,
    sections: localizedSections,
  };
}

/**
 * Localize a plain text string through the canonical translation boundary.
 * Convenience wrapper for BotService/handler sends that just have a text string.
 */
export async function localizeText(
  text: string,
  lang: string,
  tCtx: TranslationContext,
  opts?: TranslateOptions,
): Promise<string> {
  return translateBotResponse(text, lang, tCtx, opts);
}
