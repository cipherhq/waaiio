/**
 * Chat, Contracts & Ace AI — Integration Tests (Level A/B)
 *
 * Upgrades chat, contracts, and Ace AI setup from Level C/D coverage.
 * Uses real local Supabase for DB/RLS tests; vi.doMock for AI handler tests.
 *
 * Run: SUPABASE_INTEGRATION=true npx vitest run lib/__tests__/chat-contract-ai-integration.test.ts
 *
 * Prerequisites:
 * - Local Supabase running (supabase start)
 * - All migrations applied
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { createClient } from '@supabase/supabase-js';

const SKIP = process.env.SUPABASE_INTEGRATION !== 'true';
const describeIntegration = SKIP ? describe.skip : describe;

// ══════════════════════════════════════════════════════════════
// Sections 1 & 2: Chat + Contracts (real DB, single lifecycle)
// ══════════════════════════════════════════════════════════════

describeIntegration('Chat, Contracts & Waivers Integration', () => {
  let supabaseUrl: string;
  let serviceKey: string;
  let anonKey: string;
  let serviceClient: ReturnType<typeof createClient>;

  let userA: { id: string; email: string; token: string };
  let userB: { id: string; email: string; token: string };
  let bizA: string;
  let bizB: string;

  // Shared across chat tests
  let conversationId: string;

  // Shared across contract tests
  let contractId: string;
  let contractToken: string;

  beforeAll(async () => {
    supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || 'http://127.0.0.1:54321';
    serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
    anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';

    if (!serviceKey || !anonKey) {
      const { execSync } = await import('child_process');
      try {
        const env = execSync('supabase status -o env 2>/dev/null', { encoding: 'utf-8' });
        for (const line of env.split('\n')) {
          const [key, ...rest] = line.split('=');
          const val = rest.join('=').trim().replace(/^"|"$/g, '');
          if (key === 'API_URL') supabaseUrl = val;
          if (key === 'SERVICE_ROLE_KEY') serviceKey = val;
          if (key === 'ANON_KEY') anonKey = val;
        }
      } catch {
        throw new Error('Cannot get Supabase keys. Is local Supabase running?');
      }
    }

    serviceClient = createClient(supabaseUrl, serviceKey);
    const ts = Date.now();

    // Create userA
    const { data: aData } = await serviceClient.auth.admin.createUser({
      email: `test-cci-a-${ts}@integration.test`,
      password: 'test-password-123',
      email_confirm: true,
    });
    if (!aData.user) throw new Error('Failed to create userA');
    const { data: aSession } = await createClient(supabaseUrl, anonKey).auth.signInWithPassword({
      email: `test-cci-a-${ts}@integration.test`,
      password: 'test-password-123',
    });
    userA = { id: aData.user.id, email: aData.user.email!, token: aSession.session!.access_token };

    // Create userB
    const { data: bData } = await serviceClient.auth.admin.createUser({
      email: `test-cci-b-${ts}@integration.test`,
      password: 'test-password-123',
      email_confirm: true,
    });
    if (!bData.user) throw new Error('Failed to create userB');
    const { data: bSession } = await createClient(supabaseUrl, anonKey).auth.signInWithPassword({
      email: `test-cci-b-${ts}@integration.test`,
      password: 'test-password-123',
    });
    userB = { id: bData.user.id, email: bData.user.email!, token: bSession.session!.access_token };

    // Create businesses
    const { data: b1 } = await serviceClient
      .from('businesses')
      .insert({
        owner_id: userA.id,
        name: 'CCI Test Biz A',
        slug: `cci-biz-a-${ts}`,
        address: '1 Test St',
        city: 'Lagos',
        neighborhood: 'Test',
        phone: '+1000000001',
        status: 'active',
      })
      .select('id')
      .single();
    bizA = b1!.id;

    const { data: b2 } = await serviceClient
      .from('businesses')
      .insert({
        owner_id: userB.id,
        name: 'CCI Test Biz B',
        slug: `cci-biz-b-${ts}`,
        address: '2 Test St',
        city: 'Accra',
        neighborhood: 'Test',
        phone: '+1000000002',
        status: 'active',
      })
      .select('id')
      .single();
    bizB = b2!.id;
  }, 30_000);

  afterAll(async () => {
    if (!serviceClient) return;
    // Cascade delete from businesses cleans up chat_conversations, contracts, waivers, etc.
    if (bizA) await serviceClient.from('businesses').delete().eq('id', bizA);
    if (bizB) await serviceClient.from('businesses').delete().eq('id', bizB);
    if (userA?.id) await serviceClient.auth.admin.deleteUser(userA.id);
    if (userB?.id) await serviceClient.auth.admin.deleteUser(userB.id);
  }, 15_000);

  // ── Chat & Messaging (5 tests) ──

  describe('Chat & Messaging', () => {
    it('1. creates a chat_conversations record with status=open', async () => {
      const { data, error } = await serviceClient
        .from('chat_conversations')
        .insert({
          business_id: bizA,
          customer_phone: '+1234567890',
          customer_name: 'Test Customer A',
          status: 'open',
        })
        .select()
        .single();

      expect(error).toBeNull();
      expect(data).toBeTruthy();
      expect(data!.status).toBe('open');
      expect(data!.business_id).toBe(bizA);
      expect(data!.customer_phone).toBe('+1234567890');
      conversationId = data!.id;
    });

    it('2. creates chat_messages linked to conversation with correct fields', async () => {
      const { data, error } = await serviceClient
        .from('chat_messages')
        .insert({
          business_id: bizA,
          customer_phone: '+1234567890',
          customer_name: 'Test Customer A',
          direction: 'inbound',
          message_text: 'Hello, I need help!',
          conversation_id: conversationId,
        })
        .select()
        .single();

      expect(error).toBeNull();
      expect(data).toBeTruthy();
      expect(data!.direction).toBe('inbound');
      expect(data!.message_text).toBe('Hello, I need help!');
      expect(data!.conversation_id).toBe(conversationId);
      expect(data!.is_read).toBe(false);
    });

    it('3. marks conversation resolved and sets resolved_at', async () => {
      const now = new Date().toISOString();
      const { data, error } = await serviceClient
        .from('chat_conversations')
        .update({ status: 'resolved', resolved_at: now, resolved_by: userA.id })
        .eq('id', conversationId)
        .select()
        .single();

      expect(error).toBeNull();
      expect(data!.status).toBe('resolved');
      expect(data!.resolved_at).toBeTruthy();
      expect(data!.resolved_by).toBe(userA.id);
    });

    it('4. reopens conversation back to open status', async () => {
      const { data, error } = await serviceClient
        .from('chat_conversations')
        .update({ status: 'open', resolved_at: null, resolved_by: null })
        .eq('id', conversationId)
        .select()
        .single();

      expect(error).toBeNull();
      expect(data!.status).toBe('open');
      expect(data!.resolved_at).toBeNull();
    });

    it('5. cross-business isolation: userB cannot read userA conversations via RLS', async () => {
      // Insert a conversation for bizA using service client
      const { data: convA } = await serviceClient
        .from('chat_conversations')
        .insert({
          business_id: bizA,
          customer_phone: '+1111111111',
          customer_name: 'Isolated Customer',
          status: 'open',
        })
        .select('id')
        .single();

      expect(convA).toBeTruthy();

      // userB's authenticated client should NOT see bizA conversations
      const clientB = createClient(supabaseUrl, anonKey, {
        global: { headers: { Authorization: `Bearer ${userB.token}` } },
      });

      const { data: visible } = await clientB
        .from('chat_conversations')
        .select('id')
        .eq('id', convA!.id);

      // RLS should return empty — userB does not own bizA
      expect(visible).toEqual([]);

      // userA's authenticated client SHOULD see it
      const clientA = createClient(supabaseUrl, anonKey, {
        global: { headers: { Authorization: `Bearer ${userA.token}` } },
      });

      const { data: visibleA } = await clientA
        .from('chat_conversations')
        .select('id')
        .eq('id', convA!.id);

      expect(visibleA).toHaveLength(1);
    });
  });

  // ── Contracts & Waivers (5 tests) ──

  describe('Contracts & Waivers', () => {
    it('1. creates contract + contract_signers and verifies records', async () => {
      contractToken = generateToken();

      const { data: contract, error: cErr } = await serviceClient
        .from('contracts')
        .insert({
          business_id: bizA,
          title: 'Test Service Agreement',
          token: contractToken,
          signer_name: 'John Doe',
          signer_phone: '+1987654321',
          signer_email: 'john@test.com',
          status: 'pending',
          token_expires_at: new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString(),
        })
        .select()
        .single();

      expect(cErr).toBeNull();
      expect(contract).toBeTruthy();
      expect(contract!.title).toBe('Test Service Agreement');
      expect(contract!.status).toBe('pending');
      contractId = contract!.id;

      // Create a signer
      const signerToken = generateToken();
      const { data: signer, error: sErr } = await serviceClient
        .from('contract_signers')
        .insert({
          contract_id: contractId,
          signer_name: 'Jane Signer',
          signer_phone: '+1555000111',
          signer_email: 'jane@test.com',
          token: signerToken,
          signing_order: 1,
          status: 'pending',
          token_expires_at: new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString(),
        })
        .select()
        .single();

      expect(sErr).toBeNull();
      expect(signer).toBeTruthy();
      expect(signer!.contract_id).toBe(contractId);
      expect(signer!.signing_order).toBe(1);
    });

    it('2. creates a signing token matching the production generation pattern', async () => {
      // Token from test 1 should be 24 chars, alphanumeric
      // (matching generateToken in app/api/contracts/send/route.ts)
      expect(contractToken).toHaveLength(24);
      expect(contractToken).toMatch(/^[A-Za-z0-9]+$/);

      // Verify the contract can be looked up by token
      const { data, error } = await serviceClient
        .from('contracts')
        .select('id, title')
        .eq('token', contractToken)
        .single();

      expect(error).toBeNull();
      expect(data!.id).toBe(contractId);
    });

    it('3. creates waiver_template + signed_waiver and verifies linkage', async () => {
      // Create waiver template
      const { data: template, error: tErr } = await serviceClient
        .from('waiver_templates')
        .insert({
          business_id: bizA,
          title: 'Liability Waiver',
          body: 'I acknowledge all risks associated with this activity.',
          fields: JSON.stringify(['name', 'signature', 'date']),
          is_active: true,
          require_before_booking: false,
        })
        .select()
        .single();

      expect(tErr).toBeNull();
      expect(template).toBeTruthy();
      expect(template!.title).toBe('Liability Waiver');
      expect(template!.token).toBeTruthy(); // Auto-generated by DB default

      // Create signed waiver
      const { data: signed, error: sErr } = await serviceClient
        .from('signed_waivers')
        .insert({
          template_id: template!.id,
          business_id: bizA,
          customer_name: 'Alice Signer',
          customer_phone: '+1222333444',
          customer_email: 'alice@test.com',
          metadata: { ip: '127.0.0.1' },
        })
        .select()
        .single();

      expect(sErr).toBeNull();
      expect(signed).toBeTruthy();
      expect(signed!.template_id).toBe(template!.id);
      expect(signed!.customer_name).toBe('Alice Signer');
      expect(signed!.signed_at).toBeTruthy();
    });

    it('4. token uniqueness: two contracts get different tokens', async () => {
      const tokenA = generateToken();
      const tokenB = generateToken();

      // Tokens MUST be different (24 random chars — collision is astronomically unlikely)
      expect(tokenA).not.toBe(tokenB);

      // Insert both — neither should violate UNIQUE constraint
      const { error: errA } = await serviceClient
        .from('contracts')
        .insert({
          business_id: bizA,
          title: 'Contract Alpha',
          token: tokenA,
          token_expires_at: new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString(),
        });
      expect(errA).toBeNull();

      const { error: errB } = await serviceClient
        .from('contracts')
        .insert({
          business_id: bizA,
          title: 'Contract Beta',
          token: tokenB,
          token_expires_at: new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString(),
        });
      expect(errB).toBeNull();

      // Attempting to reuse tokenA should fail with unique violation
      const { error: errDup } = await serviceClient
        .from('contracts')
        .insert({
          business_id: bizA,
          title: 'Contract Gamma',
          token: tokenA,
          token_expires_at: new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString(),
        });
      expect(errDup).toBeTruthy();
      expect(errDup!.code).toBe('23505'); // unique_violation
    });

    it('5. cross-business isolation: userB cannot read userA contracts via RLS', async () => {
      const isolatedToken = generateToken();
      const { data: contractA } = await serviceClient
        .from('contracts')
        .insert({
          business_id: bizA,
          title: 'Secret Contract',
          token: isolatedToken,
          token_expires_at: new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString(),
        })
        .select('id')
        .single();

      expect(contractA).toBeTruthy();

      // userB should NOT see bizA contracts
      const clientB = createClient(supabaseUrl, anonKey, {
        global: { headers: { Authorization: `Bearer ${userB.token}` } },
      });

      const { data: visible } = await clientB
        .from('contracts')
        .select('id')
        .eq('id', contractA!.id);

      expect(visible).toEqual([]);

      // userA SHOULD see their own contract
      const clientA = createClient(supabaseUrl, anonKey, {
        global: { headers: { Authorization: `Bearer ${userA.token}` } },
      });

      const { data: visibleA } = await clientA
        .from('contracts')
        .select('id')
        .eq('id', contractA!.id);

      expect(visibleA).toHaveLength(1);
    });
  });
});

// ══════════════════════════════════════════════════════════════
// Section 3: Ace AI Setup Handler (4 tests)
// ══════════════════════════════════════════════════════════════

describe('Ace AI Setup Handler', () => {
  it('1. authenticated request returns 200 with AI response', async () => {
    const { POST } = await importAIRoute({
      mockUser: { id: 'user-123', email: 'test@example.com' },
      mockBusiness: {
        id: 'biz-456',
        name: 'Test Salon',
        category: 'salon',
        country_code: 'NG',
        city: 'Lagos',
        subscription_tier: 'free',
      },
    });

    const request = new Request('http://localhost:3000/api/ai-setup/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        business_id: 'biz-456',
        message: 'I want to set up my hair salon',
      }),
    });

    const { NextRequest } = await import('next/server');
    const nextReq = new NextRequest(request);
    const response = await POST(nextReq);
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.reply).toBe('Test AI response');
    expect(json.tier).toBe('free');
    expect(json.allowed_capabilities).toBeDefined();
    expect(Array.isArray(json.allowed_capabilities)).toBe(true);
  });

  it('2. unauthenticated request returns 401', async () => {
    const { POST } = await importAIRoute({
      mockUser: null,
    });

    const request = new Request('http://localhost:3000/api/ai-setup/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        business_id: 'biz-456',
        message: 'Hello',
      }),
    });

    const { NextRequest } = await import('next/server');
    const nextReq = new NextRequest(request);
    const response = await POST(nextReq);

    expect(response.status).toBe(401);
    const json = await response.json();
    expect(json.error).toBe('Unauthorized');
  });

  it('3. missing ANTHROPIC_API_KEY causes 500 AI service unavailable', async () => {
    const { POST } = await importAIRoute({
      mockUser: { id: 'user-123', email: 'test@example.com' },
      mockBusiness: {
        id: 'biz-456',
        name: 'Test Salon',
        category: 'salon',
        country_code: 'NG',
        city: 'Lagos',
        subscription_tier: 'free',
      },
      anthropicShouldThrow: true,
    });

    const request = new Request('http://localhost:3000/api/ai-setup/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        business_id: 'biz-456',
        message: 'Set up my salon',
      }),
    });

    const { NextRequest } = await import('next/server');
    const nextReq = new NextRequest(request);
    const response = await POST(nextReq);

    expect(response.status).toBe(500);
    const json = await response.json();
    expect(json.error).toBe('AI service unavailable');
  });

  it('4. rate limiting exists on the handler (20/hr per business)', async () => {
    let rateLimitCalled = false;
    let rateLimitKey = '';
    let rateLimitMax = 0;

    const { POST } = await importAIRoute({
      mockUser: { id: 'user-123', email: 'test@example.com' },
      mockBusiness: {
        id: 'biz-789',
        name: 'Rate Test Biz',
        category: 'salon',
        country_code: 'NG',
        city: 'Lagos',
        subscription_tier: 'free',
      },
      onRateLimit: (key: string, max: number) => {
        rateLimitCalled = true;
        rateLimitKey = key;
        rateLimitMax = max;
      },
    });

    const request = new Request('http://localhost:3000/api/ai-setup/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        business_id: 'biz-789',
        message: 'Hello',
      }),
    });

    const { NextRequest } = await import('next/server');
    const nextReq = new NextRequest(request);
    await POST(nextReq);

    expect(rateLimitCalled).toBe(true);
    expect(rateLimitKey).toBe('ai-setup:biz-789');
    expect(rateLimitMax).toBe(20);
  });
});

// ══════════════════════════════════════════════════════════════
// Helpers
// ══════════════════════════════════════════════════════════════

/**
 * Mirrors the production token generation from app/api/contracts/send/route.ts
 */
