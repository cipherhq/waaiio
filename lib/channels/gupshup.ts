import { logger } from '@/lib/logger';

export interface WhatsAppMessage {
  to: string;
  templateId?: string;
  templateParams?: string[];
  text?: string;
}

export interface WhatsAppListItem {
  title: string;
  description?: string;
  postbackText: string;
}

export interface WhatsAppListMessage {
  to: string;
  title: string;
  body: string;
  buttonLabel: string;
  items: WhatsAppListItem[];
}

export interface WhatsAppButtonMessage {
  to: string;
  body: string;
  buttons: Array<{ id: string; title: string }>;
}

export interface WhatsAppImageMessage {
  to: string;
  imageUrl: string;
  caption?: string;
}

export interface GupshupCredentials {
  apiKey: string;
  phoneNumber: string;
  appName?: string;
}

export class GupshupService {
  private readonly apiKey: string;
  private readonly phoneNumber: string;
  private readonly appName: string;
  private readonly baseUrl = 'https://api.gupshup.io/wa/api/v1';

  constructor(credentials?: GupshupCredentials) {
    this.apiKey = credentials?.apiKey || process.env.GUPSHUP_API_KEY || '';
    this.phoneNumber = credentials?.phoneNumber || process.env.GUPSHUP_PHONE_NUMBER || '';
    this.appName = credentials?.appName || process.env.GUPSHUP_APP_NAME || this.phoneNumber;
  }

  /** Create from a whatsapp_channels DB record */
  static fromChannel(channel: {
    gupshup_api_key: string;
    phone_number: string;
    gupshup_app_name: string;
  }): GupshupService {
    return new GupshupService({
      apiKey: channel.gupshup_api_key,
      phoneNumber: channel.phone_number,
      appName: channel.gupshup_app_name,
    });
  }

  get isConfigured(): boolean {
    return !!this.apiKey && !!this.phoneNumber;
  }

