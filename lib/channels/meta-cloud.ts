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
  footerText?: string;
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

// ── Template Types ──

export interface TemplateComponent {
  type: 'HEADER' | 'BODY' | 'FOOTER' | 'BUTTONS';
  format?: 'TEXT' | 'IMAGE' | 'VIDEO' | 'DOCUMENT';
  text?: string;
  example?: { header_text?: string[]; body_text?: string[][] };
  buttons?: Array<{
    type: 'PHONE_NUMBER' | 'URL' | 'QUICK_REPLY';
    text: string;
    phone_number?: string;
    url?: string;
    example?: string[];
  }>;
}

export interface MessageTemplate {
  id: string;
  name: string;
  status: 'APPROVED' | 'PENDING' | 'REJECTED' | 'PAUSED' | 'DISABLED';
  category: 'UTILITY' | 'MARKETING' | 'AUTHENTICATION';
  language: string;
  components: TemplateComponent[];
  quality_score?: { score: string };
}

export interface CreateTemplateInput {
  name: string;
  language: string;
  category: 'UTILITY' | 'MARKETING' | 'AUTHENTICATION';
  components: TemplateComponent[];
  allow_category_change?: boolean;
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
  private readonly baseUrl = `https://graph.facebook.com/${process.env.META_GRAPH_API_VERSION || 'v22.0'}`;

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
        language: { code: message.languageCode || 'en_US' },
        components: message.components || [],
      },
    });
    return { messageId: response.messages[0].id };
  }

  // ── Send Interactive List ──

  async sendList(message: CloudInteractiveListMessage): Promise<{ messageId: string }> {
    // Enforce Meta WhatsApp API limits to prevent #131009 parameter errors
    const safeSections = message.sections.slice(0, 10).map(section => ({
      ...section,
      rows: section.rows.slice(0, 10).map(row => ({
        ...row,
        title: row.title.slice(0, 24),
        description: row.description ? row.description.slice(0, 72) : undefined,
      })),
    }));

    const interactive: Record<string, unknown> = {
      type: 'list',
      body: { text: message.bodyText.slice(0, 1024) },
      action: {
        button: message.buttonText.slice(0, 20),
        sections: safeSections,
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
    const interactive: Record<string, unknown> = {
      type: 'button',
      body: { text: message.bodyText },
      action: {
        buttons: message.buttons.map((b) => ({
          type: 'reply',
          reply: { id: b.id, title: b.title },
        })),
      },
    };
    if (message.footerText) interactive.footer = { text: message.footerText };

    const response = await this.callApi(`/${this.phoneNumberId}/messages`, {
      messaging_product: 'whatsapp',
      to: message.to,
      type: 'interactive',
      interactive,
    });
    return { messageId: response.messages[0].id };
  }

  // ── Send Audio Message ──

  async sendAudio(message: { to: string; audioUrl: string }): Promise<{ messageId: string }> {
    const response = await this.callApi(`/${this.phoneNumberId}/messages`, {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: message.to,
      type: 'audio',
      audio: {
        link: message.audioUrl,
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
      { headers: { Authorization: `Bearer ${this.accessToken}` }, signal: AbortSignal.timeout(8000) }
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
      { headers: { Authorization: `Bearer ${this.accessToken}` }, signal: AbortSignal.timeout(8000) }
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
    const appId = process.env.NEXT_PUBLIC_META_APP_ID || process.env.META_APP_ID || '';
    const appSecret = process.env.META_APP_SECRET || '';
    const res = await fetch(
      `https://graph.facebook.com/${process.env.META_GRAPH_API_VERSION || 'v22.0'}/oauth/access_token?grant_type=fb_exchange_token&client_id=${appId}&client_secret=${appSecret}&fb_exchange_token=${shortLivedToken}`,
      { signal: AbortSignal.timeout(8000) }
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
      { headers: { Authorization: `Bearer ${this.accessToken}` }, signal: AbortSignal.timeout(8000) }
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
        signal: AbortSignal.timeout(8000),
      }
    );
    if (!res.ok) throw new Error(`Failed to register phone: ${res.status}`);
    return res.json();
  }

  // ── React to a Message ──

  async sendReaction(message: { to: string; messageId: string; emoji: string }): Promise<{ messageId: string }> {
    const response = await this.callApi(`/${this.phoneNumberId}/messages`, {
      messaging_product: 'whatsapp',
      to: message.to,
      type: 'reaction',
      reaction: {
        message_id: message.messageId,
        emoji: message.emoji,
      },
    });
    return { messageId: response.messages[0].id };
  }

  // ── Send Location ──

  async sendLocation(message: {
    to: string;
    latitude: number;
    longitude: number;
    name?: string;
    address?: string;
  }): Promise<{ messageId: string }> {
    const response = await this.callApi(`/${this.phoneNumberId}/messages`, {
      messaging_product: 'whatsapp',
      to: message.to,
      type: 'location',
      location: {
        latitude: message.latitude,
        longitude: message.longitude,
        name: message.name || undefined,
        address: message.address || undefined,
      },
    });
    return { messageId: response.messages[0].id };
  }

  // ── Set Business Profile ──

  async setBusinessProfile(profile: {
    about?: string;
    address?: string;
    description?: string;
    email?: string;
    websites?: string[];
    vertical?: string;
  }): Promise<boolean> {
    const res = await fetch(`${this.baseUrl}/${this.phoneNumberId}/whatsapp_business_profile`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        ...profile,
      }),
      signal: AbortSignal.timeout(8000),
    });
    return res.ok;
  }

  // ── Get Business Profile ──

  async getBusinessProfile(): Promise<Record<string, unknown> | null> {
    const res = await fetch(
      `${this.baseUrl}/${this.phoneNumberId}/whatsapp_business_profile?fields=about,address,description,email,websites,vertical,profile_picture_url`,
      { headers: { Authorization: `Bearer ${this.accessToken}` }, signal: AbortSignal.timeout(8000) }
    );
    if (!res.ok) return null;
    const data = await res.json();
    return data.data?.[0] || null;
  }

  // ── Send WhatsApp Flow ──

  async sendFlow(message: {
    to: string;
    bodyText: string;
    flowId: string;
    flowCta: string;
    screen: string;
    flowToken?: string;
    data?: Record<string, unknown>;
  }): Promise<{ messageId: string }> {
    const payload: Record<string, unknown> = {
      flow_message_version: '3',
      flow_id: message.flowId,
      flow_cta: message.flowCta,
      flow_action: 'navigate',
      flow_action_payload: {
        screen: message.screen,
        data: message.data || {},
      },
    };
    if (message.flowToken) {
      payload.flow_token = message.flowToken;
    }
    const response = await this.callApi(`/${this.phoneNumberId}/messages`, {
      messaging_product: 'whatsapp',
      to: message.to,
      type: 'interactive',
      interactive: {
        type: 'flow',
        body: { text: message.bodyText },
        action: {
          name: 'flow',
          parameters: payload,
        },
      },
    });
    return { messageId: response.messages[0].id };
  }

  // ── WhatsApp Catalog / Commerce ──

  /**
   * Send a single product message from a catalog.
   */
  async sendProduct(message: {
    to: string;
    catalogId: string;
    productId: string;
    body?: string;
    footer?: string;
  }): Promise<{ messageId: string }> {
    const response = await this.callApi(`/${this.phoneNumberId}/messages`, {
      messaging_product: 'whatsapp',
      to: message.to,
      type: 'interactive',
      interactive: {
        type: 'product',
        body: message.body ? { text: message.body } : undefined,
        footer: message.footer ? { text: message.footer } : undefined,
        action: {
          catalog_id: message.catalogId,
          product_retailer_id: message.productId,
        },
      },
    });
    return { messageId: response.messages[0].id };
  }

  /**
   * Send a multi-product message (product list) from a catalog.
   * Sections group products by category.
   */
  async sendProductList(message: {
    to: string;
    catalogId: string;
    headerText: string;
    bodyText: string;
    footerText?: string;
    sections: Array<{
      title: string;
      productIds: string[];
    }>;
  }): Promise<{ messageId: string }> {
    const response = await this.callApi(`/${this.phoneNumberId}/messages`, {
      messaging_product: 'whatsapp',
      to: message.to,
      type: 'interactive',
      interactive: {
        type: 'product_list',
        header: { type: 'text', text: message.headerText },
        body: { text: message.bodyText },
        footer: message.footerText ? { text: message.footerText } : undefined,
        action: {
          catalog_id: message.catalogId,
          sections: message.sections.map(s => ({
            title: s.title,
            product_items: s.productIds.map(id => ({ product_retailer_id: id })),
          })),
        },
      },
    });
    return { messageId: response.messages[0].id };
  }

  // ── Message Template Management ──

  async getTemplates(params?: {
    limit?: number;
    after?: string;
    fields?: string;
  }): Promise<{
    data: MessageTemplate[];
    paging?: { cursors: { after: string }; next?: string };
  }> {
    const fields = params?.fields || 'id,name,status,category,language,components,quality_score';
    let url = `${this.baseUrl}/${this.wabaId}/message_templates?fields=${fields}&limit=${params?.limit || 100}`;
    if (params?.after) url += `&after=${params.after}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${this.accessToken}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err?.error?.message || `Failed to get templates: ${res.status}`);
    }
    return res.json();
  }

  async createTemplate(template: CreateTemplateInput): Promise<{ id: string; status: string; category: string }> {
    const res = await fetch(`${this.baseUrl}/${this.wabaId}/message_templates`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(template),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err?.error?.message || `Failed to create template: ${res.status}`);
    }
    return res.json();
  }

  async deleteTemplate(name: string): Promise<{ success: boolean }> {
    const res = await fetch(
      `${this.baseUrl}/${this.wabaId}/message_templates?name=${encodeURIComponent(name)}`,
      {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${this.accessToken}` },
        signal: AbortSignal.timeout(8000),
      }
    );
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err?.error?.message || `Failed to delete template: ${res.status}`);
    }
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
      signal: AbortSignal.timeout(8000),
    });

    if (!res.ok) {
      const errorData = await res.json().catch(() => ({}));
      const errorMessage = errorData?.error?.message || `Cloud API error: ${res.status}`;
      throw new Error(errorMessage);
    }

    return res.json();
  }
}
