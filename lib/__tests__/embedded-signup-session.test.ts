import { beforeEach, describe, expect, it, vi } from 'vitest';
const { values, insert, from } = vi.hoisted(() => {
  const values = new Map<string, { payload: string; expires_at: string }>();
  const insert = vi.fn(async (row: { session_key: string; payload: string; expires_at: string }) => {
    values.set(row.session_key, row); return { error: null };
  });
  const from = vi.fn(() => ({ insert, delete: () => {
    let key = ''; let expiry = '';
    const query = {
      lt: async (_field: string, cutoff: string) => {
        for (const [id, row] of values) if (row.expires_at < cutoff) values.delete(id);
        return { error: null };
      },
      eq: (_field: string, value: string) => { key = value; return query; },
      gt: (_field: string, value: string) => { expiry = value; return query; },
      select: () => query,
      maybeSingle: async () => {
        const row = values.get(key);
        if (!row || row.expires_at <= expiry) return { data: null, error: null };
        values.delete(key); return { data: { payload: row.payload }, error: null };
      },
    };
    return query;
  } }));
  return { values, insert, from };
});
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: () => ({ from }) }));
import { createSignupSession, consumeSignupSession } from '@/lib/whatsapp/embedded-signup-session';
const data = { accessToken: 'secret-meta-token', tokenExpiresAt: null, accounts: [] };
beforeEach(() => {
  values.clear(); vi.clearAllMocks(); vi.useRealTimers();
  vi.stubEnv('TOKEN_ENCRYPTION_KEY', 'a'.repeat(64));
  vi.stubEnv('NEXT_PUBLIC_META_APP_ID', 'app-a');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://db.example');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-key');
});
describe('merchant-bound signup sessions', () => {
  it('stores encrypted credentials with a ten-minute TTL and consumes once', async () => {
    const id = await createSignupSession('user-a', 'biz-a', data);
    expect(insert.mock.calls[0][0].payload).not.toContain(data.accessToken);
    expect(Date.parse(insert.mock.calls[0][0].expires_at) - Date.now()).toBeGreaterThan(599000);
    expect(from).toHaveBeenCalledWith('whatsapp_signup_sessions');
    expect(await consumeSignupSession('user-a', 'biz-a', id)).toMatchObject(data);
    expect(await consumeSignupSession('user-a', 'biz-a', id)).toBeNull();
  });
  it('rejects another user, business, or app without consuming the owner session', async () => {
    const id = await createSignupSession('user-a', 'biz-a', data);
    expect(await consumeSignupSession('user-b', 'biz-a', id)).toBeNull();
    expect(await consumeSignupSession('user-a', 'biz-b', id)).toBeNull();
    vi.stubEnv('NEXT_PUBLIC_META_APP_ID', 'app-b');
    expect(await consumeSignupSession('user-a', 'biz-a', id)).toBeNull();
    vi.stubEnv('NEXT_PUBLIC_META_APP_ID', 'app-a');
    expect(await consumeSignupSession('user-a', 'biz-a', id)).toMatchObject(data);
  });
  it('allows only one concurrent consumer', async () => {
    const id = await createSignupSession('u', 'b', data);
    const result = await Promise.all([consumeSignupSession('u', 'b', id), consumeSignupSession('u', 'b', id)]);
    expect(result.filter(Boolean)).toHaveLength(1);
  });
  it('rejects expired sessions even if storage retains them', async () => {
    vi.useFakeTimers();
    const id = await createSignupSession('u', 'b', data);
    vi.advanceTimersByTime(600001);
    expect(await consumeSignupSession('u', 'b', id)).toBeNull();
  });
  it('fails closed with no encryption key, including development', async () => {
    vi.stubEnv('TOKEN_ENCRYPTION_KEY', '');
    await expect(createSignupSession('u', 'b', data)).rejects.toThrow('not configured');
    expect(insert).not.toHaveBeenCalled();
  });
});
