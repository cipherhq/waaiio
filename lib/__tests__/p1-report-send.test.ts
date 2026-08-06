/**
 * P1-REPORT-1 — Executable route-level document send tests
 *
 * Every critical case calls POST from app/api/reports/send/route.ts.
 * Uses a sequenced Supabase mock that returns different results per from() call.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import * as fs from 'fs';
import * as path from 'path';

const { mockSendText, mockResolveByBusinessId, mockAuthResult } = vi.hoisted(() => ({
  mockSendText: vi.fn(),
  mockResolveByBusinessId: vi.fn(),
  mockAuthResult: { ref: null as any },
}));

vi.mock('@/lib/api-auth', () => ({
  authenticateRequest: vi.fn().mockImplementation(async () => mockAuthResult.ref),
}));
vi.mock('@/lib/channels/channel-resolver', () => ({
  ChannelResolver: class { resolveByBusinessId = mockResolveByBusinessId; },
}));
vi.mock('@/lib/rate-limit', () => ({
  rateLimitResponseAsync: vi.fn().mockResolvedValue(null),
  getRateLimitKey: vi.fn().mockReturnValue('test'),
}));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

// ── Sequenced Supabase mock ──
// Each from() call returns a chainable builder.
// The builder tracks whether it's a SELECT (.single) or UPDATE+SELECT (.update.*.maybeSingle).
// Results are configured per-call via a sequence array.
type SeqResult = { data: unknown; error: unknown };

function buildSeqService(sequence: SeqResult[]) {
  let callIdx = 0;
  const calls: { idx: number; method: string }[] = [];

  return {
    _calls: calls,
    from: vi.fn().mockImplementation(() => {
      const myIdx = callIdx++;
      const result = sequence[myIdx] ?? { data: null, error: null };

      // Build a fully chainable object
      const chain: Record<string, any> = {};
      const self = () => chain;
      ['select', 'eq', 'is', 'neq', 'in', 'or', 'order', 'limit'].forEach(m => { chain[m] = vi.fn(self); });

      // Terminal: .single() — report SELECT
      chain.single = vi.fn().mockImplementation(() => {
        calls.push({ idx: myIdx, method: 'single' });
        return Promise.resolve(result);
      });

      // .update() returns a sub-chain
      chain.update = vi.fn().mockImplementation(() => {
        const uc: Record<string, any> = {};
        const uself = () => uc;
        ['eq', 'neq', 'is'].forEach(m => { uc[m] = vi.fn(uself); });

        // .select('id') after update returns another sub-chain with .maybeSingle()
        uc.select = vi.fn().mockImplementation(() => {
          const sc: Record<string, any> = {};
          const scself = () => sc;
          ['eq', 'neq'].forEach(m => { sc[m] = vi.fn(scself); });
          sc.maybeSingle = vi.fn().mockImplementation(() => {
            calls.push({ idx: myIdx, method: 'update+maybeSingle' });
            return Promise.resolve(result);
          });
          return sc;
        });

        // Also make uc itself awaitable for simple .update().eq() patterns
        uc.then = (fn: (v: unknown) => void) => {
          calls.push({ idx: myIdx, method: 'update+then' });
          return Promise.resolve(result).then(fn);
        };

        return uc;
      });

      return chain;
    }),
  };
}

const REPORT = {
  id: 'rpt-001', business_id: 'biz-001', customer_phone: '+2341234567890',
  title: 'Test Doc', status: 'pending', businesses: { id: 'biz-001', name: 'Biz' },
};

function makeReq(body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/reports/send', {
    method: 'POST', body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('P1-REPORT-1: Executable route tests', () => {
  beforeEach(() => {
    mockSendText.mockReset().mockResolvedValue(undefined);
    mockResolveByBusinessId.mockReset().mockResolvedValue({ sender: { sendText: mockSendText } });
  });

  // Per-report from() sequence:
  //   call 0: report SELECT (.single)
  //   call 1: token UPDATE (.update.*.select.maybeSingle)
  //   call 2: status UPDATE (.update.*.eq → awaitable)

  it('1. successful send: token persisted, sender called, result=sent', async () => {
    const sb = buildSeqService([
      { data: { ...REPORT }, error: null },        // 0: report SELECT
      { data: { id: 'rpt-001' }, error: null },    // 1: token UPDATE (1 row)
      { data: null, error: null },                  // 2: status UPDATE
    ]);
    mockAuthResult.ref = { user: { id: 'u1' }, businessId: 'biz-001', service: sb };

    const req = makeReq({ reportIds: ['rpt-001'], businessId: 'biz-001' });
    expect(req.headers.get('Authorization')).toBeNull();

    const { POST } = await import('../../app/api/reports/send/route');
    const res = await POST(req);
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.results).toHaveLength(1);
    expect(json.results[0].status).toBe('sent');
    expect(mockSendText).toHaveBeenCalledTimes(1);
    expect(mockSendText.mock.calls[0][0].text).toContain('/doc/');
  });

  it('2. token DB error: result=failed, no send', async () => {
    const sb = buildSeqService([
      { data: { ...REPORT }, error: null },                    // report found
      { data: null, error: { message: 'constraint' } },       // token UPDATE error
    ]);
    mockAuthResult.ref = { user: { id: 'u1' }, businessId: 'biz-001', service: sb };

    const { POST } = await import('../../app/api/reports/send/route');
    const res = await POST(makeReq({ reportIds: ['rpt-001'], businessId: 'biz-001' }));
    const json = await res.json();

    expect(json.results[0].status).toBe('failed');
    expect(mockSendText).not.toHaveBeenCalled();
  });

  it('3. token zero-row update: result=failed, no send', async () => {
    const sb = buildSeqService([
      { data: { ...REPORT }, error: null },    // report found
      { data: null, error: null },             // token UPDATE zero rows
    ]);
    mockAuthResult.ref = { user: { id: 'u1' }, businessId: 'biz-001', service: sb };

    const { POST } = await import('../../app/api/reports/send/route');
    const res = await POST(makeReq({ reportIds: ['rpt-001'], businessId: 'biz-001' }));
    const json = await res.json();

    expect(json.results[0].status).toBe('failed');
    expect(mockSendText).not.toHaveBeenCalled();
  });

  it('4. cross-business report: not_found, no send', async () => {
    const sb = buildSeqService([
      { data: null, error: null },    // report not found (business_id excluded)
    ]);
    mockAuthResult.ref = { user: { id: 'u1' }, businessId: 'biz-001', service: sb };

    const { POST } = await import('../../app/api/reports/send/route');
    const res = await POST(makeReq({ reportIds: ['rpt-999'], businessId: 'biz-001' }));
    const json = await res.json();

    expect(json.results[0].status).toBe('not_found');
    expect(mockSendText).not.toHaveBeenCalled();
  });

  it('5. channel failure: result=failed, no send', async () => {
    mockResolveByBusinessId.mockResolvedValue(null);
    const sb = buildSeqService([
      { data: { ...REPORT }, error: null },
      { data: { id: 'rpt-001' }, error: null },
      { data: null, error: null },  // failed status update
    ]);
    mockAuthResult.ref = { user: { id: 'u1' }, businessId: 'biz-001', service: sb };

    const { POST } = await import('../../app/api/reports/send/route');
    const res = await POST(makeReq({ reportIds: ['rpt-001'], businessId: 'biz-001' }));
    const json = await res.json();

    expect(json.results[0].status).toBe('failed');
    expect(mockSendText).not.toHaveBeenCalled();
  });

  it('6. bulk: A succeeds, B not found — independent', async () => {
    const sb = buildSeqService([
      { data: { ...REPORT, id: 'rpt-A' }, error: null },  // 0: A report SELECT
      { data: { id: 'rpt-A' }, error: null },              // 1: A token UPDATE
      { data: null, error: null },                          // 2: A status UPDATE
      { data: null, error: null },                          // 3: B report SELECT (not found)
    ]);
    mockAuthResult.ref = { user: { id: 'u1' }, businessId: 'biz-001', service: sb };

    const { POST } = await import('../../app/api/reports/send/route');
    const res = await POST(makeReq({ reportIds: ['rpt-A', 'rpt-B'], businessId: 'biz-001' }));
    const json = await res.json();

    expect(json.results).toHaveLength(2);
    expect(json.results[0].status).toBe('sent');
    expect(json.results[1].status).toBe('not_found');
    expect(mockSendText).toHaveBeenCalledTimes(1);
  });

  // ── Auth rejections ──
  it('7a. missing businessId → 400', async () => {
    mockAuthResult.ref = { user: { id: 'u1' }, businessId: 'biz-001', service: buildSeqService([]) };
    const { POST } = await import('../../app/api/reports/send/route');
    expect((await POST(makeReq({ reportIds: ['r'] }))).status).toBe(400);
  });

  it('7b. unauthenticated → 401', async () => {
    mockAuthResult.ref = NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const { POST } = await import('../../app/api/reports/send/route');
    expect((await POST(makeReq({ reportIds: ['r'], businessId: 'b' }))).status).toBe(401);
  });

  it('7c. wrong business → 403', async () => {
    mockAuthResult.ref = NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    const { POST } = await import('../../app/api/reports/send/route');
    expect((await POST(makeReq({ reportIds: ['r'], businessId: 'x' }))).status).toBe(403);
  });

  // ── Structural guards ──
  it('S1. no second auth mechanism', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../../app/api/reports/send/route.ts'), 'utf-8');
    expect(src).not.toContain('.auth.getUser');
    expect(src).not.toContain("'Authorization'");
  });

  it('S2. dashboard sends businessId', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../../app/dashboard/reports/page.tsx'), 'utf-8');
    expect(src.substring(src.indexOf('handleSend'), src.indexOf('handleDelete'))).toContain('businessId: business.id');
    expect(src.substring(src.indexOf('handleBulkSend'), src.indexOf('handleBulkSend') + 500)).toContain('businessId: business.id');
  });
});
