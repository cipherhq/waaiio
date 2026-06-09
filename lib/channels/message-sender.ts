/**
 * Unified MessageSender interface
 *
 * Both GupshupService (shared numbers) and MetaCloudService (dedicated numbers)
 * are wrapped behind this common interface so the bot doesn't need to know
 * which provider is handling the message.
 */

import { MetaCloudService } from './meta-cloud';
import { isCircuitOpen, recordSuccess, recordFailure, CircuitBreakerOpenError } from '@/lib/circuit-breaker';

const CIRCUIT_KEY = 'meta-cloud';

async function withRetry<T>(fn: () => Promise<T>, retries = 2, delay = 1000): Promise<T> {
  // Check circuit breaker before attempting any call
  if (isCircuitOpen(CIRCUIT_KEY)) {
    throw new CircuitBreakerOpenError(CIRCUIT_KEY);
  }

  for (let i = 0; i <= retries; i++) {
    try {
      const result = await fn();
      recordSuccess(CIRCUIT_KEY);
      return result;
    } catch (err) {
      // Don't retry client errors (4xx) — they won't succeed on retry.
      // Meta Cloud API errors include the HTTP status in the message (e.g. "Cloud API error: 400").
      const errMsg = err instanceof Error ? err.message : String(err);
      const is4xx = /\b4\d{2}\b/.test(errMsg);

      // Only record failure for server errors (5xx) or network errors, not client errors
      if (!is4xx) {
        recordFailure(CIRCUIT_KEY);
      }

      if (is4xx || i === retries) throw err;
      await new Promise(r => setTimeout(r, delay * (i + 1)));
    }
  }
  throw new Error('Retry exhausted');
}

export interface MessageSender {
  sendText(msg: { to: string; text: string }): Promise<{ success?: boolean; messageId?: string }>;
  sendList(msg: {
    to: string;
    title: string;
    body: string;
    buttonLabel: string;
    items: Array<{ title: string; description?: string; postbackText: string }>;
    sections?: Array<{
      title: string;
      items: Array<{ title: string; description?: string; postbackText: string }>;
    }>;
  }): Promise<{ success?: boolean; messageId?: string }>;
  sendButtons(msg: {
    to: string;
    body: string;
    buttons: Array<{ id: string; title: string }>;
  }): Promise<{ success?: boolean; messageId?: string }>;
  sendImage(msg: {
    to: string;
    imageUrl: string;
    caption?: string;
  }): Promise<{ success?: boolean; messageId?: string }>;
  sendDocument(msg: {
    to: string;
    documentUrl: string;
    filename: string;
    caption?: string;
  }): Promise<{ success?: boolean; messageId?: string }>;
  sendAudio(msg: {
    to: string;
    audioUrl: string;
  }): Promise<{ success?: boolean; messageId?: string }>;
  sendTemplate?(msg: {
    to: string;
    templateName: string;
    templateParams: string[];
    buttonParams?: string[];
  }): Promise<{ success?: boolean; messageId?: string }>;
  sendFlow?(msg: {
    to: string;
    bodyText: string;
    flowId: string;
    flowCta: string;
    screen: string;
    flowToken?: string;
    data?: Record<string, unknown>;
  }): Promise<{ success?: boolean; messageId?: string }>;
  sendReaction?(msg: {
    to: string;
    messageId: string;
    emoji: string;
  }): Promise<{ success?: boolean; messageId?: string }>;
  sendLocation?(msg: {
    to: string;
    latitude: number;
    longitude: number;
    name?: string;
    address?: string;
  }): Promise<{ success?: boolean; messageId?: string }>;
}

/**
 * Adapter that wraps MetaCloudService into the MessageSender interface
 * so it can be used interchangeably with GupshupService.
 */
export class MetaCloudSender implements MessageSender {
  constructor(private readonly cloud: MetaCloudService) {}

  async sendText(msg: { to: string; text: string }) {
    const result = await withRetry(() => this.cloud.sendText({ to: msg.to, text: msg.text }));
    return { success: true, messageId: result.messageId };
  }

