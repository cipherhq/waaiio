/**
 * Meta WhatsApp Cloud API Service
 *
 * Direct integration with Meta's WhatsApp Cloud API
 * for businesses that connect their own WhatsApp number.
 * Replaces Gupshup for "transfer" and "coexist" connection methods.
 *
 * Docs: https://developers.facebook.com/docs/whatsapp/cloud-api
 */

export interface MetaCloudCredentials {
  accessToken: string;
  phoneNumberId: string;
  wabaId?: string;
}

export interface CloudTextMessage {
  to: string;
  text: string;
}

export interface CloudTemplateMessage {
  to: string;
  templateName: string;
  languageCode?: string;
  components?: Array<{
    type: 'header' | 'body' | 'button';
    parameters: Array<{ type: 'text'; text: string }>;
  }>;
}

export interface CloudInteractiveListMessage {
  to: string;
  headerText?: string;
  bodyText: string;
  footerText?: string;
  buttonText: string;
  sections: Array<{
    title: string;
    rows: Array<{ id: string; title: string; description?: string }>;
  }>;
}

export interface CloudInteractiveButtonMessage {
  to: string;
  bodyText: string;
  buttons: Array<{ id: string; title: string }>;
}

export interface CloudImageMessage {
  to: string;
  imageUrl: string;
  caption?: string;
}

export interface CloudDocumentMessage {
  to: string;
  documentUrl: string;
  filename: string;
  caption?: string;
}

interface CloudApiResponse {
  messaging_product: string;
  contacts: Array<{ input: string; wa_id: string }>;
  messages: Array<{ id: string }>;
}

export class MetaCloudService {
  private readonly accessToken: string;
  private readonly phoneNumberId: string;
  private readonly wabaId: string;
  private readonly baseUrl = 'https://graph.facebook.com/v21.0';

  constructor(credentials?: MetaCloudCredentials) {
    this.accessToken = credentials?.accessToken || process.env.META_CLOUD_ACCESS_TOKEN || '';
    this.phoneNumberId = credentials?.phoneNumberId || process.env.META_CLOUD_PHONE_NUMBER_ID || '';
    this.wabaId = credentials?.wabaId || process.env.META_CLOUD_WABA_ID || '';
  }

  // ── Send Text Message ──

  async sendText(message: CloudTextMessage): Promise<{ messageId: string }> {
    const response = await this.callApi(`/${this.phoneNumberId}/messages`, {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: message.to,
      type: 'text',
      text: { preview_url: false, body: message.text },
    });
    return { messageId: response.messages[0].id };
  }

  // ── Send Template Message ──

  async sendTemplate(message: CloudTemplateMessage): Promise<{ messageId: string }> {
    const response = await this.callApi(`/${this.phoneNumberId}/messages`, {
      messaging_product: 'whatsapp',
      to: message.to,
      type: 'template',
      template: {
        name: message.templateName,
        language: { code: message.languageCode || 'en' },
        components: message.components || [],
      },
    });
    return { messageId: response.messages[0].id };
  }

  // ── Send Interactive List ──

  async sendList(message: CloudInteractiveListMessage): Promise<{ messageId: string }> {
    const interactive: Record<string, unknown> = {
      type: 'list',
      body: { text: message.bodyText },
      action: {
        button: message.buttonText,
        sections: message.sections,
      },
    };
    if (message.headerText) interactive.header = { type: 'text', text: message.headerText };
    if (message.footerText) interactive.footer = { text: message.footerText };

    const response = await this.callApi(`/${this.phoneNumberId}/messages`, {
      messaging_product: 'whatsapp',
      to: message.to,
      type: 'interactive',
      interactive,
    });
    return { messageId: response.messages[0].id };
  }

  // ── Send Interactive Buttons ──

