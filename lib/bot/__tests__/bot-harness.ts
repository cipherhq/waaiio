import { vi } from 'vitest';
import type { MessageSender } from '@/lib/channels/message-sender';

/**
 * Captured message from the bot — includes type and all fields.
 */
export interface CapturedMessage {
  type: 'text' | 'buttons' | 'list' | 'image' | 'document' | 'audio' | 'template' | 'reaction' | 'location';
  to: string;
  text?: string;
  body?: string;
  buttons?: Array<{ id: string; title: string }>;
  title?: string;
  buttonLabel?: string;
  items?: Array<{ title: string; description?: string; postbackText: string }>;
  imageUrl?: string;
  caption?: string;
  documentUrl?: string;
  filename?: string;
}

/**
 * Mock MessageSender that captures all outbound messages instead of sending to WhatsApp.
 * Use `getMessages()` to inspect what the bot sent, and `clear()` to reset between turns.
 */
export function createCaptureSender(): MessageSender & {
  getMessages: () => CapturedMessage[];
  getLastMessage: () => CapturedMessage | undefined;
  getTextMessages: () => string[];
  clear: () => void;
  hasMessageContaining: (text: string) => boolean;
  hasButtonWithId: (id: string) => boolean;
  hasListItem: (title: string) => boolean;
} {
  const messages: CapturedMessage[] = [];

  const sender: MessageSender = {
    sendText: vi.fn(async (msg) => {
      messages.push({ type: 'text', to: msg.to, text: msg.text });
      return { success: true, messageId: `msg_${messages.length}` };
    }),
    sendButtons: vi.fn(async (msg) => {
      messages.push({ type: 'buttons', to: msg.to, body: msg.body, buttons: msg.buttons });
      return { success: true, messageId: `msg_${messages.length}` };
    }),
    sendList: vi.fn(async (msg) => {
      messages.push({ type: 'list', to: msg.to, title: msg.title, body: msg.body, buttonLabel: msg.buttonLabel, items: msg.items });
      return { success: true, messageId: `msg_${messages.length}` };
    }),
    sendImage: vi.fn(async (msg) => {
      messages.push({ type: 'image', to: msg.to, imageUrl: msg.imageUrl, caption: msg.caption });
      return { success: true, messageId: `msg_${messages.length}` };
    }),
    sendDocument: vi.fn(async (msg) => {
      messages.push({ type: 'document', to: msg.to, documentUrl: msg.documentUrl, filename: msg.filename, caption: msg.caption });
      return { success: true, messageId: `msg_${messages.length}` };
    }),
    sendAudio: vi.fn(async () => ({ success: true })),
    sendTemplate: vi.fn(async () => ({ success: true })),
    sendFlow: vi.fn(async () => ({ success: true })),
    sendReaction: vi.fn(async () => ({ success: true })),
    sendLocation: vi.fn(async () => ({ success: true })),
  };

  return Object.assign(sender, {
    getMessages: () => [...messages],
    getLastMessage: () => messages[messages.length - 1],
    getTextMessages: () => messages.filter(m => m.type === 'text').map(m => m.text!),
    clear: () => { messages.length = 0; },
    hasMessageContaining: (text: string) =>
      messages.some(m =>
        (m.text || m.body || m.caption || '').toLowerCase().includes(text.toLowerCase())
      ),
    hasButtonWithId: (id: string) =>
      messages.some(m => m.buttons?.some(b => b.id === id)),
    hasListItem: (title: string) =>
      messages.some(m => m.items?.some(i => i.title.toLowerCase().includes(title.toLowerCase()))),
  });
}

/**
 * Create a mock Supabase client that returns configurable data.
 * Supports chaining: supabase.from('table').select().eq().single()
 */
