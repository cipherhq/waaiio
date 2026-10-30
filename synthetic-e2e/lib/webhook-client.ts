/**
 * Webhook client for sending synthetic inbound WhatsApp messages.
 *
 * CTO R3 Fix 3: FAIL-CLOSED — All remote send methods throw by default.
 * Remote webhook delivery to deployed staging is disabled until server-side
 * Meta interception is independently proven and separately authorized.
 *
 * The safe isolated BotService test runner (bot-test-harness.ts) does NOT
 * use this client — it invokes BotService.handleMessage directly with
 * CapturingMessageSender.
 */

import {
  signWebhookPayload,
  buildTextMessagePayload,
  buildButtonReplyPayload,
  buildListReplyPayload,
  createSignedWebhookRequest,
} from './hmac-signer';
import { assertStagingUrl } from './environment-guard';
import type { AuditLogger } from './audit-logger';

/**
 * FAIL-CLOSED: Throws unless remote webhook delivery has been
 * independently proven safe and explicitly authorized.
 */
function assertRemoteWebhookAuthorized(): void {
  throw new Error(
    'FAIL-CLOSED: Remote webhook delivery to deployed staging is disabled. ' +
    'Server-side Meta interception is not proven for remote Vercel targets. ' +
    'Use the isolated BotService test runner (bot-test-harness.ts) instead. ' +
    'Remote delivery requires separate CTO/Owner authorization.'
  );
}

// ── Types ──

export interface WebhookClientConfig {
  /** Staging base URL (validated) */
  baseUrl: string;
  /** META_APP_SECRET for HMAC signing */
  metaAppSecret: string;
  /** Phone number ID of the business */
  phoneNumberId: string;
  /** WABA ID */
  wabaId?: string;
  /** Optional audit logger for recording events */
  logger?: AuditLogger;
  /** Journey ID for event correlation */
  journeyId?: string;
}

export interface WebhookResponse {
  status: number;
  body: string;
  headers: Record<string, string>;
  durationMs: number;
}

// ── Client ──

export class WebhookClient {
  private config: WebhookClientConfig;
  private webhookUrl: string;
  private stepIndex = 0;

  constructor(config: WebhookClientConfig) {
    // Validate staging URL before any requests
    assertStagingUrl(config.baseUrl);
    this.config = config;
    this.webhookUrl = `${config.baseUrl.replace(/\/$/, '')}/api/webhook/meta-cloud`;
  }

  /**
   * Send a text message as a synthetic customer.
   * FAIL-CLOSED: Throws unless remote delivery is authorized.
   */
  async sendText(from: string, text: string): Promise<WebhookResponse> {
    assertRemoteWebhookAuthorized(); // CTO R3: fail-closed
    const payload = buildTextMessagePayload({
      from,
      to: this.config.phoneNumberId,
      text,
      phoneNumberId: this.config.phoneNumberId,
      wabaId: this.config.wabaId,
    });

    return this.sendWebhook(payload, { type: 'text', from, text });
  }

  /**
   * Send a button reply as a synthetic customer.
   * FAIL-CLOSED: Throws unless remote delivery is authorized.
   */
  async sendButtonReply(from: string, buttonId: string, buttonTitle: string): Promise<WebhookResponse> {
    assertRemoteWebhookAuthorized(); // CTO R3: fail-closed
    const payload = buildButtonReplyPayload({
      from,
      to: this.config.phoneNumberId,
      buttonId,
      buttonTitle,
      phoneNumberId: this.config.phoneNumberId,
      wabaId: this.config.wabaId,
    });

    return this.sendWebhook(payload, { type: 'button_reply', from, buttonId, buttonTitle });
  }

  /**
   * Send a list reply as a synthetic customer.
   * FAIL-CLOSED: Throws unless remote delivery is authorized.
   */
  async sendListReply(from: string, listId: string, listTitle: string): Promise<WebhookResponse> {
    assertRemoteWebhookAuthorized(); // CTO R3: fail-closed
    const payload = buildListReplyPayload({
      from,
      to: this.config.phoneNumberId,
      listId,
      listTitle,
      phoneNumberId: this.config.phoneNumberId,
      wabaId: this.config.wabaId,
    });

    return this.sendWebhook(payload, { type: 'list_reply', from, listId, listTitle });
  }

  /**
   * Internal: send a signed webhook request and record audit events.
   */
  private async sendWebhook(
    payload: string,
    meta: Record<string, unknown>,
  ): Promise<WebhookResponse> {
    const { body, headers } = createSignedWebhookRequest(payload, this.config.metaAppSecret);
    const currentStep = this.stepIndex++;

    // Log the send event
    this.config.logger?.log({
      runId: this.config.logger?.['runId'] || '',
      journeyId: this.config.journeyId || '',
      stepIndex: currentStep,
      eventType: 'webhook_send',
      data: {
        url: this.webhookUrl,
        ...meta,
        // Never log the full payload — it could contain synthetic but still sensitive data
        payloadSize: body.length,
      },
    });

    const start = Date.now();
    let response: Response;
    try {
      response = await fetch(this.webhookUrl, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(60_000), // Match Vercel maxDuration
      });
    } catch (err) {
      const durationMs = Date.now() - start;
      this.config.logger?.log({
        runId: this.config.logger?.['runId'] || '',
        journeyId: this.config.journeyId || '',
        stepIndex: currentStep,
        eventType: 'error',
        durationMs,
        data: { error: (err as Error).message, url: this.webhookUrl },
        outcome: 'FAIL',
      });
      throw err;
    }

    const durationMs = Date.now() - start;
    const responseBody = await response.text();

    // Log the response
    this.config.logger?.log({
      runId: this.config.logger?.['runId'] || '',
      journeyId: this.config.journeyId || '',
      stepIndex: currentStep,
      eventType: 'webhook_response',
      durationMs,
      data: {
        status: response.status,
        bodyLength: responseBody.length,
        // Truncate response body for logging
        bodyPreview: responseBody.slice(0, 200),
      },
      outcome: response.ok ? 'PASS' : 'FAIL',
    });

    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });

    return {
      status: response.status,
      body: responseBody,
      headers: responseHeaders,
      durationMs,
    };
  }

  /**
   * Wait for a bot reply by polling the capture transport.
   * For use when running against a local instance with capture transport.
   */
  async waitForReply(timeoutMs = 5000): Promise<void> {
    // In staging webhook mode, the reply is captured server-side.
    // This method is a no-op placeholder for the webhook-based flow
    // where we await the HTTP response (which includes the bot processing).
    await new Promise(resolve => setTimeout(resolve, Math.min(timeoutMs, 1000)));
  }
}
