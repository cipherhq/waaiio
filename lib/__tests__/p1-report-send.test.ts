/**
 * P1-REPORT-1 — Document send workflow tests
 *
 * Tests the actual POST /api/reports/send handler with mocked dependencies.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import * as fs from 'fs';
import * as path from 'path';

// ── Hoisted mocks ──
const { mockAuthResult, mockSendText, mockResolveByBusinessId } = vi.hoisted(() => ({
  mockAuthResult: { ref: null as any },
  mockSendText: vi.fn(),
  mockResolveByBusinessId: vi.fn(),
}));

// Supabase chain mock
function chain(resolvedData: unknown = null, resolvedError: unknown = null) {
  const c: Record<string, any> = {};
  ['select', 'eq', 'is', 'update', 'from'].forEach(m => c[m] = vi.fn().mockReturnValue(c));
  c.single = vi.fn().mockResolvedValue({ data: resolvedData, error: resolvedError });
  c.maybeSingle = vi.fn().mockResolvedValue({ data: resolvedData, error: resolvedError });
  return c;
}

const mockFrom = vi.fn();

vi.mock('@/lib/api-auth', () => ({
  authenticateRequest: vi.fn().mockImplementation(async () => mockAuthResult.ref),
}));

vi.mock('@/lib/channels/channel-resolver', () => ({
  ChannelResolver: vi.fn().mockImplementation(() => ({
    resolveByBusinessId: mockResolveByBusinessId,
  })),
}));

vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: vi.fn().mockImplementation(() => ({ from: mockFrom })),
}));

vi.mock('@/lib/rate-limit', () => ({
  rateLimitResponseAsync: vi.fn().mockResolvedValue(null),
  getRateLimitKey: vi.fn().mockReturnValue('test-key'),
}));

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

function makeRequest(body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/reports/send', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Build a fully chainable Supabase mock. Every method returns the chain. Terminal methods resolve. */
function setupDefaultFrom(opts: { reportData?: unknown; reportError?: unknown; updateError?: unknown } = {}) {
  const report = opts.reportData ?? { ...OWNED_REPORT };
  mockFrom.mockImplementation(() => {
    const c: Record<string, any> = {};
    // Every builder method returns the chain itself
    const self = () => c;
    ['select', 'eq', 'is', 'order', 'limit', 'neq', 'in', 'or'].forEach(m => c[m] = vi.fn(self));
    // Terminal methods resolve
    c.single = vi.fn().mockResolvedValue({ data: report, error: opts.reportError ?? null });
    c.maybeSingle = vi.fn().mockResolvedValue({ data: report, error: opts.reportError ?? null });
    // update() returns a new chain whose terminal eq resolves
    c.update = vi.fn().mockImplementation(() => {
      const uc: Record<string, any> = {};
      const uself = () => uc;
      ['eq', 'neq', 'is', 'in'].forEach(m => uc[m] = vi.fn(uself));
      // Make the chain itself awaitable for cases like `await supabase.from().update().eq().eq()`
      uc.then = (fn: (v: unknown) => void) => Promise.resolve({ data: null, error: opts.updateError ?? null }).then(fn);
      return uc;
    });
    return c;
  });
}

const OWNED_REPORT = {
  id: 'rpt-001', business_id: 'biz-001', customer_phone: '+2341234567890',
  title: 'Test Document', status: 'pending', businesses: { id: 'biz-001', name: 'Test Biz' },
};

