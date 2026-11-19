// #1103: the real Meta webhook route stops a suspended customer before any
// path that could start a flow, a native form, a catalog order or a file
// answer, at any business. Channel resolution, the event claim and the
// downstream handlers are mocked boundaries; customer_suspensions is an
// in-memory table read by the real gate.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createMemoryDb } from './helpers/memory-db';
import { SUSPENDED_CUSTOMER_TEXT } from '@/lib/customer-suspension';

const PHONE = '2348012345678';
const sent: Array<{ to: string; text: string }> = [];
const rpcs: string[] = [];
const handleMessage = vi.fn();
const nativeForm = vi.fn();
const catalogOrder = vi.fn();
const fileIntake = vi.fn();
let db: ReturnType<typeof createMemoryDb>;
let channelBusiness: string | null = 'biz-a';

function messageBody(msg: Record<string, unknown>) {
  return {
    object: 'whatsapp_business_account',
    entry: [{ id: 'waba', changes: [{ field: 'messages', value: {
      messaging_product: 'whatsapp',
      metadata: { phone_number_id: 'pnid', display_phone_number: '1' },
      contacts: [{ wa_id: PHONE, profile: { name: 'Ada' } }],
      messages: [{ from: PHONE, id: `wamid.${Math.random()}`, timestamp: '1753383000', ...msg }],
    } }] }],
  };
}

async function post(msg: Record<string, unknown>) {
  const { POST } = await import('@/app/api/webhook/meta-cloud/route');
  return POST(new NextRequest('https://www.waaiio.com/api/webhook/meta-cloud', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-hub-signature-256': 'sha256=test' },
    body: JSON.stringify(messageBody(msg)),
  }));
}

const TEXT = { type: 'text', text: { body: 'Hi' } };
const NATIVE_FORM = { type: 'interactive', interactive: { type: 'nfm_reply', nfm_reply: { response_json: '{}' } } };
const CATALOG_ORDER = { type: 'order', order: { catalog_id: 'c', product_items: [{ product_retailer_id: 'p', quantity: 1, item_price: 10, currency: 'NGN' }] } };
const IMAGE = { type: 'image', image: { id: 'img', mime_type: 'image/jpeg' } };