  async sendTemplate(message: WhatsAppMessage): Promise<{ success: boolean; messageId?: string }> {
    if (!this.isConfigured) {
      logger.debug(`[DEV] WhatsApp template to ${message.to}: ${message.templateId}`);
      return { success: true, messageId: `mock_wa_${Date.now()}` };
    }

    try {
      const body = new URLSearchParams({
        channel: 'whatsapp',
        source: this.phoneNumber,
        destination: message.to.replace('+', ''),
        'src.name': this.appName,
        template: JSON.stringify({
          id: message.templateId,
          params: message.templateParams || [],
        }),
      });

      const response = await fetch(`${this.baseUrl}/template/msg`, {
        method: 'POST',
        headers: {
          apikey: this.apiKey,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: body.toString(),
      });

      const data = await response.json();
      if (data.status === 'submitted') {
        return { success: true, messageId: data.messageId };
      }
      logger.error('Gupshup template send failed', data);
      return { success: false };
    } catch (error) {
      logger.error('Gupshup API error', error);
      return { success: false };
    }
  }

  async sendText(message: WhatsAppMessage): Promise<{ success: boolean; messageId?: string }> {
    if (!this.isConfigured) {
      logger.debug(`[DEV] WhatsApp text to ${message.to}: ${message.text}`);
      return { success: true, messageId: `mock_wa_${Date.now()}` };
    }

    try {
      const body = new URLSearchParams({
        channel: 'whatsapp',
        source: this.phoneNumber,
        destination: message.to.replace('+', ''),
        'src.name': this.appName,
        message: JSON.stringify({ type: 'text', text: message.text }),
      });

      const response = await fetch(`${this.baseUrl}/msg`, {
        method: 'POST',
        headers: {
          apikey: this.apiKey,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: body.toString(),
      });

      const data = await response.json();
      if (data.status === 'submitted') {
        return { success: true, messageId: data.messageId };
      }
      logger.error('Gupshup text send failed', data);
      return { success: false };
    } catch (error) {
      logger.error('Gupshup API error', error);
      return { success: false };
    }
  }

  async sendList(message: WhatsAppListMessage): Promise<{ success: boolean; messageId?: string }> {
    if (!this.isConfigured) {
      logger.debug(`[DEV] WhatsApp list to ${message.to}: "${message.title}" (${message.items.length} items)`);
      return { success: true, messageId: `mock_wa_${Date.now()}` };
    }

    try {
      const interactive = {
        type: 'list',
        title: message.title,
        body: message.body,
        msgid: `list_${Date.now()}`,
        globalButtons: [{ type: 'text', title: message.buttonLabel }],
        items: [
          {
            title: message.title,
            subtitle: '',
            options: message.items.map((item) => ({
              type: 'text',
              title: item.title,
              description: item.description || '',
              postbackText: item.postbackText,
            })),
          },
        ],
      };

      const body = new URLSearchParams({
        channel: 'whatsapp',
        source: this.phoneNumber,
        destination: message.to.replace('+', ''),
        'src.name': this.appName,
        message: JSON.stringify(interactive),
      });

      const response = await fetch(`${this.baseUrl}/msg`, {
        method: 'POST',
        headers: {
          apikey: this.apiKey,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: body.toString(),
      });

      const data = await response.json();
      if (data.status === 'submitted') {
        return { success: true, messageId: data.messageId };
      }
      logger.error('Gupshup list send failed', data);
      return { success: false };
    } catch (error) {
      logger.error('Gupshup API error', error);
      return { success: false };
    }
  }

  async sendButtons(message: WhatsAppButtonMessage): Promise<{ success: boolean; messageId?: string }> {
    if (!this.isConfigured) {
      logger.debug(`[DEV] WhatsApp buttons to ${message.to}: "${message.body}"`);
      return { success: true, messageId: `mock_wa_${Date.now()}` };
    }

    try {
      const interactive = {
        type: 'quick_reply',
        msgid: `btn_${Date.now()}`,
        content: { type: 'text', text: message.body },
        options: message.buttons.map((btn) => ({
          type: 'text',
          title: btn.title,
          postbackText: btn.id,
        })),
      };

      const body = new URLSearchParams({
        channel: 'whatsapp',
        source: this.phoneNumber,
        destination: message.to.replace('+', ''),
        'src.name': this.appName,
        message: JSON.stringify(interactive),
      });

      const response = await fetch(`${this.baseUrl}/msg`, {
        method: 'POST',
        headers: {
          apikey: this.apiKey,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: body.toString(),
      });

      const data = await response.json();
      if (data.status === 'submitted') {
        return { success: true, messageId: data.messageId };
      }
      logger.error('Gupshup buttons send failed', data);
      return { success: false };
    } catch (error) {
      logger.error('Gupshup API error', error);
      return { success: false };
    }
  }

  async sendDocument(message: {
    to: string;
    documentUrl: string;
    filename: string;
    caption?: string;
  }): Promise<{ success: boolean; messageId?: string }> {
    if (!this.isConfigured) {
      logger.debug(`[DEV] WhatsApp document to ${message.to}: ${message.documentUrl}`);
      return { success: true, messageId: `mock_wa_${Date.now()}` };
    }

    try {
      const body = new URLSearchParams({
        channel: 'whatsapp',
        source: this.phoneNumber,
        destination: message.to.replace('+', ''),
        'src.name': this.appName,
        message: JSON.stringify({
          type: 'file',
          url: message.documentUrl,
          filename: message.filename,
          caption: message.caption || '',
        }),
      });

      const response = await fetch(`${this.baseUrl}/msg`, {
        method: 'POST',
        headers: {
          apikey: this.apiKey,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: body.toString(),
      });

      const data = await response.json();
      if (data.status === 'submitted') {
        return { success: true, messageId: data.messageId };
      }
      logger.error('Gupshup document send failed', data);
      return { success: false };
    } catch (error) {
      logger.error('Gupshup API error', error);
      return { success: false };
    }
  }

  async sendImage(message: WhatsAppImageMessage): Promise<{ success: boolean; messageId?: string }> {
    if (!this.isConfigured) {
      logger.debug(`[DEV] WhatsApp image to ${message.to}: ${message.imageUrl}`);
      return { success: true, messageId: `mock_wa_${Date.now()}` };
    }

    try {
      const body = new URLSearchParams({
        channel: 'whatsapp',
        source: this.phoneNumber,
        destination: message.to.replace('+', ''),
        'src.name': this.appName,
        message: JSON.stringify({
          type: 'image',
          originalUrl: message.imageUrl,
          previewUrl: message.imageUrl,
          caption: message.caption || '',
        }),
      });

      const response = await fetch(`${this.baseUrl}/msg`, {
        method: 'POST',
        headers: {
          apikey: this.apiKey,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: body.toString(),
      });

      const data = await response.json();
      if (data.status === 'submitted') {
        return { success: true, messageId: data.messageId };
      }
      logger.error('Gupshup image send failed', data);
      return { success: false };
    } catch (error) {
      logger.error('Gupshup API error', error);
      return { success: false };
    }
  }
}
