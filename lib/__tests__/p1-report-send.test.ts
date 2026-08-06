/**
 * P1-REPORT-1 — Document send workflow tests
 *
 * Executable route-level tests for auth rejection paths (C, D, E).
 * Structural invariant tests for the success path, token verification,
 * cross-business scoping, and dashboard wiring.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import * as fs from 'fs';
import * as path from 'path';

const ROUTE_SRC = fs.readFileSync(path.resolve(__dirname, '../../app/api/reports/send/route.ts'), 'utf-8');
const DASHBOARD_SRC = fs.readFileSync(path.resolve(__dirname, '../../app/dashboard/reports/page.tsx'), 'utf-8');

// ── Mocks for executable auth-rejection tests ──
const mockAuthResult = { ref: null as any };

vi.mock('@/lib/api-auth', () => ({
  authenticateRequest: vi.fn().mockImplementation(async () => mockAuthResult.ref),
}));
vi.mock('@/lib/channels/channel-resolver', () => ({
  ChannelResolver: vi.fn().mockImplementation(() => ({ resolveByBusinessId: vi.fn() })),
}));
vi.mock('@/lib/rate-limit', () => ({
  rateLimitResponseAsync: vi.fn().mockResolvedValue(null),
  getRateLimitKey: vi.fn().mockReturnValue('test'),
}));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

function makeRequest(body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/reports/send', {
    method: 'POST', body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('P1-REPORT-1: Document send', () => {
  beforeEach(() => {
    mockAuthResult.ref = { user: { id: 'u1' }, businessId: 'biz-001', service: { from: vi.fn() } };
  });

  // ═══════════════════════════════════════════
  // EXECUTABLE ROUTE TESTS (auth rejection)
  // ═══════════════════════════════════════════

  it('C. missing businessId → 400 (executable)', async () => {
    const { POST } = await import('../../app/api/reports/send/route');
    const res = await POST(makeRequest({ reportIds: ['rpt-001'] }));
    expect(res.status).toBe(400);
  });

  it('D. unauthenticated → 401 (executable)', async () => {
    mockAuthResult.ref = NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const { POST } = await import('../../app/api/reports/send/route');
    const res = await POST(makeRequest({ reportIds: ['rpt-001'], businessId: 'biz-001' }));
    expect(res.status).toBe(401);
  });

  it('E. wrong business → 403 (executable)', async () => {
    mockAuthResult.ref = NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    const { POST } = await import('../../app/api/reports/send/route');
    const res = await POST(makeRequest({ reportIds: ['rpt-001'], businessId: 'other' }));
    expect(res.status).toBe(403);
  });

  it('missing reportIds → 400 (executable)', async () => {
    const { POST } = await import('../../app/api/reports/send/route');
    const res = await POST(makeRequest({ businessId: 'biz-001' }));
    expect(res.status).toBe(400);
  });

  // ═══════════════════════════════════════════
  // AUTHENTICATION MODEL
  // ═══════════════════════════════════════════

  it('A. single auth via authenticateRequest with requireBusinessOwnership', () => {
    expect(ROUTE_SRC).toContain('authenticateRequest(request');
    expect(ROUTE_SRC).toContain('requireBusinessOwnership: true');
    expect(ROUTE_SRC).toContain('const { businessId, service: supabase } = auth');
  });

  it('B. no second auth.getUser or Authorization header requirement', () => {
    expect(ROUTE_SRC).not.toContain('supabase.auth.getUser');
    expect(ROUTE_SRC).not.toContain("headers.get('Authorization')");
    expect(ROUTE_SRC).not.toContain('createServiceClient');
  });

  // ═══════════════════════════════════════════
  // CROSS-BUSINESS PROTECTION
  // ═══════════════════════════════════════════

  it('F. report query scoped to both reportId AND business_id', () => {
    const fetchBlock = ROUTE_SRC.substring(ROUTE_SRC.indexOf('Fetch report'), ROUTE_SRC.indexOf('Generate unique'));
    expect(fetchBlock).toContain(".eq('id', reportId)");
    expect(fetchBlock).toContain(".eq('business_id', businessId!)");
  });

  // ═══════════════════════════════════════════
  // TOKEN PERSISTENCE VERIFICATION
  // ═══════════════════════════════════════════

  it('G. token UPDATE verifies affected row before sending', () => {
    const tokenBlock = ROUTE_SRC.substring(ROUTE_SRC.indexOf('Persist token'), ROUTE_SRC.indexOf('Resolve channel'));
    // Must use .select('id').maybeSingle() to verify row was actually updated
    expect(tokenBlock).toContain(".select('id')");
    expect(tokenBlock).toContain('.maybeSingle()');
    // Must check both error AND null persisted
    expect(tokenBlock).toContain('tokenError');
    expect(tokenBlock).toContain('!persisted');
    // Failed persistence → status: 'failed', continue
    expect(tokenBlock).toContain("status: 'failed'");
  });

  it('G2. zero-row token update blocks WhatsApp send', () => {
    // The condition is: if (tokenError || !persisted)
    // When UPDATE affects zero rows: data=null, error=null → persisted=null → !persisted=true → failed
    expect(ROUTE_SRC).toContain('tokenError || !persisted');
    // Verify the failed path occurs BEFORE sendText
    const failIdx = ROUTE_SRC.indexOf('tokenError || !persisted');
    const sendIdx = ROUTE_SRC.indexOf('sender.sendText');
    expect(failIdx).toBeGreaterThan(-1);
    expect(sendIdx).toBeGreaterThan(failIdx);
  });

  // ═══════════════════════════════════════════
  // CHANNEL RESOLUTION
  // ═══════════════════════════════════════════

  it('H. channel resolution failure → failed, no send', () => {
    expect(ROUTE_SRC).toContain('if (!resolved)');
    expect(ROUTE_SRC).toContain("status: 'failed'");
  });

  // ═══════════════════════════════════════════
  // BULK SEND
  // ═══════════════════════════════════════════

  it('I. bulk send iterates independently per report', () => {
    expect(ROUTE_SRC).toContain('for (const reportId of reportIds)');
    expect(ROUTE_SRC).toContain("results.push(");
    // Individual try/catch per report
    const loopBlock = ROUTE_SRC.substring(ROUTE_SRC.indexOf('for (const reportId'), ROUTE_SRC.indexOf('return NextResponse.json({ results'));
    expect(loopBlock).toContain('try {');
    expect(loopBlock).toContain('catch (err)');
  });

  // ═══════════════════════════════════════════
  // DASHBOARD WIRING
  // ═══════════════════════════════════════════

  it('K. handleSend includes businessId: business.id', () => {
    const block = DASHBOARD_SRC.substring(DASHBOARD_SRC.indexOf('async function handleSend'), DASHBOARD_SRC.indexOf('async function handleDelete'));
    expect(block).toContain('businessId: business.id');
    expect(block).toContain("reportIds: [reportId]");
  });

  it('L. handleBulkSend includes businessId: business.id', () => {
    const block = DASHBOARD_SRC.substring(DASHBOARD_SRC.indexOf('async function handleBulkSend'), DASHBOARD_SRC.indexOf('async function handleBulkSend') + 500);
    expect(block).toContain('businessId: business.id');
    expect(block).toContain('Array.from(selectedIds)');
  });

  // ═══════════════════════════════════════════
  // REGRESSION GUARDS
  // ═══════════════════════════════════════════

  it('M. regression: no second auth mechanism reintroduced', () => {
    // Must not contain service client getUser or Authorization header extraction
    expect(ROUTE_SRC).not.toContain('.auth.getUser');
    expect(ROUTE_SRC).not.toContain("'Authorization'");
  });
});
