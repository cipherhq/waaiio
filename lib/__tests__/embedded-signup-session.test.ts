import { beforeEach, describe, expect, it, vi } from 'vitest';
const { values, set, getdel } = vi.hoisted(() => {
  const values = new Map<string, string>();
  return { values, set: vi.fn(async (key: string, value: string) => { values.set(key, value); return 'OK'; }),
    getdel: vi.fn(async (key: string) => { const value = values.get(key); values.delete(key); return value ?? null; }) };
});
vi.mock('@upstash/redis', () => ({ Redis: class { set = set; getdel = getdel; } }));
import { createSignupSession, consumeSignupSession } from '@/lib/whatsapp/embedded-signup-session';
const data = { accessToken: 'secret-meta-token', tokenExpiresAt: null, accounts: [] };
beforeEach(() => {
  values.clear(); vi.clearAllMocks(); vi.useRealTimers();
  vi.stubEnv('TOKEN_ENCRYPTION_KEY', 'a'.repeat(64));
  vi.stubEnv('NEXT_PUBLIC_META_APP_ID', 'app-a');
  vi.stubEnv('UPSTASH_REDIS_REST_URL', 'https://redis.example');
  vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', 'redis-token');
});
describe('merchant-bound signup sessions', () => {
  it('stores encrypted credentials with a ten-minute TTL and consumes once', async () => {
    const id = await createSignupSession('user-a', 'biz-a', data);
    expect(set.mock.calls[0][1]).not.toContain(data.accessToken);
    expect(set).toHaveBeenCalledWith(expect.any(String), expect.any(String), { ex: 600 });
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
    expect(set).not.toHaveBeenCalled();
  });
});