function generateToken(): string {
  const tokenBytes = new Uint8Array(24);
  crypto.getRandomValues(tokenBytes);
  return Array.from(tokenBytes, b =>
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'[b % 62]
  ).join('');
}

/**
 * Import the AI setup route handler with all dependencies mocked via vi.doMock.
 * Each call resets modules for a clean module graph.
 */
async function importAIRoute(opts: {
  mockUser?: { id: string; email: string } | null;
  mockBusiness?: {
    id: string;
    name: string;
    category: string;
    country_code: string;
    city: string;
    subscription_tier: string;
  } | null;
  anthropicShouldThrow?: boolean;
  onRateLimit?: (key: string, max: number) => void;
}): Promise<{ POST: (req: any) => Promise<Response> }> {
  vi.resetModules();

  // Mock Supabase server client
  vi.doMock('@/lib/supabase/server', () => ({
    createClient: vi.fn().mockResolvedValue({
      auth: {
        getUser: vi.fn().mockResolvedValue({
          data: { user: opts.mockUser ?? null },
        }),
      },
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              single: vi.fn().mockResolvedValue({
                data: opts.mockBusiness ?? null,
                error: opts.mockBusiness ? null : { message: 'Not found' },
              }),
            }),
          }),
        }),
      }),
    }),
  }));

  // Mock Anthropic SDK
  vi.doMock('@anthropic-ai/sdk', () => ({
    default: class MockAnthropic {
      messages = {
        create: opts.anthropicShouldThrow
          ? vi.fn().mockRejectedValue(new Error('API key missing or invalid'))
          : vi.fn().mockResolvedValue({
              content: [{ type: 'text', text: 'Test AI response' }],
            }),
      };
    },
  }));

  // Mock rate limiter
  vi.doMock('@/lib/rate-limit', () => ({
    rateLimitResponseAsync: vi.fn().mockImplementation(
      async (key: string, max: number, _window: number) => {
        opts.onRateLimit?.(key, max);
        return null; // Not rate-limited
      }
    ),
  }));

  // Mock logger
  vi.doMock('@/lib/logger', () => ({
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  }));

  // Mock AI tier guard
  vi.doMock('@/lib/bot/ai-tier-guard', () => ({
    checkAIFeature: vi.fn().mockResolvedValue({ allowed: true, reason: null }),
    incrementAIUsage: vi.fn().mockResolvedValue(undefined),
  }));

  const routeModule = await import('@/app/api/ai-setup/chat/route');
  return { POST: routeModule.POST };
}
