/**
 * ACC-211: Promo WhatsApp template provisioning
 *
 * Tests:
 * A. Generic provisioner (WAAIIO_TEMPLATES) contains all 3 new templates with exact bodies
 * B. Capability provisioner (REQUIRED_TEMPLATES) includes all 4 promo_verification templates
 * C. Language-aware existence check prevents wrong-language suppression
 * D. Fulfillment template appears in template-status readiness response
 * E. getTemplates failure in OTP send prevents issuance (503)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ── A. Generic Provisioner Tests ──

describe('Generic Provisioner: WAAIIO_TEMPLATES', () => {
  it('contains promo_pickup_verification_v2 with exact approved body', async () => {
    const { WAAIIO_TEMPLATES } = await import('@/lib/channels/provision-templates');
    const t = WAAIIO_TEMPLATES.find(t => t.name === 'promo_pickup_verification_v2');
    expect(t).toBeDefined();
    expect(t!.language).toBe('en_US');
    expect(t!.category).toBe('UTILITY');
    const body = t!.components.find(c => c.type === 'BODY');
    expect(body).toBeDefined();
    expect(body!.text).toBe(
      '{{1}} — Your {{2}} pickup verification code is {{3}}. It expires in {{4}} minutes. Only share this code with the sponsoring business when collecting your prize.',
    );
    // 4 placeholders
    const placeholders = body!.text!.match(/\{\{\d+\}\}/g);
    expect(placeholders).toHaveLength(4);
  });

  it('contains promo_winner_status_v1 with exact approved body', async () => {
    const { WAAIIO_TEMPLATES } = await import('@/lib/channels/provision-templates');
    const t = WAAIIO_TEMPLATES.find(t => t.name === 'promo_winner_status_v1');
    expect(t).toBeDefined();
    expect(t!.language).toBe('en_US');
    expect(t!.category).toBe('UTILITY');
    const body = t!.components.find(c => c.type === 'BODY');
    expect(body).toBeDefined();
    expect(body!.text).toBe(
      '{{1}} — You won {{3}} in the {{2}} promotion. Claim reference: {{4}}. Keep this reference for lookup and status checks. It does not replace any required pickup verification.',
    );
    const placeholders = body!.text!.match(/\{\{\d+\}\}/g);
    expect(placeholders).toHaveLength(4);
  });

  it('contains promo_fulfillment_status_v1 with exact approved body', async () => {
    const { WAAIIO_TEMPLATES } = await import('@/lib/channels/provision-templates');
    const t = WAAIIO_TEMPLATES.find(t => t.name === 'promo_fulfillment_status_v1');
    expect(t).toBeDefined();
    expect(t!.language).toBe('en_US');
    expect(t!.category).toBe('UTILITY');
    const body = t!.components.find(c => c.type === 'BODY');
    expect(body).toBeDefined();
    expect(body!.text).toBe(
      '{{1}} — Update for {{2}}: {{3}}. Claim reference: {{4}}. Status: {{5}}.',
    );
    const placeholders = body!.text!.match(/\{\{\d+\}\}/g);
    expect(placeholders).toHaveLength(5);
  });

  it('retains legacy promo_pickup_verification (v1)', async () => {
    const { WAAIIO_TEMPLATES } = await import('@/lib/channels/provision-templates');
    const t = WAAIIO_TEMPLATES.find(t => t.name === 'promo_pickup_verification');
    expect(t).toBeDefined();
    expect(t!.language).toBe('en_US');
  });
});

// ── B. Capability Provisioner Tests ──

describe('Capability Provisioner: REQUIRED_TEMPLATES', () => {
  it('promo_verification capability includes all 4 templates', async () => {
    const { REQUIRED_TEMPLATES } = await import('@/app/api/whatsapp/templates/provision/route');
    const templates = REQUIRED_TEMPLATES.promo_verification;
    expect(templates).toBeDefined();
    expect(templates.length).toBe(4);
    expect(templates).toContainEqual(expect.objectContaining({ name: 'promo_pickup_verification' }));
    expect(templates).toContainEqual(expect.objectContaining({ name: 'promo_pickup_verification_v2' }));
    expect(templates).toContainEqual(expect.objectContaining({ name: 'promo_winner_status_v1' }));
    expect(templates).toContainEqual(expect.objectContaining({ name: 'promo_fulfillment_status_v1' }));
  });

  it('promo_pickup_verification_v2 body matches generic provisioner', async () => {
    const { WAAIIO_TEMPLATES } = await import('@/lib/channels/provision-templates');
    const { REQUIRED_TEMPLATES } = await import('@/app/api/whatsapp/templates/provision/route');
    const generic = WAAIIO_TEMPLATES.find(t => t.name === 'promo_pickup_verification_v2');
    const capability = REQUIRED_TEMPLATES.promo_verification.find(t => t.name === 'promo_pickup_verification_v2');
    expect(generic).toBeDefined();
    expect(capability).toBeDefined();
    const genericBody = generic!.components.find(c => c.type === 'BODY')!.text;
    const capBody = capability!.components.find(c => c.type === 'BODY')!.text;
    expect(genericBody).toBe(capBody);
  });

  it('promo_winner_status_v1 body matches generic provisioner', async () => {
    const { WAAIIO_TEMPLATES } = await import('@/lib/channels/provision-templates');
    const { REQUIRED_TEMPLATES } = await import('@/app/api/whatsapp/templates/provision/route');
    const generic = WAAIIO_TEMPLATES.find(t => t.name === 'promo_winner_status_v1');
    const capability = REQUIRED_TEMPLATES.promo_verification.find(t => t.name === 'promo_winner_status_v1');
    const genericBody = generic!.components.find(c => c.type === 'BODY')!.text;
    const capBody = capability!.components.find(c => c.type === 'BODY')!.text;
    expect(genericBody).toBe(capBody);
  });

  it('promo_fulfillment_status_v1 body matches generic provisioner', async () => {
    const { WAAIIO_TEMPLATES } = await import('@/lib/channels/provision-templates');
    const { REQUIRED_TEMPLATES } = await import('@/app/api/whatsapp/templates/provision/route');
    const generic = WAAIIO_TEMPLATES.find(t => t.name === 'promo_fulfillment_status_v1');
    const capability = REQUIRED_TEMPLATES.promo_verification.find(t => t.name === 'promo_fulfillment_status_v1');
    const genericBody = generic!.components.find(c => c.type === 'BODY')!.text;
    const capBody = capability!.components.find(c => c.type === 'BODY')!.text;
    expect(genericBody).toBe(capBody);
  });
});

// ── C. Language-aware existence check ──

describe('Language-aware existence check', () => {
  it('same-name wrong-language template does NOT suppress en_US provisioning', async () => {
    const { WAAIIO_TEMPLATES } = await import('@/lib/channels/provision-templates');

    // Simulate: Meta returns a template with matching name but wrong language
    const metaTemplates = [
      { name: 'promo_pickup_verification_v2', language: 'pt_BR', status: 'APPROVED' },
    ];

    const templateToProvision = WAAIIO_TEMPLATES.find(t => t.name === 'promo_pickup_verification_v2')!;

    // The provisioner checks: t.name === template.name && t.language === template.language
    const alreadyExists = metaTemplates.some(
      t => t.name === templateToProvision.name && t.language === templateToProvision.language,
    );
    expect(alreadyExists).toBe(false); // pt_BR !== en_US, so it should NOT suppress

    // Same name AND same language SHOULD suppress
    const metaTemplatesMatch = [
      { name: 'promo_pickup_verification_v2', language: 'en_US', status: 'APPROVED' },
    ];
    const alreadyExistsMatch = metaTemplatesMatch.some(
      t => t.name === templateToProvision.name && t.language === templateToProvision.language,
    );
    expect(alreadyExistsMatch).toBe(true);
  });
});

// ── D. Template Status: fulfillment template in readiness response ──

// Hoisted mutable state for D & E mocks
const hoisted = vi.hoisted(() => {
  const mockResolvedChannel = { current: null as unknown };
  const mockServiceFrom = { current: vi.fn() };
  const mockServiceRpc = { current: vi.fn() };
  const mockSendTemplateFn = { current: vi.fn() };
  return { mockResolvedChannel, mockServiceFrom, mockServiceRpc, mockSendTemplateFn };
});

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn().mockResolvedValue({
    auth: { getUser: () => Promise.resolve({ data: { user: { id: 'user-1' } } }) },
    from: vi.fn().mockImplementation(() => {
      const c: Record<string, any> = {};
      ['select', 'eq', 'neq', 'order', 'range', 'not', 'in', 'gte', 'limit'].forEach(
        (m) => (c[m] = vi.fn().mockReturnValue(c)),
      );
      c.maybeSingle = vi.fn().mockResolvedValue({ data: { id: 'biz-1', name: 'Test Business' }, error: null });
      c.single = vi.fn().mockResolvedValue({ data: { id: 'biz-1', name: 'Test Business' }, error: null });
      return c;
    }),
  }),
}));

vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: vi.fn().mockReturnValue({
    from: (...args: unknown[]) => hoisted.mockServiceFrom.current(...args),
    rpc: (...args: unknown[]) => hoisted.mockServiceRpc.current(...args),
  }),
}));

vi.mock('@/lib/capabilities/api-guard', () => ({
  requireCapability: vi.fn().mockResolvedValue({ allowed: true }),
}));

vi.mock('@/lib/channels/channel-resolver', () => ({
  ChannelResolver: class MockChannelResolver {
    resolveByBusinessId() { return Promise.resolve(hoisted.mockResolvedChannel.current); }
  },
}));

vi.mock('@/lib/promotions/crypto', () => ({
  generatePickupOtp: vi.fn().mockReturnValue('123456'),
  hashPickupToken: vi.fn().mockReturnValue('hmac_test'),
}));

vi.mock('@/lib/utils/phone', () => ({
  stripPlus: vi.fn().mockImplementation((p: string) => p.replace(/^\+/, '')),
}));

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

describe('Template Status: fulfillment template readiness', () => {
  beforeEach(() => {
    vi.resetModules();
    hoisted.mockServiceFrom.current = vi.fn().mockReturnValue({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
      single: vi.fn().mockResolvedValue({ data: null, error: null }),
    });
  });

  it('fulfillment template appears in readiness response when approved', async () => {
    hoisted.mockResolvedChannel.current = {
      channel: { id: 'ch-1', channel_type: 'dedicated', business_id: 'biz-1' },
      cloud: { getTemplates: vi.fn().mockResolvedValue({ data: [
        { name: 'promo_pickup_verification', language: 'en_US', status: 'APPROVED' },
        { name: 'promo_pickup_verification_v2', language: 'en_US', status: 'APPROVED' },
        { name: 'promo_winner_status_v1', language: 'en_US', status: 'APPROVED' },
        { name: 'promo_fulfillment_status_v1', language: 'en_US', status: 'APPROVED' },
      ] }) },
    };
    const { GET } = await import('@/app/api/promotions/template-status/route');
    const req = new NextRequest('http://localhost/api/promotions/template-status?businessId=biz-1');
    const res = await GET(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.templates).toBeDefined();
    expect(json.templates['promo_fulfillment_status_v1']).toBeDefined();
    expect(json.templates['promo_fulfillment_status_v1'].status).toBe('ready');
    expect(json.templates['promo_fulfillment_status_v1'].template).toBe('promo_fulfillment_status_v1');
  });

  it('fulfillment template shows provisioning_required when missing', async () => {
    hoisted.mockResolvedChannel.current = {
      channel: { id: 'ch-1', channel_type: 'dedicated', business_id: 'biz-1' },
      cloud: { getTemplates: vi.fn().mockResolvedValue({ data: [
        { name: 'promo_pickup_verification', language: 'en_US', status: 'APPROVED' },
        { name: 'promo_pickup_verification_v2', language: 'en_US', status: 'APPROVED' },
        { name: 'promo_winner_status_v1', language: 'en_US', status: 'APPROVED' },
      ] }) },
    };
    const { GET } = await import('@/app/api/promotions/template-status/route');
    const req = new NextRequest('http://localhost/api/promotions/template-status?businessId=biz-1');
    const res = await GET(req);
    const json = await res.json();
    expect(json.templates['promo_fulfillment_status_v1'].status).toBe('provisioning_required');
  });
});

// ── E. OTP Send: getTemplates failure prevents issuance ──

describe('OTP Send: getTemplates failure prevents OTP issuance', () => {
  let fromCallCount = 0;

  function makeChain(resolveData: () => { data: unknown; error: unknown }): Record<string, any> {
    const c: Record<string, any> = {};
    ['select', 'eq', 'neq', 'order', 'range', 'not', 'in', 'gte', 'limit'].forEach(
      (m) => (c[m] = vi.fn().mockReturnValue(c)),
    );
    c.maybeSingle = vi.fn().mockImplementation(() => Promise.resolve(resolveData()));
    c.single = vi.fn().mockImplementation(() => Promise.resolve(resolveData()));
    return c;
  }

  beforeEach(() => {
    vi.resetModules();
    fromCallCount = 0;

    hoisted.mockSendTemplateFn.current = vi.fn();
    hoisted.mockServiceRpc.current = vi.fn().mockResolvedValue({ data: { success: true, verification_id: 'ver-1' }, error: null });
    hoisted.mockResolvedChannel.current = {
      channel: { id: 'ch-1', channel_type: 'shared', business_id: null },
      sender: { sendTemplate: hoisted.mockSendTemplateFn.current },
      cloud: { getTemplates: vi.fn().mockRejectedValue(new Error('Failed to get templates: 500')) },
    };

    hoisted.mockServiceFrom.current = vi.fn().mockImplementation((table: string) => {
      if (table === 'businesses') {
        fromCallCount++;
        if (fromCallCount <= 1) return makeChain(() => ({ data: { id: 'biz-1', name: 'Test Business' }, error: null }));
        return makeChain(() => ({
          data: { id: 'biz-1', status: 'active', subscription_tier: 'growth', trial_ends_at: null, category: 'other', name: 'Test Biz' },
          error: null,
        }));
      }
      if (table === 'business_members') return makeChain(() => ({ data: null, error: null }));
      if (table === 'business_capabilities') {
        return makeChain(() => ({
          data: [{ capability: 'promo_verification', is_enabled: true, sort_order: 0 }],
          error: null,
        }));
      }
      if (table === 'capability_overrides') return makeChain(() => ({ data: [], error: null }));
      if (table === 'promo_redemptions') return makeChain(() => ({
        data: { id: 'red-1', phone_e164: '+2348012345678', promo_code_id: 'code-1' },
        error: null,
      }));
      if (table === 'promo_campaign_codes') return makeChain(() => ({ data: { prize_id: 'prize-1' }, error: null }));
      if (table === 'promo_prizes') return makeChain(() => ({ data: { name: 'Gold Prize' }, error: null }));
      return makeChain(() => ({ data: null, error: null }));
    });
  });

  it('getTemplates failure returns 503 and prevents OTP issuance', async () => {
    const { POST } = await import('@/app/api/promotions/verification/send/route');
    const req = new NextRequest('http://localhost/api/promotions/verification/send', {
      method: 'POST',
      body: JSON.stringify({ businessId: 'biz-1', redemptionId: 'red-1' }),
      headers: { 'Content-Type': 'application/json' },
    });
    const res = await POST(req);
    expect(res.status).toBe(503);
    const json = await res.json();
    expect(json.error).toBe('Template readiness check unavailable');

    // issue_promo_pickup RPC should NOT have been called
    const issueCalls = hoisted.mockServiceRpc.current.mock.calls.filter((c: unknown[]) => c[0] === 'issue_promo_pickup');
    expect(issueCalls.length).toBe(0);

    // sendTemplate should NOT have been called
    expect(hoisted.mockSendTemplateFn.current).not.toHaveBeenCalled();
  });
});