describe('#1103 webhook: suspended customer', { timeout: 60_000 }, () => {
  beforeEach(() => {
    vi.resetModules();
    sent.length = 0; rpcs.length = 0; channelBusiness = 'biz-a';
    for (const fn of [handleMessage, nativeForm, catalogOrder, fileIntake]) fn.mockReset();
    nativeForm.mockResolvedValue({ retry: false });
    fileIntake.mockResolvedValue(false);
    db = createMemoryDb({
      customer_suspensions: [{ id: 'sus-1', phone: PHONE, reason: 'abuse', suspended_by: 'admin-1', suspended_at: '2026-11-17T00:00:00Z', last_notified_at: null }],
    });
    process.env.META_APP_SECRET = 'test-secret';
    vi.doMock('crypto', async () => {
      const actual = await vi.importActual<typeof import('crypto')>('crypto');
      return { ...actual, createHmac: () => ({ update: () => ({ digest: () => 'test' }) }), timingSafeEqual: () => true };
    });
    const nothing: any = new Proxy(() => nothing, {
      get: (_t, p) => (p === 'then' ? (r: (v: unknown) => void) => r({ data: null, error: null }) : nothing),
      apply: () => nothing,
    });
    vi.doMock('@/lib/supabase/service', () => ({
      createServiceClient: () => ({
        from: (table: string) => (table === 'customer_suspensions' ? db.from(table) : nothing),
        rpc: (name: string) => {
          rpcs.push(name);
          return Promise.resolve(name === 'claim_webhook_event' ? { data: { claimed: true, claim_token: 'token' }, error: null } : { data: null, error: null });
        },
      }),
    }));
    const sender = {
      bindBusiness: vi.fn(),
      sendText: vi.fn(async (m: { to: string; text: string }) => { sent.push(m); return { success: true }; }),
      sendPlatformText: vi.fn(async (m: { to: string; text: string }) => { sent.push(m); return { success: true }; }),
    };
    vi.doMock('@/lib/channels/channel-resolver', () => ({
      ChannelResolver: class {
        async resolveByPhoneNumberId() {
          return {
            channel: { id: 'ch', business_id: channelBusiness, provider: 'meta_cloud', phone_number_id: 'pnid' },
            sender,
            cloud: { markAsRead: vi.fn(async () => undefined), downloadMediaWithin: vi.fn() },
          };
        }
      },
    }));
    vi.doMock('@/lib/channels/inbound-receipts', () => ({ recordInboundReceipt: vi.fn(async () => undefined) }));
    vi.doMock('@/lib/messaging/customer-message-guard', () => ({ installCustomerReplyGuard: () => ({ finish: async () => undefined }) }));
    vi.doMock('@/lib/bot/bot.service', () => ({ BotService: class { handleMessage = handleMessage; setInboundLocation() {} markSuspensionGated() {} } }));
    vi.doMock('@/lib/whatsapp-forms/webhook', async () => {
      const actual = await vi.importActual<typeof import('@/lib/whatsapp-forms/webhook')>('@/lib/whatsapp-forms/webhook');
      return { ...actual, handleNativeFormWebhook: nativeForm };
    });
    vi.doMock('@/lib/channels/catalog-order-handler', () => ({ handleCatalogOrder: catalogOrder }));
    vi.doMock('@/lib/bot/custom-flow/file-intake', async () => {
      const actual = await vi.importActual<typeof import('@/lib/bot/custom-flow/file-intake')>('@/lib/bot/custom-flow/file-intake');
      return { ...actual, handleCustomFlowFile: fileIntake };
    });
  });

  afterEach(() => {
    for (const m of ['crypto', '@/lib/supabase/service', '@/lib/channels/channel-resolver', '@/lib/channels/inbound-receipts',
      '@/lib/messaging/customer-message-guard', '@/lib/bot/bot.service', '@/lib/whatsapp-forms/webhook',
      '@/lib/channels/catalog-order-handler', '@/lib/bot/custom-flow/file-intake']) vi.doUnmock(m);
    delete process.env.META_APP_SECRET;
  });

  it.each([['biz-a'], ['biz-b'], [null]])('channel of business %s: text, form, order and image start nothing; one neutral reply', async biz => {
    channelBusiness = biz;
    for (const msg of [TEXT, NATIVE_FORM, CATALOG_ORDER, IMAGE]) {
      expect((await post(msg)).status).toBe(200);
    }
    expect(handleMessage).not.toHaveBeenCalled();
    expect(nativeForm).not.toHaveBeenCalled();
    expect(catalogOrder).not.toHaveBeenCalled();
    expect(fileIntake).not.toHaveBeenCalled();
    expect(sent).toEqual([{ to: PHONE, text: SUSPENDED_CUSTOMER_TEXT }]);
    // Every claimed event is completed, so Meta retries replay nothing.
    expect(rpcs.filter(r => r === 'complete_webhook_event')).toHaveLength(4);
  });

  it('after unsuspend the same messages reach their handlers again', async () => {
    db.tables.customer_suspensions = [];
    await post(TEXT);
    await post(NATIVE_FORM);
    await post(CATALOG_ORDER);
    expect(handleMessage).toHaveBeenCalledTimes(1);
    expect(handleMessage.mock.calls[0][0]).toBe(PHONE);
    expect(nativeForm).toHaveBeenCalledTimes(1);
    expect(catalogOrder).toHaveBeenCalledTimes(1);
    expect(sent.map(m => m.text)).not.toContain(SUSPENDED_CUSTOMER_TEXT);
  });

  it('a failed suspension read lets the message through to the bot', async () => {
    db.failReads.add('customer_suspensions');
    await post(TEXT);
    expect(handleMessage).toHaveBeenCalledTimes(1);
    expect(sent).toEqual([]);
  });
});
