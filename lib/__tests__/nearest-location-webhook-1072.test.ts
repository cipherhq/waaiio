// #1072 step 2: the real Meta webhook route hands a location pin from a shared
// number (no business bound to the channel) to the bot as "[Location]" with the
// coordinates set on that message's BotService only. A pin to a business's own
// number keeps the existing reply. Channel resolution, the event claim and
// BotService are mocked boundaries.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const sent: Array<{ to: string; text: string }> = [];
const botCalls: Array<{ pin: unknown; args: unknown[] }> = [];
let channelBusinessId: string | null = null;

function messageBody(msg: Record<string, unknown>) {
  return {
    object: 'whatsapp_business_account',
    entry: [{ id: 'waba', changes: [{ field: 'messages', value: {
      messaging_product: 'whatsapp',
      metadata: { phone_number_id: 'pnid', display_phone_number: '1' },
      contacts: [{ wa_id: '2348012345678', profile: { name: 'Ada' } }],
      messages: [{ from: '2348012345678', id: `wamid.${Math.random()}`, timestamp: '1753383000', ...msg }],
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

describe('#1072 step 2 webhook: location pins', { timeout: 60_000 }, () => {
  beforeEach(() => {
    vi.resetModules();
    sent.length = 0; botCalls.length = 0; channelBusinessId = null;
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
        from: () => nothing,
        rpc: (name: string) => Promise.resolve(name === 'claim_webhook_event'
          ? { data: { claimed: true, claim_token: 'token' }, error: null } : { data: null, error: null }),
      }),
    }));
    const sender = {
      bindBusiness: vi.fn(),
      sendText: vi.fn(async (m: { to: string; text: string }) => { sent.push(m); return { success: true }; }),
    };
    vi.doMock('@/lib/channels/channel-resolver', () => ({
      ChannelResolver: class {
        async resolveByPhoneNumberId() {
          return {
            channel: { id: 'ch', business_id: channelBusinessId, provider: 'meta_cloud', phone_number_id: 'pnid', phone_number: '2340000' },
            sender,
            cloud: { markAsRead: vi.fn(async () => undefined), downloadMediaWithin: vi.fn() },
          };
        }
      },
    }));
    vi.doMock('@/lib/channels/inbound-receipts', () => ({ recordInboundReceipt: vi.fn(async () => undefined) }));
    vi.doMock('@/lib/messaging/customer-message-guard', () => ({ installCustomerReplyGuard: () => ({ finish: async () => undefined }) }));
    vi.doMock('@/lib/bot/bot.service', () => ({
      BotService: class {
        private pin: unknown = null;
        setInboundLocation(pin: unknown) { this.pin = pin; }
        markSuspensionGated() {}
        async handleMessage(...args: unknown[]) { botCalls.push({ pin: this.pin, args }); }
      },
    }));
  });

  afterEach(() => {
    for (const m of ['crypto', '@/lib/supabase/service', '@/lib/channels/channel-resolver', '@/lib/channels/inbound-receipts',
      '@/lib/messaging/customer-message-guard', '@/lib/bot/bot.service']) vi.doUnmock(m);
    delete process.env.META_APP_SECRET;
  });

  it('shared number: the pin goes to the bot as "[Location]"; its name/address are dropped', async () => {
    await post({ type: 'location', location: { latitude: 6.4474, longitude: 3.472, name: 'My house', address: '1 Admiralty Way' } });
    expect(sent).toEqual([]);
    expect(botCalls).toHaveLength(1);
    expect(botCalls[0].pin).toEqual({ latitude: 6.4474, longitude: 3.472 });
    expect(botCalls[0].args.slice(0, 3)).toEqual(['2348012345678', '[Location]', 'location']);
    expect(JSON.stringify(botCalls[0].args)).not.toMatch(/6\.4474|3\.472|My house|Admiralty/);
  });

  it('shared number: an unusable pin keeps the existing reply', async () => {
    await post({ type: 'location', location: { latitude: 'x', longitude: 3.4 } });
    expect(botCalls).toHaveLength(0);
    expect(sent.map((m) => m.text)).toEqual([expect.stringContaining("I can't process images or files yet")]);
  });

  it('a business number keeps the existing reply and never reaches the bot', async () => {
    channelBusinessId = 'biz-a';
    await post({ type: 'location', location: { latitude: 6.4474, longitude: 3.472 } });
    expect(botCalls).toHaveLength(0);
    expect(sent.map((m) => m.text)).toEqual([expect.stringContaining("I can't process images or files yet")]);
  });

  it('a shared-number text message carries no pin', async () => {
    await post({ type: 'text', text: { body: 'salons near me' } });
    expect(botCalls).toHaveLength(1);
    expect(botCalls[0].pin).toBeNull();
    expect(botCalls[0].args[1]).toBe('salons near me');
  });
});
