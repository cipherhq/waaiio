/**
 * Actual OPTIONS/POST handlers and requirePlatformAdmin control flow.
 * Supabase auth/session responses, rate limiting and email provider are synthetic.
 * This does not certify live JWT cryptography, hosted RLS or email delivery.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { OPTIONS, POST } from '@/app/api/email/send/route';

const deps = vi.hoisted(() => ({
  send: vi.fn(), rate: vi.fn(), claims: vi.fn(), user: vi.fn(), session: vi.fn(),
  cookieSession: vi.fn(), service: vi.fn(), cookieClient: vi.fn(), insert: vi.fn(), rpc: vi.fn(),
}));
vi.mock('@/lib/email/client', () => ({ sendEmail: deps.send }));
vi.mock('@/lib/rate-limit', () => ({
  rateLimitResponseAsync: deps.rate,
  getRateLimitKey: (request: Request, prefix: string) => prefix + ':' + (request.headers.get('x-forwarded-for') || 'unknown'),
}));
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: deps.service }));
vi.mock('@/lib/supabase/server', () => ({ createClient: deps.cookieClient }));

const origins = [
  'https://admin.waaiio.com', 'https://admin-staging.waaiio.com',
  'https://configured-admin.example.test', 'http://localhost:8083',
];
const payload = { to: 'synthetic@example.test', subject: 'Synthetic admin message', html: '<p>Synthetic</p>' };
function request(options: { method?: string; origin?: string; authorization?: string | null; body?: unknown; raw?: string } = {}) {
  const method = options.method || 'POST';
  const headers: Record<string, string> = { origin: options.origin ?? origins[0], 'x-forwarded-for': '192.0.2.76' };
  const authorization = options.authorization === undefined ? 'Bearer synthetic-admin-token' : options.authorization;
  if (authorization !== null) headers.authorization = authorization;
  if (method !== 'OPTIONS') headers['Content-Type'] = 'application/json';
  return new NextRequest('https://www.waaiio.com/api/email/send', {
    method, headers,
    ...(method === 'OPTIONS' ? {} : { body: options.raw ?? JSON.stringify(options.body ?? payload) }),
  });
}
function expectCors(response: Response, origin = origins[0]) {
  expect(response.headers.get('Access-Control-Allow-Origin')).toBe(origin);
  expect(response.headers.get('Access-Control-Allow-Methods')).toBe('POST, OPTIONS');
  expect(response.headers.get('Access-Control-Allow-Headers')).toBe('Content-Type, Authorization');
  expect(response.headers.get('Access-Control-Max-Age')).toBe('86400');
}
function validClaims(aal: string | undefined = 'aal2', sessionId: string | undefined = 'synthetic-session') {
  return { data: { claims: { sub: 'synthetic-admin', aal, session_id: sessionId } }, error: null };
}
function validUser(role = 'admin', id = 'synthetic-admin') {
  return { data: { user: { id, email: 'admin@example.test', app_metadata: { role } } }, error: null };
}

describe('admin email CORS — actual route and auth boundary', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv('ADMIN_ORIGIN', origins[2]);
    deps.rate.mockResolvedValue(null);
    deps.send.mockResolvedValue({ success: true });
    deps.claims.mockResolvedValue(validClaims());
    deps.user.mockResolvedValue(validUser());
    deps.session.mockResolvedValue({ data: { session_exists: true }, error: null });
    deps.rpc.mockReturnValue({ maybeSingle: deps.session });
    deps.insert.mockResolvedValue({ error: null });
    deps.service.mockReturnValue({
      auth: { getClaims: deps.claims, getUser: deps.user },
      rpc: deps.rpc,
      from: (table: string) => {
        if (table !== 'admin_audit_logs') throw new Error('Unexpected table: ' + table);
        return { insert: deps.insert };
      },
    });
    deps.cookieSession.mockResolvedValue({ data: { session: null }, error: null });
    deps.cookieClient.mockResolvedValue({ auth: { getSession: deps.cookieSession } });
  });
  afterEach(() => vi.unstubAllEnvs());

  it.each(origins)('OPTIONS allows %s without auth, rate-limit or send calls', async origin => {
    const response = await OPTIONS(request({ method: 'OPTIONS', origin, authorization: null }));
    expect(response.status).toBe(204); expect(await response.text()).toBe('');
    expectCors(response, origin);
    expect(deps.service).not.toHaveBeenCalled();
    expect(deps.cookieClient).not.toHaveBeenCalled();
    expect(deps.rate).not.toHaveBeenCalled();
    expect(deps.send).not.toHaveBeenCalled();
  });
  it.each(['https://unknown.example.test', 'https://admin.waaiio.com.example.test', 'null'])(
    'OPTIONS never authorizes browser access for %s', async origin => {
      const response = await OPTIONS(request({ method: 'OPTIONS', origin }));
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe('');
      expect(deps.service).not.toHaveBeenCalled(); expect(deps.send).not.toHaveBeenCalled();
    },
  );
  it.each(origins)('successful Bearer-only POST from %s keeps auth, provider and audit', async origin => {
    const response = await POST(request({ origin }));
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ success: true });
    expectCors(response, origin);
    expect(deps.claims).toHaveBeenCalledWith('synthetic-admin-token');
    expect(deps.user).toHaveBeenCalledWith('synthetic-admin-token');
    expect(deps.rpc).toHaveBeenCalledWith('check_session_exists', { p_session_id: 'synthetic-session' });
    expect(deps.cookieClient).not.toHaveBeenCalled();
    expect(deps.rate).toHaveBeenCalledWith('email-send:192.0.2.76', 20, 60_000);
    expect(deps.send).toHaveBeenCalledTimes(1);
    expect(deps.send).toHaveBeenCalledWith(payload);
    expect(deps.insert).toHaveBeenCalledWith(expect.objectContaining({
      actor_id: 'synthetic-admin', action: 'send_email', entity_type: 'email',
      details: { to: payload.to, subject: payload.subject },
    }));
  });
  it('missing Bearer and missing cookie session denies without sending', async () => {
    const response = await POST(request({ authorization: null }));
    expect(response.status).toBe(401); expectCors(response);
    expect(deps.send).not.toHaveBeenCalled(); expect(deps.claims).not.toHaveBeenCalled();
  });
  it.each(['Basic synthetic', 'Bearer '])('malformed authorization %s cannot fall back to cookies', async authorization => {
    const response = await POST(request({ authorization }));
    expect(response.status).toBe(401); expectCors(response);
    expect(deps.cookieClient).not.toHaveBeenCalled(); expect(deps.send).not.toHaveBeenCalled();
  });
  it.each(['claims-error','user-error','identity-mismatch','revoked-session','session-error','missing-session','aal1','missing-aal','support-role','unknown-role'])(
    'actual admin boundary denies %s without send', async scenario => {
      if (scenario === 'claims-error') deps.claims.mockResolvedValue({ data: null, error: { message: 'synthetic invalid token' } });
      if (scenario === 'user-error') deps.user.mockResolvedValue({ data: { user: null }, error: { message: 'synthetic revoked token' } });
      if (scenario === 'identity-mismatch') deps.user.mockResolvedValue(validUser('admin', 'another-user'));
      if (scenario === 'revoked-session') deps.session.mockResolvedValue({ data: { session_exists: false }, error: null });
      if (scenario === 'session-error') deps.session.mockResolvedValue({ data: null, error: { message: 'synthetic session error' } });
      if (scenario === 'missing-session') deps.claims.mockResolvedValue({ data: { claims: { sub: 'synthetic-admin', aal: 'aal2' } }, error: null });
      if (scenario === 'aal1') deps.claims.mockResolvedValue(validClaims('aal1'));
      if (scenario === 'missing-aal') deps.claims.mockResolvedValue({ data: { claims: { sub: 'synthetic-admin', session_id: 'synthetic-session' } }, error: null });
      if (scenario === 'support-role') deps.user.mockResolvedValue(validUser('support'));
      if (scenario === 'unknown-role') deps.user.mockResolvedValue(validUser('merchant'));
      const response = await POST(request());
      expect(response.status).toBe(401); expectCors(response);
      expect(deps.send).not.toHaveBeenCalled(); expect(deps.cookieClient).not.toHaveBeenCalled();
    },
  );
  it.each(['to','subject','html'])('missing %s returns 400 with CORS and no send', async field => {
    const body: Record<string, string> = { ...payload }; delete body[field];
    const response = await POST(request({ body }));
    expect(response.status).toBe(400); expectCors(response); expect(deps.send).not.toHaveBeenCalled();
  });
  it('preserves rate-limit response body, status and every existing header', async () => {
    const limited = new Response(JSON.stringify({ error: 'synthetic rate limit' }), { status: 429, headers: {
      'Content-Type': 'application/json', 'Retry-After': '37', 'X-RateLimit-Remaining': '0',
      'X-RateLimit-Limit': '20', 'X-RateLimit-Reset': '12345', 'X-Synthetic-Header': 'preserved',
    } });
    deps.rate.mockResolvedValue(limited);
    const response = await POST(request());
    expect(response).toBe(limited); expect(response.status).toBe(429); expectCors(response);
    expect(await response.json()).toEqual({ error: 'synthetic rate limit' });
    for (const [name, value] of Object.entries({ 'Retry-After':'37', 'X-RateLimit-Remaining':'0',
      'X-RateLimit-Limit':'20', 'X-RateLimit-Reset':'12345', 'X-Synthetic-Header':'preserved' })) {
      expect(response.headers.get(name)).toBe(value);
    }
    expect(deps.service).not.toHaveBeenCalled(); expect(deps.send).not.toHaveBeenCalled();
  });
  it.each(['returned','thrown'])('provider %s failure returns 500 with CORS', async kind => {
    if (kind === 'returned') deps.send.mockResolvedValue({ success: false });
    else deps.send.mockRejectedValue(new Error('synthetic provider failure'));
    const response = await POST(request());
    expect(response.status).toBe(500); expectCors(response);
    expect(await response.json()).toEqual({ error: 'Failed to send email' });
    expect(deps.send).toHaveBeenCalledTimes(1);
    expect(deps.insert).not.toHaveBeenCalled();
  });
  it.each(['rate','auth','json'])('unexpected %s failure returns CORS without sending', async stage => {
    if (stage === 'rate') deps.rate.mockRejectedValue(new Error('synthetic rate failure'));
    if (stage === 'auth') deps.claims.mockRejectedValue(new Error('synthetic auth failure'));
    const response = await POST(request(stage === 'json' ? { raw: '{' } : {}));
    expect(response.status).toBe(500); expectCors(response); expect(deps.send).not.toHaveBeenCalled();
    expect(await response.json()).toEqual({ error: 'Failed to send email' });
  });
  it('does not expose unknown-origin POST response through CORS', async () => {
    // Actual middleware separately denies this browser mutation before the route.
    const response = await POST(request({ origin: 'https://unknown.example.test', authorization: null }));
    expect(response.status).toBe(401);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('');
    expect(deps.send).not.toHaveBeenCalled();
  });
  it('preserves best-effort audit failure without changing provider success', async () => {
    deps.insert.mockResolvedValue({ error: { message: 'synthetic audit failure' } });
    const response = await POST(request());
    expect(response.status).toBe(200); expectCors(response);
    expect(deps.send).toHaveBeenCalledTimes(1);
  });
});