export function createMockDb(defaultData: Record<string, unknown> | null = null) {
  function chainable(data: Record<string, unknown> | null = defaultData) {
    const chain: Record<string, any> = {};
    const self = () => chain;
    for (const method of [
      'select', 'insert', 'update', 'upsert', 'delete',
      'eq', 'neq', 'in', 'or', 'is', 'not', 'ilike', 'like',
      'gte', 'lte', 'gt', 'lt', 'contains', 'containedBy',
      'order', 'limit', 'range', 'filter', 'match',
    ]) {
      chain[method] = vi.fn().mockImplementation(() => self());
    }
    chain.single = vi.fn().mockResolvedValue({ data, error: data ? null : { message: 'not found' } });
    chain.maybeSingle = vi.fn().mockResolvedValue({ data, error: null });
    chain.then = undefined;
    return chain;
  }

  return {
    from: vi.fn(() => chainable()),
    rpc: vi.fn().mockImplementation(() => ({
      single: vi.fn().mockResolvedValue({
        data: { booking_id: 'mock-booking-id', reference_code: 'WA-BK-0001', slot_available: true },
        error: null,
      }),
    })),
    storage: {
      from: vi.fn(() => ({
        upload: vi.fn().mockResolvedValue({ error: null }),
        createSignedUrl: vi.fn().mockResolvedValue({ data: { signedUrl: 'https://mock-signed-url' } }),
        getPublicUrl: vi.fn().mockReturnValue({ data: { publicUrl: 'https://mock-public-url' } }),
      })),
    },
  };
}

/**
 * Standard test fixtures for a business with services, events, and products.
 */
export const FIXTURES = {
  business: {
    id: 'biz-001',
    name: 'Test Salon',
    slug: 'test-salon',
    category: 'salon',
    flow_type: 'scheduling',
    subscription_tier: 'growth',
    trial_ends_at: new Date(Date.now() + 30 * 86400000).toISOString(),
    metadata: {},
    operating_hours: {
      monday: { open: '09:00', close: '17:00' },
      tuesday: { open: '09:00', close: '17:00' },
      wednesday: { open: '09:00', close: '17:00' },
      thursday: { open: '09:00', close: '17:00' },
      friday: { open: '09:00', close: '17:00' },
    },
    country_code: 'US',
    payment_gateway: null,
    is_whitelabel: false,
    status: 'active',
  },

  church: {
    id: 'biz-002',
    name: 'Test Church',
    slug: 'test-church',
    category: 'church',
    flow_type: 'scheduling',
    subscription_tier: 'growth',
    trial_ends_at: new Date(Date.now() + 30 * 86400000).toISOString(),
    metadata: {},
    country_code: 'US',
    payment_gateway: null,
    is_whitelabel: false,
    status: 'active',
  },

  services: [
    {
      id: 'svc-001',
      name: 'Haircut',
      description: 'Classic haircut',
      price: 3000,
      deposit_amount: 0,
      duration_minutes: 30,
      buffer_minutes: 10,
      max_capacity: 1,
      is_active: true,
      sort_order: 1,
      image_url: null,
      metadata: {},
    },
    {
      id: 'svc-002',
      name: 'Hair Color',
      description: 'Full color service',
      price: 8000,
      deposit_amount: 2000,
      duration_minutes: 90,
      buffer_minutes: 15,
      max_capacity: 1,
      is_active: true,
      sort_order: 2,
      image_url: null,
      metadata: {},
    },
  ],

  events: [
    {
      id: 'evt-001',
      name: 'Summer Concert',
      date: '2026-08-15',
      time: '18:00',
      venue: 'Main Hall',
      price: 5000,
      total_tickets: 100,
      tickets_sold: 5,
      max_per_order: 10,
      image_url: 'https://example.com/concert.jpg',
      status: 'published',
    },
  ],

  products: [
    {
      id: 'prod-001',
      name: 'T-Shirt',
      price: 2500,
      category: 'Merch',
      stock_quantity: 50,
      track_inventory: true,
      has_variants: false,
      image_url: 'https://example.com/tshirt.jpg',
      is_active: true,
    },
  ],

  campaigns: [
    {
      id: 'camp-001',
      title: 'Building Fund',
      description: 'Help us build the new wing',
      goal_amount: 100000,
      raised_amount: 25000,
      donor_count: 15,
      end_date: null,
      status: 'active',
      min_donation: null,
      max_donation: null,
    },
  ],

  appointments: [
    {
      id: 'apt-001',
      name: 'Meeting with Pastor',
      price: 0,
      deposit_amount: 0,
      duration_minutes: 30,
      max_capacity: 1,
      auto_approve: true,
      requires_staff: false,
      staff_ids: null,
      allow_staff_selection: false,
      available_days: null,
      available_from: null,
      available_to: null,
      is_active: true,
      sort_order: 1,
    },
  ],

  capabilities: {
    salon: ['scheduling', 'payment', 'feedback', 'chat', 'staff'],
    church: ['giving', 'appointment', 'ticketing', 'crowdfunding', 'ordering', 'chat'],
  },
} as const;
