/**
 * OTP Authentication Template Tests
 *
 * Proves:
 * 1. sendAuthenticationTemplate produces the exact approved Meta payload
 * 2. OTP send route uses authentication template, never sendText
 * 3. AUTH-000 security invariants are preserved
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { NextRequest } from 'next/server';

// ═══════════════════════════════════════════════════════════
// 1. sendAuthenticationTemplate method
// ═══════════════════════════════════════════════════════════

describe('MetaCloudService.sendAuthenticationTemplate', () => {
  let capturedPayload: Record<string, unknown> | null = null;

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    capturedPayload = null;

    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (_url: string, opts: { body: string }) => {
      capturedPayload = JSON.parse(opts.body);
      return {
        ok: true,
        json: async () => ({
          messaging_product: 'whatsapp',
          contacts: [{ input: '1234567890', wa_id: '1234567890' }],
          messages: [{ id: 'wamid.test123' }],
        }),
      };
    }));
  });

  afterEach(() => { vi.unstubAllGlobals(); });

  it('produces the exact approved payload with BODY and COPY_CODE button', async () => {
    const { MetaCloudService } = await import('@/lib/channels/meta-cloud');
    const cloud = new MetaCloudService({ phoneNumberId: 'test-pnid', accessToken: 'test-token' });

    await cloud.sendAuthenticationTemplate({
      to: '1234567890',
      templateName: 'waaiio_login_otp',
      languageCode: 'en_US',
      code: '123456',
    });

    expect(capturedPayload).not.toBeNull();
    expect(capturedPayload!.messaging_product).toBe('whatsapp');
    expect(capturedPayload!.recipient_type).toBe('individual');
    expect(capturedPayload!.type).toBe('template');
    expect(capturedPayload!.type).not.toBe('text');

    const template = capturedPayload!.template as Record<string, unknown>;
    expect(template.name).toBe('waaiio_login_otp');
    expect(template.language).toEqual({ code: 'en_US' });

    const components = template.components as Array<Record<string, unknown>>;
    expect(components).toHaveLength(2);

    // BODY component
    const body = components.find(c => c.type === 'body');
    expect(body).toBeDefined();
    expect(body!.parameters).toEqual([{ type: 'text', text: '123456' }]);

    // COPY_CODE button component
    const button = components.find(c => c.type === 'button');
    expect(button).toBeDefined();
    expect(button!.sub_type).toBe('url');
    expect(button!.index).toBe('0');
    expect(button!.parameters).toEqual([{ type: 'text', text: '123456' }]);
  });

  it('BODY and COPY_CODE button contain the same code', async () => {
    const { MetaCloudService } = await import('@/lib/channels/meta-cloud');
    const cloud = new MetaCloudService({ phoneNumberId: 'test-pnid', accessToken: 'test-token' });

    await cloud.sendAuthenticationTemplate({
      to: '1234567890', templateName: 'waaiio_login_otp', languageCode: 'en_US', code: '789012',
    });

    const components = (capturedPayload!.template as Record<string, unknown>).components as Array<Record<string, unknown>>;
    const bodyCode = (components[0].parameters as Array<Record<string, string>>)[0].text;
    const buttonCode = (components[1].parameters as Array<Record<string, string>>)[0].text;
    expect(bodyCode).toBe('789012');
    expect(buttonCode).toBe('789012');
    expect(bodyCode).toBe(buttonCode);
  });

  it('returns Meta message ID', async () => {
    const { MetaCloudService } = await import('@/lib/channels/meta-cloud');
    const cloud = new MetaCloudService({ phoneNumberId: 'test-pnid', accessToken: 'test-token' });

    const result = await cloud.sendAuthenticationTemplate({
      to: '1234567890', templateName: 'waaiio_login_otp', languageCode: 'en_US', code: '123456',
    });
    expect(result.messageId).toBe('wamid.test123');
  });

  it('fails closed when Meta returns no message ID', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ messaging_product: 'whatsapp', contacts: [], messages: [] }),
    }));

    const { MetaCloudService } = await import('@/lib/channels/meta-cloud');
    const cloud = new MetaCloudService({ phoneNumberId: 'test-pnid', accessToken: 'test-token' });

    await expect(cloud.sendAuthenticationTemplate({
      to: '1234567890', templateName: 'waaiio_login_otp', languageCode: 'en_US', code: '123456',
    })).rejects.toThrow('Meta API did not return a message ID');
  });

  it('rejects invalid OTP formats', async () => {
    const { MetaCloudService } = await import('@/lib/channels/meta-cloud');
    const cloud = new MetaCloudService({ phoneNumberId: 'test-pnid', accessToken: 'test-token' });

    const invalidCodes = ['12345', '1234567', 'abcdef', '12 34 56', '123.56', ''];
    for (const code of invalidCodes) {
      await expect(cloud.sendAuthenticationTemplate({
        to: '1234567890', templateName: 'waaiio_login_otp', languageCode: 'en_US', code,
      })).rejects.toThrow('OTP code must be exactly 6 digits');
    }
  });

  it('rejects missing required fields', async () => {
    const { MetaCloudService } = await import('@/lib/channels/meta-cloud');
    const cloud = new MetaCloudService({ phoneNumberId: 'test-pnid', accessToken: 'test-token' });

    await expect(cloud.sendAuthenticationTemplate({ to: '', templateName: 'x', languageCode: 'en_US', code: '123456' })).rejects.toThrow('Recipient');
    await expect(cloud.sendAuthenticationTemplate({ to: '123', templateName: '', languageCode: 'en_US', code: '123456' })).rejects.toThrow('Template name');
    await expect(cloud.sendAuthenticationTemplate({ to: '123', templateName: 'x', languageCode: '', code: '123456' })).rejects.toThrow('Language code');
  });
});

// ═══════════════════════════════════════════════════════════
// 2. OTP send route uses authentication template
// ═══════════════════════════════════════════════════════════

describe('OTP send route — authentication template delivery', () => {
  let sendAuthCalls: number;
  let sendTextCalls: number;

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    sendAuthCalls = 0;
    sendTextCalls = 0;
    process.env.META_CLOUD_PHONE_NUMBER_ID = 'env-pnid';
    process.env.META_CLOUD_ACCESS_TOKEN = 'env-token';
    process.env.PHONE_OTP_HMAC_SECRET = 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789ab';
  });

  afterEach(() => {
    delete process.env.META_CLOUD_PHONE_NUMBER_ID;
    delete process.env.META_CLOUD_ACCESS_TOKEN;
    delete process.env.PHONE_OTP_HMAC_SECRET;
    vi.unstubAllGlobals();
  });

  function setup(channelHasToken: boolean) {
    vi.doMock('@/lib/brute-force', () => ({ checkBruteForce: vi.fn().mockReturnValue({ blocked: false }) }));
    vi.doMock('@/lib/rate-limit', () => ({
      rateLimitResponseAsync: vi.fn().mockResolvedValue(null),
      getRateLimitKey: vi.fn().mockReturnValue('test'),
    }));
    vi.doMock('@/lib/otp-phone-token', () => ({
      generatePhoneOtp: vi.fn().mockResolvedValue({ code: '654321', challengeId: 'a'.repeat(64) }),
    }));
    vi.doMock('@/lib/supabase/service', () => ({
      createServiceClient: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  limit: vi.fn().mockReturnValue({
                    maybeSingle: vi.fn().mockResolvedValue({
                      data: channelHasToken
                        ? { phone_number_id: 'db-pnid', meta_access_token: 'db-token' }
                        : null,
                    }),
                  }),
                }),
              }),
            }),
          }),
        }),
        rpc: vi.fn().mockResolvedValue({ error: null }),
      }),
    }));
    vi.doMock('@/lib/channels/meta-cloud', () => ({
      MetaCloudService: class {
        async sendAuthenticationTemplate() { sendAuthCalls++; return { messageId: 'wamid.test' }; }
        async sendText() { sendTextCalls++; return { messageId: 'wamid.text' }; }
      },
    }));
  }

  function makeReq() {
    return new NextRequest('https://www.waaiio.com/api/auth/otp/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '127.0.0.1' },
      body: JSON.stringify({ phone: '+2348012345678' }),
    });
  }

  it('uses database channel when available', async () => {
    setup(true);
    const { POST } = await import('@/app/api/auth/otp/send/route');
    const res = await POST(makeReq());
    expect(res.status).toBe(200);
    expect(sendAuthCalls).toBe(1);
    expect(sendTextCalls).toBe(0);
  });

  it('uses env fallback when database channel unavailable', async () => {
    setup(false);
    const { POST } = await import('@/app/api/auth/otp/send/route');
    const res = await POST(makeReq());
    expect(res.status).toBe(200);
    expect(sendAuthCalls).toBe(1);
    expect(sendTextCalls).toBe(0);
  });

  it('falls back to env when database channel throws', async () => {
    setup(true);
    // Override to make the first MetaCloudService throw
    let callCount = 0;
    vi.doMock('@/lib/channels/meta-cloud', () => ({
      MetaCloudService: class {
        async sendAuthenticationTemplate() {
          callCount++;
          if (callCount === 1) throw new Error('Channel failed');
          sendAuthCalls++;
          return { messageId: 'wamid.fallback' };
        }
        async sendText() { sendTextCalls++; return { messageId: 'wamid.text' }; }
      },
    }));
    const { POST } = await import('@/app/api/auth/otp/send/route');
    const res = await POST(makeReq());
    expect(res.status).toBe(200);
    expect(sendTextCalls).toBe(0);
  });

  it('only one successful delivery runs', async () => {
    setup(true);
    const { POST } = await import('@/app/api/auth/otp/send/route');
    await POST(makeReq());
    expect(sendAuthCalls).toBe(1); // DB channel succeeds, no fallback
  });

  it('success response contains message and opaque pin_id only', async () => {
    setup(false);
    const { POST } = await import('@/app/api/auth/otp/send/route');
    const res = await POST(makeReq());
    const body = await res.json();
    expect(body).toEqual({ message: 'OTP sent via WhatsApp', pin_id: 'a'.repeat(64) });
    expect(JSON.stringify(body)).not.toContain('654321'); // no OTP
    expect(JSON.stringify(body)).not.toContain('2348012345678'); // no phone
    expect(JSON.stringify(body)).not.toContain('wamid'); // no message ID
  });

  it('complete failure returns generic error without OTP', async () => {
    vi.doMock('@/lib/brute-force', () => ({ checkBruteForce: vi.fn().mockReturnValue({ blocked: false }) }));
    vi.doMock('@/lib/rate-limit', () => ({ rateLimitResponseAsync: vi.fn().mockResolvedValue(null), getRateLimitKey: vi.fn().mockReturnValue('t') }));
    vi.doMock('@/lib/otp-phone-token', () => ({ generatePhoneOtp: vi.fn().mockResolvedValue({ code: '654321', challengeId: 'a'.repeat(64) }) }));
    vi.doMock('@/lib/supabase/service', () => ({
      createServiceClient: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({ select: vi.fn().mockReturnValue({ eq: vi.fn().mockReturnValue({ eq: vi.fn().mockReturnValue({ eq: vi.fn().mockReturnValue({ limit: vi.fn().mockReturnValue({ maybeSingle: vi.fn().mockResolvedValue({ data: null }) }) }) }) }) }) }),
        rpc: vi.fn().mockResolvedValue({ error: null }),
      }),
    }));
    vi.doMock('@/lib/channels/meta-cloud', () => ({
      MetaCloudService: class { async sendAuthenticationTemplate() { throw new Error('Meta down'); } },
    }));
    const { POST } = await import('@/app/api/auth/otp/send/route');
    const res = await POST(makeReq());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.message).toContain('Failed');
    expect(JSON.stringify(body)).not.toContain('654321');
  });
});

// ═══════════════════════════════════════════════════════════
// 3. Static safety checks
// ═══════════════════════════════════════════════════════════

describe('Static safety', () => {
  it('OTP send route does not contain sendText', () => {
    const code = readFileSync('app/api/auth/otp/send/route.ts', 'utf-8');
    expect(code).not.toContain('.sendText(');
    expect(code).toContain('sendAuthenticationTemplate');
    expect(code).toContain("'waaiio_login_otp'");
    expect(code).toContain("'en_US'");
  });

  it('route does not log the OTP code', () => {
    const code = readFileSync('app/api/auth/otp/send/route.ts', 'utf-8');
    expect(code).not.toMatch(/logger\.\w+\([^)]*\bcode\b/);
  });
});