  async sendList(msg: {
    to: string;
    title: string;
    body: string;
    buttonLabel: string;
    items: Array<{ title: string; description?: string; postbackText: string }>;
    sections?: Array<{
      title: string;
      items: Array<{ title: string; description?: string; postbackText: string }>;
    }>;
  }) {
    // Enforce WhatsApp API limits: title 24 chars, body 1024 chars, buttonLabel 20 chars, item title 24 chars, item description 72 chars
    const truncatedTitle = msg.title.length > 24 ? msg.title.slice(0, 21) + '...' : msg.title;
    const truncatedBody = msg.body.slice(0, 1024);
    const truncatedButtonLabel = msg.buttonLabel.slice(0, 20);

    const sections = msg.sections
      ? msg.sections.map(s => ({
          title: s.title.length > 24 ? s.title.slice(0, 21) + '...' : s.title,
          rows: s.items.map(item => ({
            id: item.postbackText,
            title: item.title.length > 24 ? item.title.slice(0, 21) + '...' : item.title,
            description: item.description ? item.description.slice(0, 72) : item.description,
          })),
        }))
      : [{
          title: truncatedTitle,
          rows: msg.items.map(item => ({
            id: item.postbackText,
            title: item.title.length > 24 ? item.title.slice(0, 21) + '...' : item.title,
            description: item.description ? item.description.slice(0, 72) : item.description,
          })),
        }];

    const result = await withRetry(() => this.cloud.sendList({
      to: msg.to,
      headerText: truncatedTitle,
      bodyText: truncatedBody,
      buttonText: truncatedButtonLabel,
      sections,
    }));
    return { success: true, messageId: result.messageId };
  }

  async sendButtons(msg: {
    to: string;
    body: string;
    buttons: Array<{ id: string; title: string }>;
  }) {
    // Enforce WhatsApp API limits: body 1024 chars, button title 20 chars
    const result = await withRetry(() => this.cloud.sendButtons({
      to: msg.to,
      bodyText: msg.body.slice(0, 1024),
      buttons: msg.buttons.map(b => ({ id: b.id, title: b.title.slice(0, 20) })),
    }));
    return { success: true, messageId: result.messageId };
  }

  async sendImage(msg: {
    to: string;
    imageUrl: string;
    caption?: string;
  }) {
    const result = await withRetry(() => this.cloud.sendImage({
      to: msg.to,
      imageUrl: msg.imageUrl,
      caption: msg.caption,
    }));
    return { success: true, messageId: result.messageId };
  }

  async sendDocument(msg: {
    to: string;
    documentUrl: string;
    filename: string;
    caption?: string;
  }) {
    const result = await withRetry(() => this.cloud.sendDocument({
      to: msg.to,
      documentUrl: msg.documentUrl,
      filename: msg.filename,
      caption: msg.caption,
    }));
    return { success: true, messageId: result.messageId };
  }

  async sendAudio(msg: {
    to: string;
    audioUrl: string;
  }) {
    const result = await withRetry(() => this.cloud.sendAudio({
      to: msg.to,
      audioUrl: msg.audioUrl,
    }));
    return { success: true, messageId: result.messageId };
  }

  async sendTemplate(msg: {
    to: string;
    templateName: string;
    templateParams: string[];
    buttonParams?: string[];
  }) {
    const components: Array<{ type: 'body' | 'button'; parameters: Array<{ type: 'text'; text: string }>; sub_type?: string; index?: number }> = [{
      type: 'body' as const,
      parameters: msg.templateParams.map(p => ({ type: 'text' as const, text: p })),
    }];

    // Add button parameters (for URL buttons with dynamic suffix)
    if (msg.buttonParams?.length) {
      msg.buttonParams.forEach((param, index) => {
        components.push({
          type: 'button' as const,
          sub_type: 'url',
          index,
          parameters: [{ type: 'text' as const, text: param }],
        });
      });
    }

    const result = await withRetry(() => this.cloud.sendTemplate({
      to: msg.to,
      templateName: msg.templateName,
      components,
    }));
    return { success: true, messageId: result.messageId };
  }

  async sendFlow(msg: {
    to: string;
    bodyText: string;
    flowId: string;
    flowCta: string;
    screen: string;
    flowToken?: string;
    data?: Record<string, unknown>;
  }) {
    const result = await withRetry(() => this.cloud.sendFlow(msg));
    return { success: true, messageId: result.messageId };
  }

  async sendReaction(msg: { to: string; messageId: string; emoji: string }) {
    const result = await withRetry(() => this.cloud.sendReaction(msg));
    return { success: true, messageId: result.messageId };
  }

  async sendLocation(msg: { to: string; latitude: number; longitude: number; name?: string; address?: string }) {
    const result = await withRetry(() => this.cloud.sendLocation(msg));
    return { success: true, messageId: result.messageId };
  }
}
