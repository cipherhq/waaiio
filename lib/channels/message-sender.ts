/**
 * Unified MessageSender interface
 *
 * MetaCloudService is wrapped behind this common interface so the bot
 * doesn't need to know the details of the underlying provider.
 */

import { MetaCloudService } from './meta-cloud';
import { isCircuitOpen, recordSuccess, recordFailure, CircuitBreakerOpenError } from '@/lib/circuit-breaker';
import { assertMessagingAllowed } from '@/lib/channels/send-guard';

// Suspension detection for retry logic — uses message-based matching
// rather than instanceof to work correctly when send-guard is mocked in tests

const CIRCUIT_KEY = 'meta-cloud';

async function withRetry<T>(
  fn: () => Promise<T>,
  retries = 2,
  delay = 1000,
  /** Optional guard called before each attempt (including retries).
   *  Throw to abort the retry loop — e.g. deadline-exceeded. */
  beforeEachAttempt?: () => void,
): Promise<T> {
  // Check circuit breaker before attempting any call
  if (isCircuitOpen(CIRCUIT_KEY)) {
    throw new CircuitBreakerOpenError(CIRCUIT_KEY);
  }

  for (let i = 0; i <= retries; i++) {
    // Deadline/ownership guard — checked before each provider attempt
    if (beforeEachAttempt) beforeEachAttempt();

    try {
      const result = await fn();
      recordSuccess(CIRCUIT_KEY);
      return result;
    } catch (err) {
      // Don't retry client errors (4xx) — they won't succeed on retry.
      // Meta Cloud API errors include the HTTP status in the message (e.g. "Cloud API error: 400").
      const errMsg = err instanceof Error ? err.message : String(err);
      const is4xx = /\b4\d{2}\b/.test(errMsg);
      const isSuspended = (err instanceof Error && err.message.includes('Messaging suspended'))
        || (err instanceof Error && err.message.includes('missing_business_id'));

      // Only record failure for server errors (5xx) or network errors, not client errors or suspensions
      if (!is4xx && !isSuspended) {
        recordFailure(CIRCUIT_KEY);
      }

      // Don't retry: client errors, suspension blocks, or last attempt
      if (is4xx || isSuspended || i === retries) throw err;
      await new Promise(r => setTimeout(r, delay * (i + 1)));
    }
  }
  throw new Error('Retry exhausted');
}

