// #1085: the real Meta webhook route routes an inbound image/document to a
// waiting Custom Flow Photo/PDF question, and otherwise keeps its existing
// "I can't process images or files yet" reply. Channel resolution, the
// event claim and the custom-flow file intake are mocked boundaries.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const sent: Array<{ to: string; text: string }> = [];
const rpcs: string[] = [];
const intake = vi.fn();
const downloads: Array<[string, number]> = [];

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

describe('#1085 webhook: photo/PDF answers for Custom Flow questions', { timeout: 60_000 }, () => {
  beforeEach(() => {
    vi.resetModules();
    sent.length = 0; rpcs.length = 0; downloads.length = 0; intake.mockReset();
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
        rpc: (name: string) => {
          rpcs.push(name);
          return Promise.resolve(name === 'claim_webhook_event' ? { data: { claimed: true, claim_token: 'token' }, error: null } : { data: null, error: null });
        },
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
            channel: { id: 'ch', business_id: 'biz-a', provider: 'meta_cloud', phone_number_id: 'pnid' },
            sender,
            cloud: {
              markAsRead: vi.fn(async () => undefined),
              downloadMediaWithin: vi.fn(async (id: string, max: number) => { downloads.push([id, max]); return { ok: false, reason: 'unavailable' }; }),
            },
          };
        }
      },
    }));
    vi.doMock('@/lib/channels/inbound-receipts', () => ({ recordInboundReceipt: vi.fn(async () => undefined) }));
    vi.doMock('@/lib/messaging/customer-message-guard', () => ({ installCustomerReplyGuard: () => ({ finish: async () => undefined }) }));
    vi.doMock('@/lib/bot/custom-flow/file-intake', async () => {
      const actual = await vi.importActual<typeof import('@/lib/bot/custom-flow/file-intake')>('@/lib/bot/custom-flow/file-intake');
      return { ...actual, handleCustomFlowFile: intake };
    });
  });

  afterEach(() => {
    for (const m of ['crypto', '@/lib/supabase/service', '@/lib/channels/channel-resolver', '@/lib/channels/inbound-receipts',
      '@/lib/messaging/customer-message-guard', '@/lib/bot/custom-flow/file-intake']) vi.doUnmock(m);
    delete process.env.META_APP_SECRET;
  });

  it('a waiting Photo/PDF question takes the image; no "can’t process" reply is sent', async () => {
    intake.mockImplementation(async (args: any) => {
      expect(args).toMatchObject({ from: '2348012345678', businessId: 'biz-a', media: { id: 'img-1', mimeType: 'image/jpeg' } });
      // The route hands the size-limited downloader of this channel to the intake.
      await args.download('img-1', 10 * 1024 * 1024);
      return true;
    });
    const res = await post({ type: 'image', image: { id: 'img-1', mime_type: 'image/jpeg' } });
    expect(res.status).toBe(200);
    expect(intake).toHaveBeenCalledTimes(1);
    expect(downloads).toEqual([['img-1', 10 * 1024 * 1024]]);
    expect(sent).toEqual([]);
    expect(rpcs).toContain('complete_webhook_event');
  });

  it('a document goes to the intake too', async () => {
    intake.mockResolvedValue(true);
    await post({ type: 'document', document: { id: 'doc-1', mime_type: 'application/pdf', filename: 'id.pdf' } });
    expect(intake.mock.calls[0][0].media).toEqual({ id: 'doc-1', mimeType: 'application/pdf' });
    expect(sent).toEqual([]);
  });

  it('with no waiting question, the existing reply is unchanged', async () => {
    intake.mockResolvedValue(false);
    await post({ type: 'image', image: { id: 'img-2', mime_type: 'image/jpeg' } });
    expect(intake).toHaveBeenCalledTimes(1);
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain("I can't process images or files yet");
  });

  it('if the intake throws, the existing reply is still sent', async () => {
    intake.mockRejectedValue(new Error('boom'));
    await post({ type: 'image', image: { id: 'img-3', mime_type: 'image/jpeg' } });
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain("I can't process images or files yet");
  });

  it('videos, stickers and locations never reach the intake', async () => {
    for (const msg of [{ type: 'video', video: { id: 'v' } }, { type: 'sticker', sticker: { id: 's' } }, { type: 'location', location: { latitude: 1, longitude: 2 } }]) {
      await post(msg);
    }
    expect(intake).not.toHaveBeenCalled();
    expect(sent).toHaveLength(3);
  });
});