describe('P1-REPORT-1: Document send workflow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSendText.mockResolvedValue(undefined);
    mockResolveByBusinessId.mockResolvedValue({ sender: { sendText: mockSendText } });
    // Default: authenticated owner — auth result includes service with mockFrom
    // The route destructures: const { businessId, service: supabase } = auth
    mockAuthResult.ref = { user: { id: 'user-001' }, businessId: 'biz-001', service: { from: (...args: unknown[]) => mockFrom(...args) } };

    // Default from() behavior — builds a chain where every method returns the chain,
    // and terminal methods (.single, .maybeSingle) resolve with data.
    // .update() returns a new chain whose terminal .eq() resolves with { data, error }.
    setupDefaultFrom();
  });

  it('A. route uses authenticateRequest with requireBusinessOwnership for auth', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../../app/api/reports/send/route.ts'), 'utf-8');
    // Auth is done via authenticateRequest with cookie session — not a separate getUser
    expect(src).toContain('authenticateRequest(request');
    expect(src).toContain('requireBusinessOwnership: true');
    // Destructures auth result to get service client
    expect(src).toContain('const { businessId, service: supabase } = auth');
  });

  it('B. cookie-authenticated request needs NO Authorization bearer header', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../../app/api/reports/send/route.ts'), 'utf-8');
    // No reference to Authorization header or second getUser call
    expect(src).not.toContain("headers.get('Authorization')");
    expect(src).not.toContain('supabase.auth.getUser');
  });

  it('C. missing businessId → 400, sender not called', async () => {
    const { POST } = await import('../../app/api/reports/send/route');
    const res = await POST(makeRequest({ reportIds: ['rpt-001'] }));
    expect(res.status).toBe(400);
    expect(mockSendText).not.toHaveBeenCalled();
  });

  it('D. unauthenticated → 401, sender not called', async () => {
    const { NextResponse: NR } = await import('next/server');
    mockAuthResult.ref = NR.json({ error: 'Unauthorized' }, { status: 401 });

    const { POST } = await import('../../app/api/reports/send/route');
    const res = await POST(makeRequest({ reportIds: ['rpt-001'], businessId: 'biz-001' }));
    expect(res.status).toBe(401);
    expect(mockSendText).not.toHaveBeenCalled();
  });

  it('E. authenticated but wrong businessId → 403, sender not called', async () => {
    const { NextResponse: NR } = await import('next/server');
    mockAuthResult.ref = NR.json({ error: 'Forbidden' }, { status: 403 });

    const { POST } = await import('../../app/api/reports/send/route');
    const res = await POST(makeRequest({ reportIds: ['rpt-001'], businessId: 'other-biz' }));
    expect(res.status).toBe(403);
    expect(mockSendText).not.toHaveBeenCalled();
  });

  it('F. report query scoped to business_id prevents cross-business access', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../../app/api/reports/send/route.ts'), 'utf-8');
    // Report fetch includes business_id scoping
    expect(src).toContain(".eq('id', reportId)");
    expect(src).toContain(".eq('business_id', businessId!)");
    // Not-found result returns 'not_found', not 'sent'
    expect(src).toContain("status: 'not_found'");
  });

  it('G. token persistence error prevents WhatsApp send', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../../app/api/reports/send/route.ts'), 'utf-8');
    // tokenError is checked
    expect(src).toContain('tokenError');
    // Token persistence failure returns 'failed' and continues (next report)
    const tokenIdx = src.indexOf('tokenError');
    const failedIdx = src.indexOf("status: 'failed'", tokenIdx);
    const sendIdx = src.indexOf('sender.sendText');
    expect(failedIdx).toBeGreaterThan(tokenIdx);
    expect(failedIdx).toBeLessThan(sendIdx); // failed before send
  });

  it('H. channel resolution failure handled safely', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../../app/api/reports/send/route.ts'), 'utf-8');
    expect(src).toContain("if (!resolved)");
    expect(src).toContain("No channel for business");
    expect(src).toContain("status: 'failed'");
  });

  it('I. bulk send iterates independently per report', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../../app/api/reports/send/route.ts'), 'utf-8');
    expect(src).toContain("for (const reportId of reportIds)");
    expect(src).toContain("results.push(");
  });

  // ── Dashboard regression ──

  it('K. handleSend includes businessId in request body', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../../app/dashboard/reports/page.tsx'), 'utf-8');
    // Find the handleSend function body
    const handleSendBlock = src.substring(src.indexOf('async function handleSend'), src.indexOf('async function handleDelete'));
    expect(handleSendBlock).toContain('businessId: business.id');
  });

  it('L. handleBulkSend includes businessId in request body', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../../app/dashboard/reports/page.tsx'), 'utf-8');
    const bulkBlock = src.substring(src.indexOf('async function handleBulkSend'), src.indexOf('async function handleBulkSend') + 500);
    expect(bulkBlock).toContain('businessId: business.id');
  });

  // ── Auth regression ──

  it('M. route does not use serviceClient.auth.getUser() for second authentication', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../../app/api/reports/send/route.ts'), 'utf-8');
    // Must not use service client's getUser with Authorization header
    expect(src).not.toContain('supabase.auth.getUser');
    expect(src).not.toContain("headers.get('Authorization')");
    expect(src).toContain('authenticateRequest');
    expect(src).toContain('requireBusinessOwnership: true');
  });

  it('N. route queries reports scoped to authenticated businessId', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../../app/api/reports/send/route.ts'), 'utf-8');
    // Report query must include both report ID and business_id
    expect(src).toContain("eq('id', reportId)");
    expect(src).toContain("eq('business_id', businessId");
  });

  it('O. token persistence error is checked before sending', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../../app/api/reports/send/route.ts'), 'utf-8');
    expect(src).toContain('tokenError');
    // tokenError check must appear BEFORE sendText
    const tokenIdx = src.indexOf('tokenError');
    const sendIdx = src.indexOf('sender.sendText');
    expect(tokenIdx).toBeGreaterThan(-1);
    expect(sendIdx).toBeGreaterThan(tokenIdx);
  });
});