export interface MessageSender {
  /**
   * S-1 (#256): Platform-scoped text send. Bypasses business hard-stop guard.
   * ONLY for pre-business Waaiio/platform sends on shared channels (greetings,
   * business pickers, STOP/START acknowledgements, abuse warnings, guidance).
   * Must NOT be used for tenant business messages, transactions, reminders,
   * campaigns, or any business-attributable send.
   */
  sendPlatformText?(msg: { to: string; text: string }): Promise<{ success?: boolean; messageId?: string }>;
  sendPlatformButtons?(msg: { to: string; body: string; buttons: Array<{ id: string; title: string }>; footer?: string }): Promise<{ success?: boolean; messageId?: string }>;
  /** S-1 (#256): Bind a resolved business to this sender for hard-stop guard. */
  bindBusiness?(businessId: string): void;
  /** S-1 (#256): Transition to tenantless platform discovery scope. */
  enterPlatformDiscovery?(): void;
  /** S-1 (#256): Read the currently bound business identity. */
  readonly boundBusinessId?: string;
  sendText(msg: { to: string; text: string; noRetry?: boolean }): Promise<{ success?: boolean; messageId?: string }>;
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
    footer?: string;
  }): Promise<{ success?: boolean; messageId?: string }>;
  sendButtons(msg: {
    to: string;
    body: string;
    buttons: Array<{ id: string; title: string }>;
    footer?: string;
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
    noRetry?: boolean;
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
  sendProduct?(msg: {
    to: string;
    catalogId: string;
    productRetailerId: string;
    body?: string;
    footer?: string;
  }): Promise<{ success?: boolean; messageId?: string }>;
  sendProductList?(msg: {
    to: string;
    catalogId: string;
    header: string;
    body: string;
    footer?: string;
    sections: Array<{ title: string; productRetailerIds: string[] }>;
  }): Promise<{ success?: boolean; messageId?: string }>;
}

/**
 * Adapter that wraps MetaCloudService into the MessageSender interface
 * so it conforms to the unified MessageSender interface.
 */
export class MetaCloudSender implements MessageSender {
  /** Optional per-attempt guard (e.g. deadline check) — called before each provider attempt including retries. */
  beforeEachAttempt?: () => void;

  /**
   * S-1 (#256): Private business identity for the hard-stop guard.
   * Only modifiable through bindBusiness() and enterPlatformDiscovery().
   */
  private _businessId: string;

  constructor(private readonly cloud: MetaCloudService) {
    this._businessId = '';
  }

  /** Read-only access to the current business identity for diagnostics/tests. */
  get boundBusinessId(): string { return this._businessId; }

  /**
   * Bind a resolved business identity to this sender.
   * Once bound, ALL sends (including platform-scoped) check the hard-stop guard.
   * Call this when BotService resolves/resumes/switches tenant.
   */
  bindBusiness(businessId: string): void {
    if (businessId) this._businessId = businessId;
  }

  /**
   * Explicitly transition to platform discovery scope (tenantless).
   * Clears the bound business so platform sends can proceed without
   * the business hard-stop guard. Used when BotService transitions
   * from a known tenant to neutral business discovery (switch_biz,
   * home command, session deactivation).
   *
   * NOT a generic guard bypass — after this, business-scoped sends
   * still fail closed on missing businessId. A new tenant must be
   * bound via bindBusiness() before business-scoped sends work.
   */
  enterPlatformDiscovery(): void {
    this._businessId = '';
  }

  // ── Platform-scoped sends (S-1 #256) ──
  // SCOPE-AWARE: if a business is bound, the guard is checked.
  // Only genuinely tenantless (_businessId='') skips the guard.

  async sendPlatformText(msg: { to: string; text: string }) {
    const result = await withRetry(async () => {
      if (this._businessId) {
        await assertMessagingAllowed(this._businessId);
        if (this.beforeEachAttempt) this.beforeEachAttempt(); // post-auth final deadline
      }
      return this.cloud.sendText({ to: msg.to, text: msg.text });
    }, 2, 1000, this.beforeEachAttempt);
    return { success: true, messageId: result.messageId };
  }

  async sendPlatformButtons(msg: { to: string; body: string; buttons: Array<{ id: string; title: string }>; footer?: string }) {
    const result = await withRetry(async () => {
      if (this._businessId) {
        await assertMessagingAllowed(this._businessId);
        if (this.beforeEachAttempt) this.beforeEachAttempt(); // post-auth final deadline
      }
      return this.cloud.sendButtons({
        to: msg.to, bodyText: msg.body.slice(0, 1024),
        footerText: msg.footer ? msg.footer.slice(0, 60) : undefined,
        buttons: msg.buttons.map(b => ({ id: b.id, title: b.title.slice(0, 20) })),
      });
    }, 2, 1000, this.beforeEachAttempt);
    return { success: true, messageId: result.messageId };
  }

  // ── Business-scoped sends — require business identity, fail-closed ──

  async sendText(msg: { to: string; text: string; noRetry?: boolean }) {
    // Both guards fire before EVERY provider attempt (including noRetry).
    // Order: deadline → authorization (async) → FINAL deadline → provider call.
    // The final deadline check catches expiry during async authorization.
    const textCall = async () => {
      if (this.beforeEachAttempt) this.beforeEachAttempt(); // #279 pre-auth deadline
      await assertMessagingAllowed(this._businessId);        // #256 hard-stop (async)
      if (this.beforeEachAttempt) this.beforeEachAttempt(); // #279 post-auth final deadline
      return this.cloud.sendText({ to: msg.to, text: msg.text });
    };
    const result = msg.noRetry ? await textCall() : await withRetry(textCall, 2, 1000, this.beforeEachAttempt);
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
    footer?: string;
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

    const result = await withRetry(async () => { await assertMessagingAllowed(this._businessId); if (this.beforeEachAttempt) this.beforeEachAttempt(); return this.cloud.sendList({
      to: msg.to,
      headerText: truncatedTitle,
      bodyText: truncatedBody,
      footerText: msg.footer ? msg.footer.slice(0, 60) : undefined,
      buttonText: truncatedButtonLabel,
      sections,
    }); }, 2, 1000, this.beforeEachAttempt);
    return { success: true, messageId: result.messageId };
  }

  async sendButtons(msg: {
    to: string;
    body: string;
    buttons: Array<{ id: string; title: string }>;
    footer?: string;
  }) {
    // Enforce WhatsApp API limits: body 1024 chars, button title 20 chars
    const result = await withRetry(async () => { await assertMessagingAllowed(this._businessId); if (this.beforeEachAttempt) this.beforeEachAttempt(); return this.cloud.sendButtons({
      to: msg.to,
      bodyText: msg.body.slice(0, 1024),
      footerText: msg.footer ? msg.footer.slice(0, 60) : undefined,
      buttons: msg.buttons.map(b => ({ id: b.id, title: b.title.slice(0, 20) })),
    }); }, 2, 1000, this.beforeEachAttempt);
    return { success: true, messageId: result.messageId };
  }

  async sendImage(msg: { to: string; imageUrl: string; caption?: string }) {
    const result = await withRetry(async () => { await assertMessagingAllowed(this._businessId); if (this.beforeEachAttempt) this.beforeEachAttempt(); return this.cloud.sendImage({ to: msg.to, imageUrl: msg.imageUrl, caption: msg.caption }); }, 2, 1000, this.beforeEachAttempt);
    return { success: true, messageId: result.messageId };
  }

  async sendDocument(msg: { to: string; documentUrl: string; filename: string; caption?: string }) {
    const result = await withRetry(async () => { await assertMessagingAllowed(this._businessId); if (this.beforeEachAttempt) this.beforeEachAttempt(); return this.cloud.sendDocument({ to: msg.to, documentUrl: msg.documentUrl, filename: msg.filename, caption: msg.caption }); }, 2, 1000, this.beforeEachAttempt);
    return { success: true, messageId: result.messageId };
  }

  async sendAudio(msg: { to: string; audioUrl: string }) {
    const result = await withRetry(async () => { await assertMessagingAllowed(this._businessId); if (this.beforeEachAttempt) this.beforeEachAttempt(); return this.cloud.sendAudio({ to: msg.to, audioUrl: msg.audioUrl }); }, 2, 1000, this.beforeEachAttempt);
    return { success: true, messageId: result.messageId };
  }

  async sendTemplate(msg: {
    to: string;
    templateName: string;
    templateParams: string[];
    buttonParams?: string[];
    /** Skip automatic retry for delivery-critical sends where ambiguous outcomes must not produce duplicate provider POSTs */
    noRetry?: boolean;
  }) {
    const components: Array<{ type: 'body' | 'button'; parameters: Array<{ type: 'text'; text: string }>; sub_type?: string; index?: number }> = [{
      type: 'body' as const,
      parameters: msg.templateParams.map(p => ({ type: 'text' as const, text: p })),
    }];
    // Add button parameters (for URL buttons with dynamic suffix)
    if (msg.buttonParams?.length) {
      msg.buttonParams.forEach((param, index) => {
        components.push({ type: 'button' as const, sub_type: 'url', index, parameters: [{ type: 'text' as const, text: param }] });
      });
    }
    const templateCall = async () => {
      if (this.beforeEachAttempt) this.beforeEachAttempt(); // #279 pre-auth deadline
      await assertMessagingAllowed(this._businessId);        // #256 hard-stop (async)
      if (this.beforeEachAttempt) this.beforeEachAttempt(); // #279 post-auth final deadline
      return this.cloud.sendTemplate({ to: msg.to, templateName: msg.templateName, components });
    };
    const result = msg.noRetry ? await templateCall() : await withRetry(templateCall, 2, 1000, this.beforeEachAttempt);
    return { success: true, messageId: result.messageId };
  }

  async sendFlow(msg: { to: string; bodyText: string; flowId: string; flowCta: string; screen: string; flowToken?: string; data?: Record<string, unknown> }) {
    const result = await withRetry(async () => { await assertMessagingAllowed(this._businessId); if (this.beforeEachAttempt) this.beforeEachAttempt(); return this.cloud.sendFlow(msg); }, 2, 1000, this.beforeEachAttempt);
    return { success: true, messageId: result.messageId };
  }

  async sendReaction(msg: { to: string; messageId: string; emoji: string }) {
    const result = await withRetry(async () => { await assertMessagingAllowed(this._businessId); if (this.beforeEachAttempt) this.beforeEachAttempt(); return this.cloud.sendReaction(msg); }, 2, 1000, this.beforeEachAttempt);
    return { success: true, messageId: result.messageId };
  }

  async sendLocation(msg: { to: string; latitude: number; longitude: number; name?: string; address?: string }) {
    const result = await withRetry(async () => { await assertMessagingAllowed(this._businessId); if (this.beforeEachAttempt) this.beforeEachAttempt(); return this.cloud.sendLocation(msg); }, 2, 1000, this.beforeEachAttempt);
    return { success: true, messageId: result.messageId };
  }

  async sendProduct(msg: { to: string; catalogId: string; productRetailerId: string; body?: string; footer?: string }) {
    const result = await withRetry(async () => { await assertMessagingAllowed(this._businessId); if (this.beforeEachAttempt) this.beforeEachAttempt(); return this.cloud.sendProduct({ to: msg.to, catalogId: msg.catalogId, productId: msg.productRetailerId, body: msg.body, footer: msg.footer }); }, 2, 1000, this.beforeEachAttempt);
    return { success: true, messageId: result.messageId };
  }

  async sendProductList(msg: { to: string; catalogId: string; header: string; body: string; footer?: string; sections: Array<{ title: string; productRetailerIds: string[] }> }) {
    const result = await withRetry(async () => { await assertMessagingAllowed(this._businessId); if (this.beforeEachAttempt) this.beforeEachAttempt(); return this.cloud.sendProductList({ to: msg.to, catalogId: msg.catalogId, headerText: msg.header, bodyText: msg.body, footerText: msg.footer, sections: msg.sections.map(s => ({ title: s.title, productIds: s.productRetailerIds })) }); }, 2, 1000, this.beforeEachAttempt);
    return { success: true, messageId: result.messageId };
  }
}
