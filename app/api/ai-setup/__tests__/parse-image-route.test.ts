/**
 * Ace image reading — executable handler tests for POST /api/ai-setup/parse-image.
 *
 * Invokes the real route handler. Anthropic, Supabase auth/ownership, rate
 * limiting and the Ace quota helpers are mocked (incrementAIUsage itself is
 * tested in lib/bot/__tests__/ai-usage-increment.test.ts); file-signature validation and
 * the sharp re-encode (sanitizeImage) run for real.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import sharp from 'sharp';

const h = vi.hoisted(() => ({
  user: { id: 'user-1' } as { id: string } | null,
  biz: { id: 'biz-1', country_code: 'NG', subscription_tier: 'free' } as Record<string, unknown> | null,
  ownerLookups: [] as Array<{ id?: unknown; owner_id?: unknown }>,
  rateLimit: vi.fn(),
  checkAIFeature: vi.fn(),
  incrementAIUsage: vi.fn(),
  create: vi.fn(),
  serviceClient: { kind: 'service-client' },
}));

vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => h.serviceClient,
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: h.user } }) },
    from: (table: string) => {
      const filters: Record<string, unknown> = {};
      const chain: Record<string, unknown> = {};
      chain.select = () => chain;
      chain.eq = (col: string, val: unknown) => { filters[col] = val; return chain; };
      chain.maybeSingle = async () => {
        if (table !== 'businesses') return { data: null };
        h.ownerLookups.push({ ...filters });
        const owned = h.biz && filters.id === h.biz.id && filters.owner_id === h.user?.id;
        return { data: owned ? h.biz : null };
      };
      return chain;
    },
  }),
}));

vi.mock('@/lib/rate-limit', () => ({
  rateLimitResponseAsync: (...args: unknown[]) => h.rateLimit(...args),
}));

vi.mock('@/lib/bot/ai-tier-guard', () => ({
  checkAIFeature: (...args: unknown[]) => h.checkAIFeature(...args),
  incrementAIUsage: (...args: unknown[]) => h.incrementAIUsage(...args),
}));

vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create: (...args: unknown[]) => h.create(...args) };
  },
}));

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { POST, maxDuration } from '../parse-image/route';
import { ACE_IMAGE_MODEL } from '@/lib/ai-setup/image-catalog';

let smallPng: Buffer;

async function makePng(width: number, height: number): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: { r: 200, g: 120, b: 40 } } }).png().toBuffer();
}

function modelReply(payload: unknown) {
  return { content: [{ type: 'text', text: typeof payload === 'string' ? payload : JSON.stringify(payload) }] };
}

function request(opts: { bytes?: Buffer | string; type?: string; businessId?: string; mode?: string } = {}) {
  const fd = new FormData();
  const bytes = opts.bytes ?? smallPng;
  const part: BlobPart = typeof bytes === 'string' ? bytes : new Uint8Array(bytes);
  fd.append('file', new File([part], 'menu.png', { type: opts.type ?? 'image/png' }));
  fd.append('business_id', opts.businessId ?? 'biz-1');
  if (opts.mode) fd.append('mode', opts.mode);
  return new NextRequest('http://localhost/api/ai-setup/parse-image', { method: 'POST', body: fd });
}

beforeEach(async () => {
  smallPng ??= await makePng(40, 30);
  h.user = { id: 'user-1' };
  h.biz = { id: 'biz-1', country_code: 'NG', subscription_tier: 'free' };
  h.ownerLookups = [];
  h.rateLimit.mockReset().mockResolvedValue(null);
  h.checkAIFeature.mockReset().mockResolvedValue({ allowed: true });
  h.incrementAIUsage.mockReset().mockResolvedValue(true);
  h.create.mockReset().mockResolvedValue(modelReply({ items: [{ kind: 'product', name: 'Jollof Rice', price: 2500 }] }));
});

describe('auth, ownership, rate limit and quota', () => {
  it('401 without a user and nothing else runs', async () => {
    h.user = null;
    const res = await POST(request());
    expect(res.status).toBe(401);
    expect(h.rateLimit).not.toHaveBeenCalled();
    expect(h.create).not.toHaveBeenCalled();
  });

  it('404 for a non-owner — no rate-limit or quota consumption, no model call', async () => {
    const res = await POST(request({ businessId: 'someone-elses-biz' }));
    expect(res.status).toBe(404);
    expect(h.ownerLookups).toEqual([{ id: 'someone-elses-biz', owner_id: 'user-1' }]);
    expect(h.rateLimit).not.toHaveBeenCalled();
    expect(h.checkAIFeature).not.toHaveBeenCalled();
    expect(h.create).not.toHaveBeenCalled();
    expect(h.incrementAIUsage).not.toHaveBeenCalled();
  });

  it('rate limit is keyed per business + user, after the owner check', async () => {
    const res = await POST(request());
    expect(res.status).toBe(200);
    expect(h.rateLimit).toHaveBeenCalledWith('ai-parse:biz-1:user-1', 10, 3600_000);
  });

  it('returns the rate-limit response when limited', async () => {
    h.rateLimit.mockResolvedValue(new Response(JSON.stringify({ error: 'Too many requests. Please try again later.' }), { status: 429 }));
    const res = await POST(request());
    expect(res.status).toBe(429);
    expect(h.create).not.toHaveBeenCalled();
  });

  it('403 with a clear message when the Ace allowance is exhausted', async () => {
    h.checkAIFeature.mockResolvedValue({ allowed: false, reason: 'Monthly ace setup limit reached (3). Upgrade for more.' });
    const res = await POST(request());
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('Monthly ace setup limit reached (3). Upgrade for more.');
    expect(h.checkAIFeature).toHaveBeenCalledWith(expect.anything(), 'biz-1', 'free', 'ace_setup');
    expect(h.create).not.toHaveBeenCalled();
    expect(h.incrementAIUsage).not.toHaveBeenCalled();
  });
});

describe('input validation', () => {
  it('400 when the bytes are not the claimed image type', async () => {
    const res = await POST(request({ bytes: 'this is definitely not a png file at all', type: 'image/png' }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/does not match/i);
    expect(h.create).not.toHaveBeenCalled();
  });

  it('400 when a JPEG is disguised as PNG', async () => {
    const jpeg = await sharp(smallPng).jpeg().toBuffer();
    const res = await POST(request({ bytes: jpeg, type: 'image/png' }));
    expect(res.status).toBe(400);
  });

  it('400 for a disallowed MIME type', async () => {
    const res = await POST(request({ type: 'image/svg+xml' }));
    expect(res.status).toBe(400);
  });

  it('400 for an unknown mode', async () => {
    const res = await POST(request({ mode: 'everything' }));
    expect(res.status).toBe(400);
    expect(h.create).not.toHaveBeenCalled();
  });
});

describe('model call', () => {
  it('uses the pinned Sonnet model constant, no tools, and a maxDuration', async () => {
    expect(ACE_IMAGE_MODEL).toBe('claude-sonnet-4-5-20250929');
    expect(maxDuration).toBe(60);
    await POST(request());
    const args = h.create.mock.calls[0][0];
    expect(args.model).toBe(ACE_IMAGE_MODEL);
    expect(args).not.toHaveProperty('tools');
    expect(args.system).toMatch(/untrusted/i);
  });

  it('sends a sanitized JPEG image block with long edge ≤ 1568', async () => {
    const bigPng = await makePng(3000, 1200);
    await POST(request({ bytes: bigPng }));
    const block = h.create.mock.calls[0][0].messages[0].content[0];
    expect(block.type).toBe('image');
    expect(block.source.media_type).toBe('image/jpeg');
    const sent = Buffer.from(block.source.data, 'base64');
    expect([...sent.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
    const meta = await sharp(sent).metadata();
    expect(meta.format).toBe('jpeg');
    expect(Math.max(meta.width!, meta.height!)).toBeLessThanOrEqual(1568);
  });

  it('turns transparent areas white, not black', async () => {
    const transparent = await sharp({ create: { width: 20, height: 20, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
    await POST(request({ bytes: transparent }));
    const sent = Buffer.from(h.create.mock.calls[0][0].messages[0].content[0].source.data, 'base64');
    const { data } = await sharp(sent).raw().toBuffer({ resolveWithObject: true });
    expect(Math.min(data[0], data[1], data[2])).toBeGreaterThan(240);
  });

  it('502 when the model call fails; the checked image still counts (Owner decision)', async () => {
    h.create.mockRejectedValue(new Error('overloaded'));
    const res = await POST(request());
    expect(res.status).toBe(502);
    expect(h.incrementAIUsage).toHaveBeenCalledTimes(1);
  });

  it('counts the image before the model is called', async () => {
    const order: string[] = [];
    h.incrementAIUsage.mockImplementation(async () => { order.push('count'); return true; });
    h.create.mockImplementation(async () => { order.push('model'); return modelReply({ items: [] }); });
    await POST(request());
    expect(order).toEqual(['count', 'model']);
  });

  it('counts with the service client (ai_usage writes are service-role only)', async () => {
    await POST(request());
    expect(h.incrementAIUsage).toHaveBeenCalledWith(h.serviceClient, 'biz-1', 'ace_setup');
  });

  it('503 and no model call when the image cannot be counted', async () => {
    h.incrementAIUsage.mockResolvedValue(false);
    const res = await POST(request());
    expect(res.status).toBe(503);
    expect((await res.json()).error).toMatch(/try again/i);
    expect(h.create).not.toHaveBeenCalled();
  });

  it('does not count an image that fails the byte checks', async () => {
    const res = await POST(request({ bytes: 'not an image', type: 'image/png' }));
    expect(res.status).toBe(400);
    expect(h.incrementAIUsage).not.toHaveBeenCalled();
    expect(h.create).not.toHaveBeenCalled();
  });
});

describe('output validation', () => {
  it('malformed JSON → empty items with a message; the image still counts', async () => {
    h.create.mockResolvedValue(modelReply('Sure! Here are the items: {items: [oops'));
    const res = await POST(request());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toEqual([]);
    expect(body.message).toBeTruthy();
    expect(h.incrementAIUsage).toHaveBeenCalledTimes(1);
  });

  it('output cut off at max_tokens → no items and a "too long, split it" message', async () => {
    h.create.mockResolvedValue({ ...modelReply('{"items":[{"kind":"product","name":"A","price":1}'), stop_reason: 'max_tokens' });
    const body = await (await POST(request())).json();
    expect(body.items).toEqual([]);
    expect(body.message).toMatch(/too long/i);
  });

  it('parses JSON wrapped in a ```json fence', async () => {
    h.create.mockResolvedValue(modelReply('```json\n{"items":[{"kind":"product","name":"Chapman","price":800}]}\n```'));
    const body = await (await POST(request())).json();
    expect(body.items).toEqual([{ kind: 'product', name: 'Chapman', price: 800, description: '', category: '' }]);
  });

  it('clamps lengths, strips URLs/markup, and normalises prices', async () => {
    h.create.mockResolvedValue(modelReply({
      items: [
        { kind: 'product', name: 'N'.repeat(300), price: 12.6, category: 'C'.repeat(150), description: 'D'.repeat(1200) },
        { kind: 'product', name: '<b>Suya</b> visit https://evil.example/x now', price: -5, description: '[click](https://evil.example) www.evil.example' },
        { kind: 'product', name: 'Puff puff', price: '₦500' },
        { kind: 'product', name: 'Huge', price: 1e15 },
        { kind: 'product', name: '   ', price: 100 },
        { kind: 'product', price: 100 },
        { kind: 'product', name: 'Latte', price: 12.5 },
        { kind: 'service', name: 'Trim', price: 12.456 },
      ],
    }));
    const body = await (await POST(request())).json();
    expect(body.items).toHaveLength(6);
    const [long, injected, stringPrice, huge, latte, trim] = body.items;
    expect(long.name).toHaveLength(200);
    expect(long.category).toHaveLength(100);
    expect(long.description).toHaveLength(1000);
    // Decimals are kept (to 2 dp) in the proposal; only service rows round later
    expect(long.price).toBe(12.6);
    expect(latte.price).toBe(12.5);
    expect(trim.price).toBe(12.46);
    expect(injected.name).toBe('Suya visit now');
    expect(injected.description).toBe('click');
    expect(injected.price).toBeNull();
    expect(stringPrice.price).toBeNull();
    // Implausible prices (e.g. a misread phone number) need the owner to type one
    expect(huge.price).toBeNull();
  });

  it('caps a menu at 100 items', async () => {
    const items = Array.from({ length: 150 }, (_, i) => ({ kind: 'product', name: `Item ${i}`, price: i }));
    h.create.mockResolvedValue(modelReply({ items }));
    const body = await (await POST(request())).json();
    expect(body.items).toHaveLength(100);
  });

  it('keeps kind product/service (unknown → product) and service durations', async () => {
    h.create.mockResolvedValue(modelReply({
      items: [
        { kind: 'service', name: 'Haircut', price: 15, duration_minutes: 45.4 },
        { kind: 'product', name: 'Hair oil', price: 20, duration_minutes: 30 },
        { kind: 'banana', name: 'Mystery', price: 5 },
      ],
    }));
    const body = await (await POST(request())).json();
    expect(body.items.map((i: { kind: string }) => i.kind)).toEqual(['service', 'product', 'product']);
    expect(body.items[0].duration_minutes).toBe(45);
    expect(body.items[1]).not.toHaveProperty('duration_minutes');
  });

  it('keeps items with no visible price as price: null', async () => {
    h.create.mockResolvedValue(modelReply({ items: [{ kind: 'product', name: 'Zobo', price: null }, { kind: 'product', name: 'Kunu' }] }));
    const body = await (await POST(request())).json();
    expect(body.items.map((i: { price: unknown }) => i.price)).toEqual([null, null]);
  });

  it('product_photo mode returns exactly one product with suggested details', async () => {
    h.create.mockResolvedValue(modelReply({
      items: [
        { kind: 'service', name: 'Red sneakers', price: null, description: 'Red canvas sneakers with white soles.', category: 'Shoes' },
        { kind: 'product', name: 'Second item', price: 10 },
      ],
    }));
    const res = await POST(request({ mode: 'product_photo' }));
    const body = await res.json();
    expect(body.mode).toBe('product_photo');
    expect(body.items).toEqual([{ kind: 'product', name: 'Red sneakers', price: null, description: 'Red canvas sneakers with white soles.', category: 'Shoes' }]);
    expect(h.create.mock.calls[0][0].system).toMatch(/ONE product/);
  });

  it('increments Ace usage exactly once per image', async () => {
    const res = await POST(request());
    expect(res.status).toBe(200);
    expect(h.incrementAIUsage).toHaveBeenCalledTimes(1);
    expect(h.incrementAIUsage).toHaveBeenCalledWith(expect.anything(), 'biz-1', 'ace_setup');
  });
});
