/**
 * CapturingMessageSender — implements the real MessageSender interface
 * at the actual outbound boundary where BotService sends WhatsApp messages.
 *
 * CTO R1 Fix 1: This replaces MetaCloudSender in BotService, capturing
 * all outbound messages that the bot would normally send via Meta Cloud API.
 * Zero real Meta API calls are made.
 *
 * This is NOT a client-side utility — it is injected into BotService's
 * constructor as the `messageSender` parameter, which means it sits at
 * the exact same boundary as the real MetaCloudSender.
 */

import type { MessageSender } from '@/lib/channels/message-sender';

// ── Types ──

export type CapturedSend = {
  id: string;
  timestamp: string;
  method: string;
  to: string;
  content: unknown;
  journeyId?: string;
};

// ── Implementation ──

export class CapturingMessageSender implements MessageSender {
  private sends: CapturedSend[] = [];
  private _boundBusinessId = '';

  get boundBusinessId(): string {
    return this._boundBusinessId;
  }

  bindBusiness(businessId: string): void {
    if (businessId) this._boundBusinessId = businessId;
  }

  enterPlatformDiscovery(): void {
    this._boundBusinessId = '';
  }

  /** Get all captured sends */
  getCapturedSends(): CapturedSend[] {
    return [...this.sends];
  }

  /** Get the most recent captured send */
  getLastSend(): CapturedSend | undefined {
    return this.sends[this.sends.length - 1];
  }

  /** Get sends filtered by recipient */
  getSendsTo(to: string): CapturedSend[] {
    return this.sends.filter(s => s.to === to);
  }

  /** Clear all captured sends */
  reset(): void {
    this.sends = [];
    this._boundBusinessId = '';
  }

  private capture(method: string, to: string, content: unknown): CapturedSend {
    const send: CapturedSend = {
      id: `csend_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      timestamp: new Date().toISOString(),
      method,
      to,
      content,
    };
    this.sends.push(send);
    return send;
  }

  private result(send: CapturedSend) {
    return { success: true, messageId: `wamid.synth_captured_${send.id}` };
  }

  // ── Platform-scoped sends ──

  async sendPlatformText(msg: { to: string; text: string }) {
    return this.result(this.capture('sendPlatformText', msg.to, { text: msg.text }));
  }

  async sendPlatformButtons(msg: { to: string; body: string; buttons: Array<{ id: string; title: string }>; footer?: string }) {
    return this.result(this.capture('sendPlatformButtons', msg.to, { body: msg.body, buttons: msg.buttons, footer: msg.footer }));
  }

  async sendPlatformList(msg: {
    to: string; title: string; body: string; buttonLabel: string;
    items: Array<{ title: string; description?: string; postbackText: string }>;
    footer?: string;
  }) {
    return this.result(this.capture('sendPlatformList', msg.to, { title: msg.title, body: msg.body, items: msg.items, footer: msg.footer }));
  }

  // ── Business-scoped sends ──

  async sendText(msg: { to: string; text: string; noRetry?: boolean; messageCategory?: string }) {
    return this.result(this.capture('sendText', msg.to, { text: msg.text, messageCategory: msg.messageCategory }));
  }

  async sendList(msg: {
    to: string; title: string; body: string; buttonLabel: string;
    items: Array<{ title: string; description?: string; postbackText: string }>;
    sections?: Array<{ title: string; items: Array<{ title: string; description?: string; postbackText: string }> }>;
    footer?: string; messageCategory?: string;
  }) {
    return this.result(this.capture('sendList', msg.to, { title: msg.title, body: msg.body, items: msg.items, sections: msg.sections, footer: msg.footer }));
  }

  async sendButtons(msg: {
    to: string; body: string; buttons: Array<{ id: string; title: string }>;
    footer?: string; messageCategory?: string;
  }) {
    return this.result(this.capture('sendButtons', msg.to, { body: msg.body, buttons: msg.buttons, footer: msg.footer }));
  }

  async sendImage(msg: { to: string; imageUrl: string; caption?: string; messageCategory?: string }) {
    return this.result(this.capture('sendImage', msg.to, { imageUrl: msg.imageUrl, caption: msg.caption }));
  }

  async sendDocument(msg: { to: string; documentUrl: string; filename: string; caption?: string; messageCategory?: string }) {
    return this.result(this.capture('sendDocument', msg.to, { documentUrl: msg.documentUrl, filename: msg.filename, caption: msg.caption }));
  }

  async sendAudio(msg: { to: string; audioUrl: string; messageCategory?: string }) {
    return this.result(this.capture('sendAudio', msg.to, { audioUrl: msg.audioUrl }));
  }

  async sendTemplate(msg: {
    to: string; templateName: string; templateParams: string[];
    buttonParams?: string[]; noRetry?: boolean; messageCategory?: string;
  }) {
    return this.result(this.capture('sendTemplate', msg.to, { templateName: msg.templateName, params: msg.templateParams }));
  }

  async sendFlow(msg: {
    to: string; bodyText: string; flowId: string; flowCta: string;
    screen: string; flowToken?: string; data?: Record<string, unknown>; messageCategory?: string;
  }) {
    return this.result(this.capture('sendFlow', msg.to, { bodyText: msg.bodyText, flowId: msg.flowId }));
  }

  async sendReaction(msg: { to: string; messageId: string; emoji: string; messageCategory?: string }) {
    return this.result(this.capture('sendReaction', msg.to, { messageId: msg.messageId, emoji: msg.emoji }));
  }

  async sendLocation(msg: { to: string; latitude: number; longitude: number; name?: string; address?: string; messageCategory?: string }) {
    return this.result(this.capture('sendLocation', msg.to, { latitude: msg.latitude, longitude: msg.longitude, name: msg.name }));
  }

  async sendProduct(msg: { to: string; catalogId: string; productRetailerId: string; body?: string; footer?: string; messageCategory?: string }) {
    return this.result(this.capture('sendProduct', msg.to, { catalogId: msg.catalogId, productRetailerId: msg.productRetailerId }));
  }

  async sendProductList(msg: {
    to: string; catalogId: string; header: string; body: string; footer?: string;
    sections: Array<{ title: string; productRetailerIds: string[] }>; messageCategory?: string;
  }) {
    return this.result(this.capture('sendProductList', msg.to, { catalogId: msg.catalogId, header: msg.header, sections: msg.sections }));
  }
}
