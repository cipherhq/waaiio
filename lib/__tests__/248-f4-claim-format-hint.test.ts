/**
 * #248-F4: Claim format hint in bot entry and invalid-code messages.
 *
 * Tests:
 * - Entry message includes format hint when code_format is set
 * - Entry message omits format hint when code_format is null
 * - Multiple campaigns each show their own format
 * - Invalid code response includes format guidance when code_format is set
 * - Invalid code response omits format guidance when code_format is null
 * - Existing promo verification behavior unchanged (looksLikePromoCode)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock Supabase service client before importing modules ──
const mockRpc = vi.fn();
const mockChain: Record<string, any> = {};
mockChain.select = vi.fn().mockReturnValue(mockChain);
mockChain.eq = vi.fn().mockReturnValue(mockChain);
mockChain.ilike = vi.fn().mockReturnValue(mockChain);
mockChain.order = vi.fn().mockReturnValue(mockChain);
mockChain.limit = vi.fn().mockReturnValue(mockChain);
mockChain.single = vi.fn().mockResolvedValue({ data: null, error: null });

vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => ({
    from: vi.fn(() => ({ ...mockChain })),
    rpc: mockRpc,
  }),
}));

vi.mock('@/lib/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import { renderPromoEntryMessage, type PromoEntryCampaign } from '@/lib/promotions/entry';
import { looksLikePromoCode } from '@/lib/promotions/verify';

// ══════════════════════════════════════════════════════════
// ENTRY MESSAGE — FORMAT HINT PRESENT
// ══════════════════════════════════════════════════════════

describe('#248-F4: Entry message format hint', () => {
  it('single keyword campaign with code_format shows format hint', () => {
    const campaigns: PromoEntryCampaign[] = [{
      id: 'c1',
      name: 'Summer Promo',
      keyword: 'SUMMER',
      code_entry_mode: 'keyword',
      accept_bare_codes: false,
      code_format: 'XXXX-XXXX-XXXX',
    }];
    const msg = renderPromoEntryMessage(campaigns);
    expect(msg).toContain('Summer Promo');
    expect(msg).toContain('SUMMER <your code>');
    expect(msg).toContain('Code format: *XXXX-XXXX-XXXX*');
  });

  it('single bare-code campaign with code_format shows format hint', () => {
    const campaigns: PromoEntryCampaign[] = [{
      id: 'c2',
      name: 'Scratch & Win',
      keyword: null,
      code_entry_mode: 'bare_code',
      accept_bare_codes: true,
      code_format: 'WIN-XXXXXX',
    }];
    const msg = renderPromoEntryMessage(campaigns);
    expect(msg).toContain('Send your promo code now:');
    expect(msg).toContain('Code format: *WIN-XXXXXX*');
  });

  it('single campaign without code_format omits format hint', () => {
    const campaigns: PromoEntryCampaign[] = [{
      id: 'c3',
      name: 'Lucky Draw',
      keyword: 'LUCKY',
      code_entry_mode: 'keyword',
      accept_bare_codes: false,
      code_format: null,
    }];
    const msg = renderPromoEntryMessage(campaigns);
    expect(msg).toContain('Lucky Draw');
    expect(msg).toContain('LUCKY <your code>');
    expect(msg).not.toContain('Code format');
    expect(msg).not.toContain('format:');
  });

  it('multiple campaigns each show their own format', () => {
    const campaigns: PromoEntryCampaign[] = [
      {
        id: 'c4',
        name: 'Alpha Promo',
        keyword: 'ALPHA',
        code_entry_mode: 'keyword',
        accept_bare_codes: false,
        code_format: 'XXXX-XXXX',
      },
      {
        id: 'c5',
        name: 'Beta Promo',
        keyword: null,
        code_entry_mode: 'bare_code',
        accept_bare_codes: true,
        code_format: 'BETA-XXXXXX',
      },
    ];
    const msg = renderPromoEntryMessage(campaigns);
    expect(msg).toContain('Active Promotions');
    expect(msg).toContain('Alpha Promo');
    expect(msg).toContain('(format: XXXX-XXXX)');
    expect(msg).toContain('Beta Promo');
    expect(msg).toContain('(format: BETA-XXXXXX)');
  });

  it('multiple campaigns omit format when code_format is null', () => {
    const campaigns: PromoEntryCampaign[] = [
      {
        id: 'c6',
        name: 'NoFormat A',
        keyword: 'NFA',
        code_entry_mode: 'keyword',
        accept_bare_codes: false,
        code_format: null,
      },
      {
        id: 'c7',
        name: 'NoFormat B',
        keyword: null,
        code_entry_mode: 'bare_code',
        accept_bare_codes: true,
        code_format: null,
      },
    ];
    const msg = renderPromoEntryMessage(campaigns);
    expect(msg).toContain('Active Promotions');
    expect(msg).not.toContain('format:');
  });

  it('multiple campaigns mix: one with format, one without', () => {
    const campaigns: PromoEntryCampaign[] = [
      {
        id: 'c8',
        name: 'Has Format',
        keyword: 'HAS',
        code_entry_mode: 'keyword',
        accept_bare_codes: false,
        code_format: 'HAS-XXXX-XXXX',
      },
      {
        id: 'c9',
        name: 'No Format',
        keyword: null,
        code_entry_mode: 'bare_code',
        accept_bare_codes: true,
        code_format: null,
      },
    ];
    const msg = renderPromoEntryMessage(campaigns);
    expect(msg).toContain('(format: HAS-XXXX-XXXX)');
    // The no-format campaign line should NOT have a format suffix
    const rendered = msg;
    const msgLines = rendered.split('\n');
    const noFormatLine = msgLines.find(l => l.includes('No Format'));
    expect(noFormatLine).toBeDefined();
    expect(noFormatLine).not.toContain('format:');
  });
});

// ══════════════════════════════════════════════════════════
// INVALID CODE RESPONSE — FORMAT HINT
// ══════════════════════════════════════════════════════════

describe('#248-F4: Invalid code response format hint (verify.ts)', () => {
  beforeEach(() => {
    mockRpc.mockReset();
    mockChain.single.mockReset();
  });

  it('invalid result includes format hint when campaign has code_format', async () => {
    // Mock campaign resolution: return a campaign with code_format
    const campaign = {
      id: 'camp-fmt',
      business_id: 'biz1',
      name: 'Format Campaign',
      status: 'active',
      keyword: 'FMT',
      accept_bare_codes: false,
      code_format: 'XXXX-XXXX-XXXX',
      code_entry_mode: 'keyword',
      code_length: 12,
      code_prefix: null,
      invalid_message: 'That code is not valid.',
      winner_message: 'You won!',
      try_again_message: 'Better luck next time.',
      already_used_message: 'Already claimed.',
      expired_message: 'Expired.',
      max_attempts_per_phone: 10,
      rate_limit_window_minutes: 60,
      rate_limit_max_attempts: 10,
      max_wins_per_participant: null,
      eligibility_mode: 'none',
      eligibility_prompt: null,
      eligibility_min_age: null,
      integrity_locked: false,
      timezone: 'UTC',
      description: null,
      start_at: null,
      end_at: null,
      created_by: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    // resolveCampaign uses .single() on keyword query
    mockChain.single.mockResolvedValueOnce({ data: campaign, error: null });

    // claim_promo_code RPC returns invalid result
    mockRpc.mockResolvedValueOnce({
      data: { success: false, result: 'invalid' },
      error: null,
    });

    const { verifyPromoCode } = await import('@/lib/promotions/verify');
    const result = await verifyPromoCode({
      businessId: 'biz1',
      rawCode: 'BADCODE123',
      phoneE164: '+2341234567890',
      keyword: 'FMT',
    });

    expect(result.result).toBe('invalid');
    expect(result.message).toContain('That code is not valid.');
    expect(result.message).toContain('Expected format: *XXXX-XXXX-XXXX*');
  });

  it('invalid result omits format hint when campaign has no code_format', async () => {
    const campaign = {
      id: 'camp-nofmt',
      business_id: 'biz1',
      name: 'No Format Campaign',
      status: 'active',
      keyword: 'NOFMT',
      accept_bare_codes: false,
      code_format: '',  // empty string, treated as falsy
      code_entry_mode: 'keyword',
      code_length: 12,
      code_prefix: null,
      invalid_message: 'Invalid code entered.',
      winner_message: 'You won!',
      try_again_message: 'Try again.',
      already_used_message: 'Already claimed.',
      expired_message: 'Expired.',
      max_attempts_per_phone: 10,
      rate_limit_window_minutes: 60,
      rate_limit_max_attempts: 10,
      max_wins_per_participant: null,
      eligibility_mode: 'none',
      eligibility_prompt: null,
      eligibility_min_age: null,
      integrity_locked: false,
      timezone: 'UTC',
      description: null,
      start_at: null,
      end_at: null,
      created_by: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    mockChain.single.mockResolvedValueOnce({ data: campaign, error: null });
    mockRpc.mockResolvedValueOnce({
      data: { success: false, result: 'invalid' },
      error: null,
    });

    const { verifyPromoCode } = await import('@/lib/promotions/verify');
    const result = await verifyPromoCode({
      businessId: 'biz1',
      rawCode: 'BADCODE123',
      phoneE164: '+2341234567890',
      keyword: 'NOFMT',
    });

    expect(result.result).toBe('invalid');
    expect(result.message).toBe('Invalid code entered.');
    expect(result.message).not.toContain('Expected format');
  });

  it('RPC error path includes format hint when code_format is set', async () => {
    const campaign = {
      id: 'camp-rpc',
      business_id: 'biz1',
      name: 'RPC Error Campaign',
      status: 'active',
      keyword: 'RPC',
      accept_bare_codes: false,
      code_format: 'WIN-XXXXXX',
      code_entry_mode: 'keyword',
      code_length: 12,
      code_prefix: null,
      invalid_message: 'Code not recognized.',
      winner_message: 'You won!',
      try_again_message: 'Try again.',
      already_used_message: 'Already used.',
      expired_message: 'Expired.',
      max_attempts_per_phone: 10,
      rate_limit_window_minutes: 60,
      rate_limit_max_attempts: 10,
      max_wins_per_participant: null,
      eligibility_mode: 'none',
      eligibility_prompt: null,
      eligibility_min_age: null,
      integrity_locked: false,
      timezone: 'UTC',
      description: null,
      start_at: null,
      end_at: null,
      created_by: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    mockChain.single.mockResolvedValueOnce({ data: campaign, error: null });
    // RPC returns an error (not a data result)
    mockRpc.mockResolvedValueOnce({
      data: null,
      error: { message: 'RPC failed' },
    });

    const { verifyPromoCode } = await import('@/lib/promotions/verify');
    const result = await verifyPromoCode({
      businessId: 'biz1',
      rawCode: 'BADCODE',
      phoneE164: '+2341234567890',
      keyword: 'RPC',
    });

    expect(result.result).toBe('invalid');
    expect(result.message).toContain('Code not recognized.');
    expect(result.message).toContain('Expected format: *WIN-XXXXXX*');
  });

  it('winner result does NOT get format hint appended', async () => {
    const campaign = {
      id: 'camp-win',
      business_id: 'biz1',
      name: 'Winner Campaign',
      status: 'active',
      keyword: 'WIN',
      accept_bare_codes: false,
      code_format: 'XXXX-XXXX',
      code_entry_mode: 'keyword',
      code_length: 12,
      code_prefix: null,
      invalid_message: 'Invalid.',
      winner_message: 'Congratulations! You won {prize_name}!',
      try_again_message: 'Try again.',
      already_used_message: 'Already used.',
      expired_message: 'Expired.',
      max_attempts_per_phone: 10,
      rate_limit_window_minutes: 60,
      rate_limit_max_attempts: 10,
      max_wins_per_participant: null,
      eligibility_mode: 'none',
      eligibility_prompt: null,
      eligibility_min_age: null,
      integrity_locked: false,
      timezone: 'UTC',
      description: null,
      start_at: null,
      end_at: null,
      created_by: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    mockChain.single.mockResolvedValueOnce({ data: campaign, error: null });
    mockRpc.mockResolvedValueOnce({
      data: {
        success: true,
        result: 'winner',
        claim_reference: 'CLM-123',
        prize_name: 'iPhone',
        verification_mode: 'standard',
      },
      error: null,
    });
    // Business name lookup for claim block
    mockChain.single.mockResolvedValueOnce({ data: { name: 'TestBiz' }, error: null });

    const { verifyPromoCode } = await import('@/lib/promotions/verify');
    const result = await verifyPromoCode({
      businessId: 'biz1',
      rawCode: 'VALIDCODE123',
      phoneE164: '+2341234567890',
      keyword: 'WIN',
    });

    expect(result.result).toBe('winner');
    expect(result.message).toContain('Congratulations! You won iPhone!');
    // Format hint should NOT be present on winner messages
    expect(result.message).not.toContain('Expected format');
  });

  it('try_again result does NOT get format hint appended', async () => {
    const campaign = {
      id: 'camp-try',
      business_id: 'biz1',
      name: 'Try Again Campaign',
      status: 'active',
      keyword: 'TRY',
      accept_bare_codes: false,
      code_format: 'XXXX-XXXX',
      code_entry_mode: 'keyword',
      code_length: 12,
      code_prefix: null,
      invalid_message: 'Invalid.',
      winner_message: 'You won!',
      try_again_message: 'Better luck next time!',
      already_used_message: 'Already used.',
      expired_message: 'Expired.',
      max_attempts_per_phone: 10,
      rate_limit_window_minutes: 60,
      rate_limit_max_attempts: 10,
      max_wins_per_participant: null,
      eligibility_mode: 'none',
      eligibility_prompt: null,
      eligibility_min_age: null,
      integrity_locked: false,
      timezone: 'UTC',
      description: null,
      start_at: null,
      end_at: null,
      created_by: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    mockChain.single.mockResolvedValueOnce({ data: campaign, error: null });
    mockRpc.mockResolvedValueOnce({
      data: { success: true, result: 'try_again' },
      error: null,
    });

    const { verifyPromoCode } = await import('@/lib/promotions/verify');
    const result = await verifyPromoCode({
      businessId: 'biz1',
      rawCode: 'SOMECODE123',
      phoneE164: '+2341234567890',
      keyword: 'TRY',
    });

    expect(result.result).toBe('try_again');
    expect(result.message).toBe('Better luck next time!');
    // Format hint should NOT be present on try_again messages
    expect(result.message).not.toContain('Expected format');
  });
});

// ══════════════════════════════════════════════════════════
// EXISTING BEHAVIOR — UNCHANGED
// ══════════════════════════════════════════════════════════

describe('#248-F4: Existing promo code recognition unchanged', () => {
  it('looksLikePromoCode accepts valid promo codes', () => {
    expect(looksLikePromoCode('K7PM4XQ9')).toBe(true);
    expect(looksLikePromoCode('K7PM-4XQ9-N2WF')).toBe(true);
    expect(looksLikePromoCode('WIN123ABC')).toBe(true);
    expect(looksLikePromoCode('A1B2C3')).toBe(true);
  });

  it('looksLikePromoCode rejects natural language', () => {
    expect(looksLikePromoCode('hello world')).toBe(false);
    expect(looksLikePromoCode('I want to book')).toBe(false);
    expect(looksLikePromoCode('cancel')).toBe(false);
    expect(looksLikePromoCode('ABCDEF')).toBe(false); // no digit
  });

  it('looksLikePromoCode rejects too-short or too-long codes', () => {
    expect(looksLikePromoCode('A1B2C')).toBe(false); // 5 chars
    expect(looksLikePromoCode('A1B2C3D4E5F6G7H8I9J0K1L2M')).toBe(false); // 25 chars
  });
});
