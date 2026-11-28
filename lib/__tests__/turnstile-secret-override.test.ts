/**
 * #1175 S5: verifyTurnstileToken can take a second widget's secret. Without
 * one, it uses TURNSTILE_SECRET_KEY exactly as before (public forms and
 * demo-request unchanged).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { verifyTurnstileToken, TURNSTILE_SITEVERIFY_URL } from '@/lib/security/turnstile';

function mockSiteverify() {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ success: true }), { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}
const sentSecret = (fetchMock: ReturnType<typeof mockSiteverify>) =>
  JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string).secret;

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('verifyTurnstileToken secret', () => {
  it('uses TURNSTILE_SECRET_KEY when no override is given', async () => {
    vi.stubEnv('TURNSTILE_SECRET_KEY', 'forms-secret');
    const fetchMock = mockSiteverify();
    expect(await verifyTurnstileToken('tok')).toEqual({ ok: true });
    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe(TURNSTILE_SITEVERIFY_URL);
    expect(sentSecret(fetchMock)).toBe('forms-secret');
  });

  it('uses the given secret instead of TURNSTILE_SECRET_KEY', async () => {
    vi.stubEnv('TURNSTILE_SECRET_KEY', 'forms-secret');
    const fetchMock = mockSiteverify();
    expect(await verifyTurnstileToken('tok', 'signin-secret')).toEqual({ ok: true });
    expect(sentSecret(fetchMock)).toBe('signin-secret');
  });

  it('an empty override in production refuses (fails closed) and never falls back to the forms secret', async () => {
    vi.stubEnv('TURNSTILE_SECRET_KEY', 'forms-secret');
    vi.stubEnv('NODE_ENV', 'production');
    const fetchMock = mockSiteverify();
    const res = await verifyTurnstileToken('tok', '');
    expect(res).toMatchObject({ ok: false, status: 503 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
