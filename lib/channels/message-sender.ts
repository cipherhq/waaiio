/**
 * Unified MessageSender interface
 *
 * Both GupshupService (shared numbers) and MetaCloudService (dedicated numbers)
 * are wrapped behind this common interface so the bot doesn't need to know
 * which provider is handling the message.
 */

import { MetaCloudService } from './meta-cloud';

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
  }): Promise<{ success?: boolean; messageId?: string }>;
  sendFlow?(msg: {
    to: string;
    bodyText: string;
    flowId: string;
    flowCta: string;
    screen: string;
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
    const result = await this.cloud.sendText({ to: msg.to, text: msg.text });
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
    const sections = msg.sections
      ? msg.sections.map(s => ({
          title: s.title,
          rows: s.items.map(item => ({
            id: item.postbackText,
            title: item.title,
            description: item.description,
          })),
        }))
      : [{
          title: msg.title,
          rows: msg.items.map(item => ({
            id: item.postbackText,
            title: item.title,
            description: item.description,
          })),
        }];

    const result = await this.cloud.sendList({
      to: msg.to,
      headerText: msg.title,
      bodyText: msg.body,
      buttonText: msg.buttonLabel,
      sections,
    });
    return { success: true, messageId: result.messageId };
  }

  async sendButtons(msg: {
    to: string;
    body: string;
    buttons: Array<{ id: string; title: string }>;
  }) {
    const result = await this.cloud.sendButtons({
      to: msg.to,
      bodyText: msg.body,
      buttons: msg.buttons,
    });
    return { success: true, messageId: result.messageId };
  }

  async sendImage(msg: {
    to: string;
    imageUrl: string;
    caption?: string;
  }) {
    const result = await this.cloud.sendImage({
      to: msg.to,
      imageUrl: msg.imageUrl,
      caption: msg.caption,
    });
    return { success: true, messageId: result.messageId };
  }

  async sendDocument(msg: {
    to: string;
    documentUrl: string;
    filename: string;
    caption?: string;
  }) {
    const result = await this.cloud.sendDocument({
      to: msg.to,
      documentUrl: msg.documentUrl,
      filename: msg.filename,
      caption: msg.caption,
    });
    return { success: true, messageId: result.messageId };
  }

  async sendAudio(msg: {
    to: string;
    audioUrl: string;
  }) {
    const result = await this.cloud.sendAudio({
      to: msg.to,
      audioUrl: msg.audioUrl,
    });
    return { success: true, messageId: result.messageId };
  }

  async sendTemplate(msg: {
    to: string;
    templateName: string;
    templateParams: string[];
  }) {
    const result = await this.cloud.sendTemplate({
      to: msg.to,
      templateName: msg.templateName,
      components: [{
        type: 'body' as const,
        parameters: msg.templateParams.map(p => ({ type: 'text' as const, text: p })),
      }],
    });
    return { success: true, messageId: result.messageId };
  }

  async sendFlow(msg: {
    to: string;
    bodyText: string;
    flowId: string;
    flowCta: string;
    screen: string;
    data?: Record<string, unknown>;
  }) {
    const result = await this.cloud.sendFlow(msg);
    return { success: true, messageId: result.messageId };
  }

  async sendReaction(msg: { to: string; messageId: string; emoji: string }) {
    const result = await this.cloud.sendReaction(msg);
    return { success: true, messageId: result.messageId };
  }

  async sendLocation(msg: { to: string; latitude: number; longitude: number; name?: string; address?: string }) {
    const result = await this.cloud.sendLocation(msg);
    return { success: true, messageId: result.messageId };
  }
}
