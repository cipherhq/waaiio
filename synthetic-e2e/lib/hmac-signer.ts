/**
 * HMAC signer for synthetic WhatsApp webhook requests.
 *
 * Generates the same X-Hub-Signature-256 header that Meta Cloud API sends
 * on real webhook deliveries. This allows synthetic inbound messages to
 * pass the signature verification in app/api/webhook/meta-cloud/route.ts.
 *
 * The signing secret must be the staging META_APP_SECRET.
 * Issue #728 safety gate: Only staging secrets are accepted.
 */

import { createHmac } from 'crypto';

/**
 * Compute the X-Hub-Signature-256 header value for a webhook payload.
 *
 * Meta's format: `sha256=<hex-digest>`
 * See: https://developers.facebook.com/docs/graph-api/webhooks/getting-started#event-notifications
 */
export function signWebhookPayload(payload: string, secret: string): string {
  const hmac = createHmac('sha256', secret);
  hmac.update(payload, 'utf-8');
  return `sha256=${hmac.digest('hex')}`;
}

/**
 * Build a complete Meta Cloud API webhook payload for an inbound text message.
 *
 * Format matches the real Meta webhook payload structure:
 * https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks/components
 */
export function buildTextMessagePayload(params: {
  from: string;         // Sender phone number (synthetic, e.g., '15550001234')
  to: string;           // Recipient phone number ID (the business number)
  text: string;         // Message text
  messageId?: string;   // Optional message ID (auto-generated if omitted)
  timestamp?: number;   // Unix timestamp (defaults to now)
  phoneNumberId?: string; // Phone number ID (defaults to `to`)
  wabaId?: string;      // WABA ID
}): string {
  const messageId = params.messageId || `wamid.synth_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  const timestamp = params.timestamp || Math.floor(Date.now() / 1000);
  const phoneNumberId = params.phoneNumberId || params.to;

  const payload = {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: params.wabaId || 'SYNTH_WABA_ID',
        changes: [
          {
            value: {
              messaging_product: 'whatsapp',
              metadata: {
                display_phone_number: params.to,
                phone_number_id: phoneNumberId,
              },
              contacts: [
                {
                  profile: { name: `Synthetic Customer ${params.from.slice(-4)}` },
                  wa_id: params.from,
                },
              ],
              messages: [
                {
                  from: params.from,
                  id: messageId,
                  timestamp: String(timestamp),
                  text: { body: params.text },
                  type: 'text',
                },
              ],
            },
            field: 'messages',
          },
        ],
      },
    ],
  };

  return JSON.stringify(payload);
}

/**
 * Build a complete Meta Cloud API webhook payload for a button reply.
 */
export function buildButtonReplyPayload(params: {
  from: string;
  to: string;
  buttonId: string;
  buttonTitle: string;
  messageId?: string;
  timestamp?: number;
  phoneNumberId?: string;
  wabaId?: string;
}): string {
  const messageId = params.messageId || `wamid.synth_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  const timestamp = params.timestamp || Math.floor(Date.now() / 1000);
  const phoneNumberId = params.phoneNumberId || params.to;

  const payload = {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: params.wabaId || 'SYNTH_WABA_ID',
        changes: [
          {
            value: {
              messaging_product: 'whatsapp',
              metadata: {
                display_phone_number: params.to,
                phone_number_id: phoneNumberId,
              },
              contacts: [
                {
                  profile: { name: `Synthetic Customer ${params.from.slice(-4)}` },
                  wa_id: params.from,
                },
              ],
              messages: [
                {
                  from: params.from,
                  id: messageId,
                  timestamp: String(timestamp),
                  type: 'interactive',
                  interactive: {
                    type: 'button_reply',
                    button_reply: {
                      id: params.buttonId,
                      title: params.buttonTitle,
                    },
                  },
                },
              ],
            },
            field: 'messages',
          },
        ],
      },
    ],
  };

  return JSON.stringify(payload);
}

/**
 * Build a complete Meta Cloud API webhook payload for a list reply.
 */
export function buildListReplyPayload(params: {
  from: string;
  to: string;
  listId: string;
  listTitle: string;
  listDescription?: string;
  messageId?: string;
  timestamp?: number;
  phoneNumberId?: string;
  wabaId?: string;
}): string {
  const messageId = params.messageId || `wamid.synth_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  const timestamp = params.timestamp || Math.floor(Date.now() / 1000);
  const phoneNumberId = params.phoneNumberId || params.to;

  const payload = {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: params.wabaId || 'SYNTH_WABA_ID',
        changes: [
          {
            value: {
              messaging_product: 'whatsapp',
              metadata: {
                display_phone_number: params.to,
                phone_number_id: phoneNumberId,
              },
              contacts: [
                {
                  profile: { name: `Synthetic Customer ${params.from.slice(-4)}` },
                  wa_id: params.from,
                },
              ],
              messages: [
                {
                  from: params.from,
                  id: messageId,
                  timestamp: String(timestamp),
                  type: 'interactive',
                  interactive: {
                    type: 'list_reply',
                    list_reply: {
                      id: params.listId,
                      title: params.listTitle,
                      description: params.listDescription || '',
                    },
                  },
                },
              ],
            },
            field: 'messages',
          },
        ],
      },
    ],
  };

  return JSON.stringify(payload);
}

/**
 * Create a signed webhook request ready to POST.
 * Returns the body string and headers including X-Hub-Signature-256.
 */
export function createSignedWebhookRequest(
  payload: string,
  secret: string,
): { body: string; headers: Record<string, string> } {
  return {
    body: payload,
    headers: {
      'Content-Type': 'application/json',
      'X-Hub-Signature-256': signWebhookPayload(payload, secret),
    },
  };
}