  async sendButtons(message: CloudInteractiveButtonMessage): Promise<{ messageId: string }> {
    const response = await this.callApi(`/${this.phoneNumberId}/messages`, {
      messaging_product: 'whatsapp',
      to: message.to,
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: message.bodyText },
        action: {
          buttons: message.buttons.map((b) => ({
            type: 'reply',
            reply: { id: b.id, title: b.title },
          })),
        },
      },
    });
    return { messageId: response.messages[0].id };
  }

  // ── Send Image Message ──

  async sendImage(message: CloudImageMessage): Promise<{ messageId: string }> {
    const response = await this.callApi(`/${this.phoneNumberId}/messages`, {
      messaging_product: 'whatsapp',
      to: message.to,
      type: 'image',
      image: {
        link: message.imageUrl,
        caption: message.caption || undefined,
      },
    });
    return { messageId: response.messages[0].id };
  }

  // ── Send Document Message ──

  async sendDocument(message: CloudDocumentMessage): Promise<{ messageId: string }> {
    const response = await this.callApi(`/${this.phoneNumberId}/messages`, {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: message.to,
      type: 'document',
      document: {
        link: message.documentUrl,
        filename: message.filename,
        caption: message.caption || undefined,
      },
    });
    return { messageId: response.messages[0].id };
  }

  // ── Mark Message as Read ──

  async markAsRead(messageId: string): Promise<void> {
    await this.callApi(`/${this.phoneNumberId}/messages`, {
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: messageId,
    });
  }

  // ── Get Phone Number Info ──

  async getPhoneNumberInfo(): Promise<{
    verified_name: string;
    display_phone_number: string;
    quality_rating: string;
    messaging_limit: string;
  }> {
    const res = await fetch(
      `${this.baseUrl}/${this.phoneNumberId}?fields=verified_name,display_phone_number,quality_rating,platform_type,messaging_limit_tier`,
      { headers: { Authorization: `Bearer ${this.accessToken}` } }
    );
    if (!res.ok) throw new Error(`Failed to get phone info: ${res.status}`);
    return res.json();
  }

  // ── Get WABA Info ──

  async getWabaInfo(): Promise<{
    id: string;
    name: string;
    currency: string;
    message_template_namespace: string;
  }> {
    const res = await fetch(
      `${this.baseUrl}/${this.wabaId}?fields=id,name,currency,message_template_namespace`,
      { headers: { Authorization: `Bearer ${this.accessToken}` } }
    );
    if (!res.ok) throw new Error(`Failed to get WABA info: ${res.status}`);
    return res.json();
  }

  // ── Exchange short-lived token for long-lived token ──

  static async exchangeToken(shortLivedToken: string): Promise<{
    access_token: string;
    token_type: string;
    expires_in: number;
  }> {
    const appId = process.env.META_APP_ID || '';
    const appSecret = process.env.META_APP_SECRET || '';
    const res = await fetch(
      `https://graph.facebook.com/v21.0/oauth/access_token?grant_type=fb_exchange_token&client_id=${appId}&client_secret=${appSecret}&fb_exchange_token=${shortLivedToken}`
    );
    if (!res.ok) throw new Error(`Token exchange failed: ${res.status}`);
    return res.json();
  }

  // ── Get shared WABA phone numbers ──

  async getPhoneNumbers(): Promise<Array<{
    id: string;
    verified_name: string;
    display_phone_number: string;
    quality_rating: string;
  }>> {
    const res = await fetch(
      `${this.baseUrl}/${this.wabaId}/phone_numbers?fields=id,verified_name,display_phone_number,quality_rating`,
      { headers: { Authorization: `Bearer ${this.accessToken}` } }
    );
    if (!res.ok) throw new Error(`Failed to get phone numbers: ${res.status}`);
    const data = await res.json();
    return data.data;
  }

  // ── Register a phone number for Cloud API ──

  async registerPhoneNumber(pin: string = '000000'): Promise<{ success: boolean }> {
    const res = await fetch(
      `${this.baseUrl}/${this.phoneNumberId}/register`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          pin,
        }),
      }
    );
    if (!res.ok) throw new Error(`Failed to register phone: ${res.status}`);
    return res.json();
  }

  // ── Private: API Call Helper ──

  private async callApi(endpoint: string, body: Record<string, unknown>): Promise<CloudApiResponse> {
    const res = await fetch(`${this.baseUrl}${endpoint}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errorData = await res.json().catch(() => ({}));
      const errorMessage = errorData?.error?.message || `Cloud API error: ${res.status}`;
      throw new Error(errorMessage);
    }

    return res.json();
  }
}
