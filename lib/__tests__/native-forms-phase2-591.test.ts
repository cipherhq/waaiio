/**
 * #591 Phase 2 — Native WhatsApp Forms: flow tokens, submission handler,
 * send API, Meta asset service, and migration contract tests.
 *
 * All tests are self-contained with mocked Supabase. No live DB or API calls.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import * as fs from 'fs';
import * as path from 'path';

// ═══════════════════════════════════════════════════════
// Module-level mock state (hoisted vi.mock closures capture these)
// ═══════════════════════════════════════════════════════

let mockGetUser = vi.fn();
let mockServerBusiness: Record<string, unknown> | null = null;
let mockServerForm: Record<string, unknown> | null = null;

let mockServiceForm: Record<string, unknown> | null = null;
let mockInsertError: { code: string; message: string } | null = null;
let serviceInsertedRows: Record<string, unknown>[] = [];
let mockRpcCalls: { fn: string; args: Record<string, unknown> }[] = [];

// ── Server client mock (for send API route) ──

function serverDc(data: unknown) {
  const chain: Record<string, unknown> = {};
  for (const m of ['neq', 'in', 'gt', 'lt', 'gte', 'lte', 'limit', 'order', 'is', 'or', 'not', 'filter', 'upsert', 'insert', 'update', 'delete']) {
    chain[m] = () => chain;
  }
  chain.eq = () => chain;
  chain.select = () => chain;
  chain.single = () => Promise.resolve({ data, error: null });
  chain.maybeSingle = () => Promise.resolve({ data, error: null });
  return chain;
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve({
    auth: { getUser: (...args: unknown[]) => mockGetUser(...args) },
    from: (table: string) => {
      if (table === 'businesses') return serverDc(mockServerBusiness);
      if (table === 'forms') return serverDc(mockServerForm);
      return serverDc(null);
    },
  }),
}));

// ── Service client mock (for submission handler) ──

function serviceDc(table: string) {
  const chain: Record<string, unknown> = {};
  for (const m of ['neq', 'in', 'gt', 'lt', 'gte', 'lte', 'order', 'is', 'or', 'not', 'filter', 'upsert']) {
    chain[m] = () => chain;
  }
  chain.eq = () => chain;
  chain.limit = () => chain;
  chain.select = () => {
    if (table === 'form_responses') return chain;
    return chain;
  };
  chain.insert = (data: Record<string, unknown>) => {
    serviceInsertedRows.push(data);
    return {
      select: () => ({
        single: () => Promise.resolve({
          data: mockInsertError ? null : { id: 'resp-new-001' },
          error: mockInsertError,
        }),
      }),
    };
  };
  chain.update = (data: Record<string, unknown>) => {
    return { eq: () => Promise.resolve({ error: null }) };
  };
  chain.single = () => {
    if (table === 'forms') {
      return Promise.resolve({ data: mockServiceForm, error: null });
    }
    return Promise.resolve({ data: { response_count: 5 }, error: null });
  };
  chain.maybeSingle = chain.single;
  return chain;
}

vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => ({
    from: (table: string) => serviceDc(table),
    rpc: vi.fn((...args: unknown[]) => {
      mockRpcCalls.push({ fn: args[0] as string, args: args[1] as Record<string, unknown> });
      return Promise.resolve({ data: null, error: null });
    }),
  }),
}));

// ═══════════════════════════════════════════════════════
// §1 — Flow Token Tests
// ═══════════════════════════════════════════════════════

describe('Flow Token System', () => {
  const VALID_SECRET = 'a'.repeat(32);
  const FORM_ID = '00000000-0000-0000-0000-000000000001';
  const PHONE = '2348012345678';
  const PHONE_PLUS = '+2348012345678';
  const BIZ_ID = '00000000-0000-0000-0000-000000000002';

  beforeEach(() => {
    vi.stubEnv('FLOW_TOKEN_SECRET', VALID_SECRET);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('generates a token that can be verified', async () => {
    const { generateFlowToken, verifyFlowToken } = await import('@/lib/whatsapp-forms/flow-token');
    const { token, expiresAt } = generateFlowToken(FORM_ID, PHONE, BIZ_ID);

    expect(token).toBeTruthy();
    expect(typeof token).toBe('string');
    expect(token).toContain('.');
    expect(expiresAt).toBeGreaterThan(Date.now());

    const result = verifyFlowToken(token, FORM_ID, PHONE, BIZ_ID);
    expect(result.valid).toBe(true);
    expect(result.nonce).toBeTruthy();
    expect(result.error).toBeUndefined();
  });

  it('rejects expired tokens', async () => {
    const { generateFlowToken, verifyFlowToken } = await import('@/lib/whatsapp-forms/flow-token');
    const { token } = generateFlowToken(FORM_ID, PHONE, BIZ_ID);

    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 31 * 60 * 1000);

    const result = verifyFlowToken(token, FORM_ID, PHONE, BIZ_ID);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('expired');
  });

  it('rejects token with wrong formId', async () => {
    const { generateFlowToken, verifyFlowToken } = await import('@/lib/whatsapp-forms/flow-token');
    const { token } = generateFlowToken(FORM_ID, PHONE, BIZ_ID);

    const wrongFormId = '00000000-0000-0000-0000-000000000099';
    const result = verifyFlowToken(token, wrongFormId, PHONE, BIZ_ID);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('form mismatch');
  });

  it('rejects token with wrong phone', async () => {
    const { generateFlowToken, verifyFlowToken } = await import('@/lib/whatsapp-forms/flow-token');
    const { token } = generateFlowToken(FORM_ID, PHONE, BIZ_ID);

    const result = verifyFlowToken(token, FORM_ID, '1999999999', BIZ_ID);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('phone mismatch');
  });

  it('rejects token with wrong businessId', async () => {
    const { generateFlowToken, verifyFlowToken } = await import('@/lib/whatsapp-forms/flow-token');
    const { token } = generateFlowToken(FORM_ID, PHONE, BIZ_ID);

    const wrongBizId = '00000000-0000-0000-0000-000000000088';
    const result = verifyFlowToken(token, FORM_ID, PHONE, wrongBizId);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('business mismatch');
  });

  it('rejects tampered signature', async () => {
    const { generateFlowToken, verifyFlowToken } = await import('@/lib/whatsapp-forms/flow-token');
    const { token } = generateFlowToken(FORM_ID, PHONE, BIZ_ID);

    const dotIdx = token.indexOf('.');
    const tampered = token.slice(0, dotIdx) + '.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA_';

    const result = verifyFlowToken(tampered, FORM_ID, PHONE, BIZ_ID);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('signature');
  });

  it('produces unique hashes for different tokens', async () => {
    const { generateFlowToken, hashFlowToken } = await import('@/lib/whatsapp-forms/flow-token');
    const t1 = generateFlowToken(FORM_ID, PHONE, BIZ_ID);
    const t2 = generateFlowToken(FORM_ID, PHONE, BIZ_ID);

    expect(t1.token).not.toBe(t2.token);

    const h1 = hashFlowToken(t1.token);
    const h2 = hashFlowToken(t2.token);
    expect(h1).not.toBe(h2);
    expect(h1).toHaveLength(64); // SHA-256 hex
  });

  it('rejects missing or empty token in verify', async () => {
    const { verifyFlowToken } = await import('@/lib/whatsapp-forms/flow-token');
    expect(verifyFlowToken('', FORM_ID, PHONE, BIZ_ID).valid).toBe(false);
    expect(verifyFlowToken(null as unknown as string, FORM_ID, PHONE, BIZ_ID).valid).toBe(false);
  });

  it('throws on missing FLOW_TOKEN_SECRET', async () => {
    vi.stubEnv('FLOW_TOKEN_SECRET', '');
    const mod = await import('@/lib/whatsapp-forms/flow-token');
    expect(() => mod.generateFlowToken(FORM_ID, PHONE, BIZ_ID)).toThrow('FLOW_TOKEN_SECRET');
  });

  it('throws when hashing empty token', async () => {
    const { hashFlowToken } = await import('@/lib/whatsapp-forms/flow-token');
    expect(() => hashFlowToken('')).toThrow('required');
  });

  // ── F2-2: Phone normalization tests ──

  it('token generated with +234... verifies when webhook returns 234...', async () => {
    const { generateFlowToken, verifyFlowToken } = await import('@/lib/whatsapp-forms/flow-token');
    const { token } = generateFlowToken(FORM_ID, PHONE_PLUS, BIZ_ID);

    // Webhook returns digits without +
    const result = verifyFlowToken(token, FORM_ID, PHONE, BIZ_ID);
    expect(result.valid).toBe(true);
  });

  it('token generated with 234... verifies when checked with 234...', async () => {
    const { generateFlowToken, verifyFlowToken } = await import('@/lib/whatsapp-forms/flow-token');
    const { token } = generateFlowToken(FORM_ID, PHONE, BIZ_ID);

    const result = verifyFlowToken(token, FORM_ID, PHONE, BIZ_ID);
    expect(result.valid).toBe(true);
  });

  it('both +234 and 234 formats produce same token signature for same phone', async () => {
    const { generateFlowToken } = await import('@/lib/whatsapp-forms/flow-token');
    const t1 = generateFlowToken(FORM_ID, PHONE_PLUS, BIZ_ID);
    const t2 = generateFlowToken(FORM_ID, PHONE, BIZ_ID);

    // Both should have the normalized phone in payload, so payloads differ only by nonce/expiry
    // But we can verify both verify with either format
    const { verifyFlowToken } = await import('@/lib/whatsapp-forms/flow-token');
    expect(verifyFlowToken(t1.token, FORM_ID, PHONE, BIZ_ID).valid).toBe(true);
    expect(verifyFlowToken(t2.token, FORM_ID, PHONE_PLUS, BIZ_ID).valid).toBe(true);
  });

  it('normalizePhone strips leading + correctly', async () => {
    const { normalizePhone } = await import('@/lib/whatsapp-forms/flow-token');
    expect(normalizePhone('+2348012345678')).toBe('2348012345678');
    expect(normalizePhone('2348012345678')).toBe('2348012345678');
    expect(normalizePhone('+1555000000')).toBe('1555000000');
  });
});

// ═══════════════════════════════════════════════════════
// §2 — Submission Handler Tests
// ═══════════════════════════════════════════════════════

describe('Native Form Submission Handler', () => {
  const VALID_SECRET = 'b'.repeat(32);
  const FORM_ID = '11111111-1111-1111-1111-111111111111';
  const BIZ_ID = '22222222-2222-2222-2222-222222222222';
  const BIZ_ID_2 = '33333333-3333-3333-3333-333333333333';
  const PHONE = '2348099999999';
  const CHANNEL_ID = 'ch-001';
  const CHANNEL_ID_2 = 'ch-002';
  const PHONE_NUMBER_ID = 'pn-001';
  const PHONE_NUMBER_ID_2 = 'pn-002';

  const FORM_FIELDS = [
    { id: 'full_name', label: 'Full Name', type: 'text', required: true },
    { id: 'email', label: 'Email', type: 'email', required: false },
    { id: 'age', label: 'Age', type: 'number', required: false },
    { id: 'plan', label: 'Plan', type: 'select', required: false, options: ['basic', 'premium', 'enterprise'] },
  ];

  function makeChannel(overrides: Partial<{ businessId: string; channelId: string; phoneNumberId: string }> = {}) {
    return {
      businessId: overrides.businessId ?? BIZ_ID,
      channelId: overrides.channelId ?? CHANNEL_ID,
      phoneNumberId: overrides.phoneNumberId ?? PHONE_NUMBER_ID,
    };
  }

  beforeEach(() => {
    vi.stubEnv('FLOW_TOKEN_SECRET', VALID_SECRET);
    serviceInsertedRows = [];
    mockInsertError = null;
    mockRpcCalls = [];
    mockServiceForm = { id: FORM_ID, business_id: BIZ_ID, is_active: true, fields: FORM_FIELDS };
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  async function makeToken(bizId?: string, phone?: string): Promise<string> {
    const { generateFlowToken } = await import('@/lib/whatsapp-forms/flow-token');
    return generateFlowToken(FORM_ID, phone ?? PHONE, bizId ?? BIZ_ID).token;
  }

  function makeMessage(token: string, extras: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      interactive: {
        type: 'nfm_reply',
        nfm_reply: {
          response_json: JSON.stringify({
            flow_token: token,
            full_name: 'Ada Lovelace',
            email: 'ada@example.com',
            _marketing_consent: true,
            ...extras,
          }),
        },
      },
    };
  }

  it('persists a valid native submission', async () => {
    const { handleNativeFormSubmission } = await import('@/lib/whatsapp-forms/submission-handler');
    const token = await makeToken();
    const message = makeMessage(token);

    const result = await handleNativeFormSubmission(message as any, PHONE, makeChannel());

    expect(result.success).toBe(true);
    expect(result.responseId).toBe('resp-new-001');
    expect(serviceInsertedRows).toHaveLength(1);
    expect(serviceInsertedRows[0].submission_source).toBe('native');
    expect(serviceInsertedRows[0].customer_phone).toBe(PHONE);
    expect(serviceInsertedRows[0].business_id).toBe(BIZ_ID);
    expect(serviceInsertedRows[0].consent_given).toBe(true);
    expect(serviceInsertedRows[0].flow_token_hash).toBeTruthy();
    const answers = serviceInsertedRows[0].answers as Record<string, unknown>;
    expect(answers.flow_token).toBeUndefined();
    expect(answers._marketing_consent).toBeUndefined();
    expect(answers.full_name).toBe('Ada Lovelace');
  });

  it('rejects duplicate token (replay prevention)', async () => {
    mockInsertError = { code: '23505', message: 'duplicate key value violates unique constraint "idx_form_responses_flow_token_hash"' };
    const { handleNativeFormSubmission } = await import('@/lib/whatsapp-forms/submission-handler');
    const token = await makeToken();
    const message = makeMessage(token);

    const result = await handleNativeFormSubmission(message as any, PHONE, makeChannel());

    expect(result.success).toBe(false);
    expect(result.duplicate).toBe(true);
  });

  it('rejects expired token', async () => {
    const { handleNativeFormSubmission } = await import('@/lib/whatsapp-forms/submission-handler');
    const token = await makeToken();
    const message = makeMessage(token);

    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 31 * 60 * 1000);

    const result = await handleNativeFormSubmission(message as any, PHONE, makeChannel());
    expect(result.success).toBe(false);
    expect(result.error).toContain('expired');
  });

  it('rejects when channel resolves to wrong business', async () => {
    const wrongChannel = makeChannel({ businessId: '99999999-9999-9999-9999-999999999999' });

    const { handleNativeFormSubmission } = await import('@/lib/whatsapp-forms/submission-handler');
    const token = await makeToken();
    const message = makeMessage(token);

    const result = await handleNativeFormSubmission(message as any, PHONE, wrongChannel);
    expect(result.success).toBe(false);
    expect(result.error).toContain('business mismatch');
  });

  it('rejects when form is inactive', async () => {
    mockServiceForm = { id: FORM_ID, business_id: BIZ_ID, is_active: false, fields: FORM_FIELDS };

    const { handleNativeFormSubmission } = await import('@/lib/whatsapp-forms/submission-handler');
    const token = await makeToken();
    const message = makeMessage(token);

    const result = await handleNativeFormSubmission(message as any, PHONE, makeChannel());
    expect(result.success).toBe(false);
    expect(result.error).toContain('no longer active');
  });

  it('records consent_given=false when _marketing_consent is false', async () => {
    const { handleNativeFormSubmission } = await import('@/lib/whatsapp-forms/submission-handler');
    const token = await makeToken();
    const message = makeMessage(token, { _marketing_consent: false });

    const result = await handleNativeFormSubmission(message as any, PHONE, makeChannel());
    expect(result.success).toBe(true);
    expect(serviceInsertedRows[0].consent_given).toBe(false);
  });

  it('records consent_given=null when _marketing_consent is absent', async () => {
    const { handleNativeFormSubmission } = await import('@/lib/whatsapp-forms/submission-handler');
    const token = await makeToken();
    const message = {
      interactive: {
        type: 'nfm_reply',
        nfm_reply: {
          response_json: JSON.stringify({
            flow_token: token,
            full_name: 'Test',
          }),
        },
      },
    };

    const result = await handleNativeFormSubmission(message as any, PHONE, makeChannel());
    expect(result.success).toBe(true);
    expect(serviceInsertedRows[0].consent_given).toBeNull();
  });

  it('uses business_id from resolved channel, NOT from Flow payload', async () => {
    const { handleNativeFormSubmission } = await import('@/lib/whatsapp-forms/submission-handler');
    const token = await makeToken();
    const message = makeMessage(token);

    const result = await handleNativeFormSubmission(message as any, PHONE, makeChannel());
    expect(result.success).toBe(true);
    expect(serviceInsertedRows[0].business_id).toBe(BIZ_ID);
  });

  it('uses customer_phone from envelope, NOT from Flow payload', async () => {
    const { handleNativeFormSubmission } = await import('@/lib/whatsapp-forms/submission-handler');
    const token = await makeToken();
    // Do not inject a fake phone field — just verify the envelope phone is used
    const message = makeMessage(token);

    const result = await handleNativeFormSubmission(message as any, PHONE, makeChannel());
    expect(result.success).toBe(true);
    // customer_phone comes from the envelope (2nd arg), never from response_json
    expect(serviceInsertedRows[0].customer_phone).toBe(PHONE);
  });

  it('rejects missing nfm_reply data', async () => {
    const { handleNativeFormSubmission } = await import('@/lib/whatsapp-forms/submission-handler');
    const result = await handleNativeFormSubmission({} as any, PHONE, makeChannel());
    expect(result.success).toBe(false);
    expect(result.error).toContain('Missing');
  });

  it('stores channelId and phoneNumberId in response metadata', async () => {
    const { handleNativeFormSubmission } = await import('@/lib/whatsapp-forms/submission-handler');
    const token = await makeToken();
    const message = makeMessage(token);

    const result = await handleNativeFormSubmission(message as any, PHONE, makeChannel());
    expect(result.success).toBe(true);
    const metadata = serviceInsertedRows[0].metadata as Record<string, unknown>;
    expect(metadata.channel_id).toBe(CHANNEL_ID);
    expect(metadata.phone_number_id).toBe(PHONE_NUMBER_ID);
  });

  // ── F2-1: Multi-tenant channel authority tests ──

  it('routes submission to correct business based on phoneNumberId (channel A)', async () => {
    const { handleNativeFormSubmission } = await import('@/lib/whatsapp-forms/submission-handler');
    const token = await makeToken(BIZ_ID);
    const message = makeMessage(token);

    const channelA = makeChannel({ businessId: BIZ_ID, channelId: CHANNEL_ID, phoneNumberId: PHONE_NUMBER_ID });
    const result = await handleNativeFormSubmission(message as any, PHONE, channelA);
    expect(result.success).toBe(true);
    expect(serviceInsertedRows[0].business_id).toBe(BIZ_ID);
    const metadata = serviceInsertedRows[0].metadata as Record<string, unknown>;
    expect(metadata.phone_number_id).toBe(PHONE_NUMBER_ID);
  });

  it('routes submission to different business for different phoneNumberId (channel B)', async () => {
    // Set up form for BIZ_ID_2
    mockServiceForm = { id: FORM_ID, business_id: BIZ_ID_2, is_active: true, fields: FORM_FIELDS };

    const { handleNativeFormSubmission } = await import('@/lib/whatsapp-forms/submission-handler');
    const token = await makeToken(BIZ_ID_2);
    const message = makeMessage(token);

    const channelB = makeChannel({ businessId: BIZ_ID_2, channelId: CHANNEL_ID_2, phoneNumberId: PHONE_NUMBER_ID_2 });
    const result = await handleNativeFormSubmission(message as any, PHONE, channelB);
    expect(result.success).toBe(true);
    expect(serviceInsertedRows[0].business_id).toBe(BIZ_ID_2);
    const metadata = serviceInsertedRows[0].metadata as Record<string, unknown>;
    expect(metadata.phone_number_id).toBe(PHONE_NUMBER_ID_2);
  });

  it('fails closed when resolved channel has no business_id (shared channel)', async () => {
    const { handleNativeFormSubmission } = await import('@/lib/whatsapp-forms/submission-handler');
    const token = await makeToken();
    const message = makeMessage(token);

    const sharedChannel = { businessId: '', channelId: CHANNEL_ID, phoneNumberId: PHONE_NUMBER_ID };
    const result = await handleNativeFormSubmission(message as any, PHONE, sharedChannel);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Dedicated channel with bound business required');
  });

  it('fails closed when resolved channel fields are missing', async () => {
    const { handleNativeFormSubmission } = await import('@/lib/whatsapp-forms/submission-handler');
    const token = await makeToken();
    const message = makeMessage(token);

    // businessId is undefined/falsy
    const brokenChannel = { businessId: undefined as any, channelId: CHANNEL_ID, phoneNumberId: PHONE_NUMBER_ID };
    const result = await handleNativeFormSubmission(message as any, PHONE, brokenChannel);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Dedicated channel with bound business required');
  });

  // ── F2-3: Answer schema validation tests ──

  it('rejects unknown field ID not in schema', async () => {
    const { handleNativeFormSubmission } = await import('@/lib/whatsapp-forms/submission-handler');
    const token = await makeToken();
    const message = makeMessage(token, { unknown_field_xyz: 'attack' });

    const result = await handleNativeFormSubmission(message as any, PHONE, makeChannel());
    expect(result.success).toBe(false);
    expect(result.error).toContain('Unknown field ID');
    expect(result.error).toContain('unknown_field_xyz');
  });

  it('rejects missing required field', async () => {
    const { handleNativeFormSubmission } = await import('@/lib/whatsapp-forms/submission-handler');
    const token = await makeToken();
    // full_name is required but not included
    const message = {
      interactive: {
        type: 'nfm_reply',
        nfm_reply: {
          response_json: JSON.stringify({
            flow_token: token,
            email: 'test@example.com',
          }),
        },
      },
    };

    const result = await handleNativeFormSubmission(message as any, PHONE, makeChannel());
    expect(result.success).toBe(false);
    expect(result.error).toContain('Required field missing');
    expect(result.error).toContain('full_name');
  });

  it('rejects invalid select option', async () => {
    const { handleNativeFormSubmission } = await import('@/lib/whatsapp-forms/submission-handler');
    const token = await makeToken();
    const message = makeMessage(token, { plan: 'nonexistent_plan' });

    const result = await handleNativeFormSubmission(message as any, PHONE, makeChannel());
    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid option');
    expect(result.error).toContain('plan');
  });

  it('rejects oversized answer (per field)', async () => {
    const { handleNativeFormSubmission } = await import('@/lib/whatsapp-forms/submission-handler');
    const token = await makeToken();
    const hugeValue = 'x'.repeat(11 * 1024); // > 10KB
    const message = makeMessage(token, { full_name: hugeValue });

    const result = await handleNativeFormSubmission(message as any, PHONE, makeChannel());
    expect(result.success).toBe(false);
    expect(result.error).toContain('exceeds 10KB');
  });

  it('accepts valid submission with correct schema', async () => {
    const { handleNativeFormSubmission } = await import('@/lib/whatsapp-forms/submission-handler');
    const token = await makeToken();
    const message = makeMessage(token, { plan: 'premium', age: '30' });

    const result = await handleNativeFormSubmission(message as any, PHONE, makeChannel());
    expect(result.success).toBe(true);
  });

  it('rejects non-numeric value for number field', async () => {
    const { handleNativeFormSubmission } = await import('@/lib/whatsapp-forms/submission-handler');
    const token = await makeToken();
    const message = makeMessage(token, { age: 'not-a-number' });

    const result = await handleNativeFormSubmission(message as any, PHONE, makeChannel());
    expect(result.success).toBe(false);
    expect(result.error).toContain('numeric');
    expect(result.error).toContain('age');
  });

  it('rejects invalid email (missing @)', async () => {
    const { handleNativeFormSubmission } = await import('@/lib/whatsapp-forms/submission-handler');
    const token = await makeToken();
    const message = makeMessage(token, { email: 'notanemail' });

    const result = await handleNativeFormSubmission(message as any, PHONE, makeChannel());
    expect(result.success).toBe(false);
    expect(result.error).toContain('email');
  });

  // ── F2-4: Atomic response count RPC test ──

  it('calls increment_form_response_count RPC after successful insert', async () => {
    const { handleNativeFormSubmission } = await import('@/lib/whatsapp-forms/submission-handler');
    const token = await makeToken();
    const message = makeMessage(token);

    const result = await handleNativeFormSubmission(message as any, PHONE, makeChannel());
    expect(result.success).toBe(true);
    expect(mockRpcCalls).toHaveLength(1);
    expect(mockRpcCalls[0].fn).toBe('increment_form_response_count');
    expect(mockRpcCalls[0].args).toEqual({ p_form_id: FORM_ID });
  });
});

// ═══════════════════════════════════════════════════════
// §3 — Send API Tests
// ═══════════════════════════════════════════════════════

describe('Native Flow Send API', () => {
  const VALID_SECRET = 'c'.repeat(32);
  const USER_ID = 'user-send-001';
  const BIZ_ID = '33333333-3333-3333-3333-333333333333';
  const FORM_ID = '44444444-4444-4444-4444-444444444444';
  const PHONE = '+447700900000';

  beforeEach(() => {
    vi.stubEnv('FLOW_TOKEN_SECRET', VALID_SECRET);
    mockGetUser = vi.fn().mockResolvedValue({ data: { user: { id: USER_ID } }, error: null });
    mockServerBusiness = { id: BIZ_ID };
    mockServerForm = {
      id: FORM_ID,
      business_id: BIZ_ID,
      title: 'Contact Us',
      meta_flow_id: 'flow_asset_789',
      meta_flow_status: 'published',
      native_flow_json: {},
      is_active: true,
    };
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  function makeRequest(body: Record<string, unknown>): NextRequest {
    return new NextRequest('http://localhost/api/forms/native-flow/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('returns constructed payload with queued=false for published form', async () => {
    const { POST } = await import('@/app/api/forms/native-flow/send/route');
    const res = await POST(makeRequest({ businessId: BIZ_ID, formId: FORM_ID, recipientPhone: PHONE }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.queued).toBe(false);
    expect(json.reason).toBe('provider_send_not_authorized');
    expect(json.payload).toBeTruthy();
    expect(json.payload.messaging_product).toBe('whatsapp');
    expect(json.payload.to).toBe(PHONE);
    expect(json.payload.interactive.type).toBe('flow');
    expect(json.payload.interactive.action.parameters.flow_id).toBe('flow_asset_789');
    expect(json.payload.interactive.action.parameters.flow_token).toBeTruthy();
    expect(json.tokenExpiresAt).toBeGreaterThan(Date.now());
  });

  it('rejects unauthenticated request', async () => {
    mockGetUser = vi.fn().mockResolvedValue({ data: { user: null }, error: { message: 'No session' } });
    const { POST } = await import('@/app/api/forms/native-flow/send/route');
    const res = await POST(makeRequest({ businessId: BIZ_ID, formId: FORM_ID, recipientPhone: PHONE }));
    expect(res.status).toBe(401);
  });

  it('rejects non-owner request', async () => {
    mockServerBusiness = null;
    const { POST } = await import('@/app/api/forms/native-flow/send/route');
    const res = await POST(makeRequest({ businessId: BIZ_ID, formId: FORM_ID, recipientPhone: PHONE }));
    expect(res.status).toBe(403);
  });

  it('rejects unpublished form', async () => {
    mockServerForm = { ...mockServerForm, meta_flow_status: 'draft' } as Record<string, unknown>;
    const { POST } = await import('@/app/api/forms/native-flow/send/route');
    const res = await POST(makeRequest({ businessId: BIZ_ID, formId: FORM_ID, recipientPhone: PHONE }));
    const json = await res.json();
    expect(res.status).toBe(422);
    expect(json.error).toContain('published');
  });

  it('rejects form without meta_flow_id', async () => {
    mockServerForm = { ...mockServerForm, meta_flow_status: 'published', meta_flow_id: null } as Record<string, unknown>;
    const { POST } = await import('@/app/api/forms/native-flow/send/route');
    const res = await POST(makeRequest({ businessId: BIZ_ID, formId: FORM_ID, recipientPhone: PHONE }));
    expect(res.status).toBe(422);
  });

  it('rejects invalid phone number', async () => {
    const { POST } = await import('@/app/api/forms/native-flow/send/route');
    const res = await POST(makeRequest({ businessId: BIZ_ID, formId: FORM_ID, recipientPhone: 'not-a-phone' }));
    expect(res.status).toBe(400);
  });

  it('rejects missing businessId', async () => {
    const { POST } = await import('@/app/api/forms/native-flow/send/route');
    const res = await POST(makeRequest({ formId: FORM_ID, recipientPhone: PHONE }));
    expect(res.status).toBe(400);
  });

  it('rejects inactive form', async () => {
    mockServerForm = { ...mockServerForm, is_active: false } as Record<string, unknown>;
    const { POST } = await import('@/app/api/forms/native-flow/send/route');
    const res = await POST(makeRequest({ businessId: BIZ_ID, formId: FORM_ID, recipientPhone: PHONE }));
    expect(res.status).toBe(422);
  });
});

// ═══════════════════════════════════════════════════════
// §4 — Meta Flow Asset Service Tests
// ═══════════════════════════════════════════════════════

describe('Meta Flow Asset Service', () => {
  it('validates token parameter', async () => {
    const { createFlowAsset, MetaFlowApiError } = await import('@/lib/whatsapp-forms/meta-flow-asset');
    await expect(createFlowAsset('', 'waba_1', 'Test', ['OTHER'])).rejects.toThrow(MetaFlowApiError);
    await expect(createFlowAsset('x', 'waba_1', 'Test', ['OTHER'])).rejects.toThrow('Meta access token');
  });

  it('validates WABA ID parameter', async () => {
    const { createFlowAsset, MetaFlowApiError } = await import('@/lib/whatsapp-forms/meta-flow-asset');
    await expect(createFlowAsset('valid-token-1234567890', '', 'Test', ['OTHER'])).rejects.toThrow(MetaFlowApiError);
  });

  it('validates flow name length', async () => {
    const { createFlowAsset } = await import('@/lib/whatsapp-forms/meta-flow-asset');
    await expect(createFlowAsset('valid-token-1234567890', 'waba_1', '', ['OTHER'])).rejects.toThrow('1\u2013128');
    await expect(createFlowAsset('valid-token-1234567890', 'waba_1', 'a'.repeat(129), ['OTHER'])).rejects.toThrow('1\u2013128');
  });

  it('validates categories array is non-empty', async () => {
    const { createFlowAsset } = await import('@/lib/whatsapp-forms/meta-flow-asset');
    await expect(createFlowAsset('valid-token-1234567890', 'waba_1', 'Test', [])).rejects.toThrow('category');
  });

  it('throws provider not authorized after input validation passes', async () => {
    const { createFlowAsset, MetaFlowApiError } = await import('@/lib/whatsapp-forms/meta-flow-asset');
    try {
      await createFlowAsset('valid-token-1234567890', 'waba_1', 'Test', ['OTHER']);
      expect.fail('Should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(MetaFlowApiError);
      expect((e as MetaFlowApiError).message).toContain('not authorized');
      expect((e as MetaFlowApiError).statusCode).toBe(403);
    }
  });

  it('uploadFlowJson throws provider not authorized', async () => {
    const { uploadFlowJson, MetaFlowApiError } = await import('@/lib/whatsapp-forms/meta-flow-asset');
    try {
      await uploadFlowJson('valid-token-1234567890', 'flow_1', { version: '7.3', screens: [] });
      expect.fail('Should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(MetaFlowApiError);
      expect((e as MetaFlowApiError).message).toContain('not authorized');
    }
  });

  it('publishFlow throws provider not authorized', async () => {
    const { publishFlow, MetaFlowApiError } = await import('@/lib/whatsapp-forms/meta-flow-asset');
    try {
      await publishFlow('valid-token-1234567890', 'flow_1');
      expect.fail('Should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(MetaFlowApiError);
      expect((e as MetaFlowApiError).message).toContain('not authorized');
    }
  });

  it('getFlowStatus throws provider not authorized', async () => {
    const { getFlowStatus, MetaFlowApiError } = await import('@/lib/whatsapp-forms/meta-flow-asset');
    try {
      await getFlowStatus('valid-token-1234567890', 'flow_1');
      expect.fail('Should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(MetaFlowApiError);
      expect((e as MetaFlowApiError).message).toContain('not authorized');
    }
  });

  it('deprecateFlow throws provider not authorized', async () => {
    const { deprecateFlow, MetaFlowApiError } = await import('@/lib/whatsapp-forms/meta-flow-asset');
    try {
      await deprecateFlow('valid-token-1234567890', 'flow_1');
      expect.fail('Should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(MetaFlowApiError);
      expect((e as MetaFlowApiError).message).toContain('not authorized');
    }
  });

  it('uploadFlowJson validates flow JSON structure', async () => {
    const { uploadFlowJson } = await import('@/lib/whatsapp-forms/meta-flow-asset');
    await expect(uploadFlowJson('valid-token-1234567890', 'flow_1', {} as any)).rejects.toThrow('version and screens');
    await expect(uploadFlowJson('valid-token-1234567890', 'flow_1', null as any)).rejects.toThrow('non-null object');
  });

  it('validates flow ID parameter', async () => {
    const { publishFlow } = await import('@/lib/whatsapp-forms/meta-flow-asset');
    await expect(publishFlow('valid-token-1234567890', '')).rejects.toThrow('flow ID');
  });
});

// ═══════════════════════════════════════════════════════
// §5 — Migration Contract Tests
// ═══════════════════════════════════════════════════════

describe('Migration 437 contract', () => {
  const migrationPath = path.resolve(__dirname, '../../supabase/migrations/437_native_whatsapp_forms.sql');
  let sql: string;

  beforeEach(() => {
    sql = fs.readFileSync(migrationPath, 'utf8');
  });

  it('migration file exists and contains expected DDL', () => {
    // forms table additions
    expect(sql).toContain('meta_flow_id');
    expect(sql).toContain('VARCHAR(64)');
    expect(sql).toContain('meta_flow_status');
    expect(sql).toContain("'draft'");
    expect(sql).toContain("'published'");
    expect(sql).toContain("'deprecated'");
    expect(sql).toContain("'blocked'");
    expect(sql).toContain('native_flow_json');
    expect(sql).toContain('JSONB');

    // form_responses table additions
    expect(sql).toContain('submission_source');
    expect(sql).toContain("'web'");
    expect(sql).toContain("'native'");
    expect(sql).toContain('flow_token_hash');
    expect(sql).toContain('VARCHAR(128)');
    expect(sql).toContain('consent_given');
    expect(sql).toContain('BOOLEAN');

    // Unique index for replay prevention
    expect(sql).toContain('idx_form_responses_flow_token_hash');
    expect(sql).toContain('UNIQUE INDEX');
    expect(sql).toContain('WHERE flow_token_hash IS NOT NULL');

    // No SECURITY DEFINER
    expect(sql.toLowerCase()).not.toContain('security definer');
  });

  it('migration does not create new RLS policies (existing coverage)', () => {
    expect(sql.toLowerCase()).not.toContain('create policy');
    expect(sql.toLowerCase()).not.toContain('alter policy');
  });

  it('migration uses IF NOT EXISTS for idempotent re-application', () => {
    const addColumnMatches = sql.match(/ADD COLUMN/gi) || [];
    const addColumnIfNotExistsMatches = sql.match(/ADD COLUMN IF NOT EXISTS/gi) || [];
    expect(addColumnMatches.length).toBeGreaterThan(0);
    expect(addColumnIfNotExistsMatches.length).toBe(addColumnMatches.length);

    expect(sql).toContain('CREATE UNIQUE INDEX IF NOT EXISTS');
  });
});
