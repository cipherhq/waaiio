import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { middleware } from '@/middleware';

const auth = vi.hoisted(() => ({ getUser: vi.fn(), create: vi.fn() }));
vi.mock('@supabase/ssr', () => ({
  createServerClient: auth.create,
}));

const origins = [
  'https://admin.waaiio.com',
  'https://admin-staging.waaiio.com',
  'https://configured-admin.example.test',
  'http://localhost:8083',
];
let requestNumber = 0;
function request(method: string, origin?: string, path = '/api/admin/reseller-payouts/synthetic-payout') {
  const headers: Record<string, string> = {
    'x-request-id': 'cors-test-' + (++requestNumber),
    'x-forwarded-for': '192.0.2.' + requestNumber,
    'Access-Control-Request-Method': 'PATCH',
    'Access-Control-Request-Headers': 'Content-Type, Authorization',
  };
  if (origin !== undefined) headers.origin = origin;
  return new NextRequest('https://www.waaiio.com' + path, { method, headers });
}

describe('admin middleware CORS transport — actual middleware', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('ADMIN_ORIGIN', origins[2]);
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://www.waaiio.com');
    auth.getUser.mockResolvedValue({ data: { user: null }, error: null });
    auth.create.mockReturnValue({ auth: { getUser: auth.getUser } });
  });
  afterEach(() => vi.unstubAllEnvs());

  it.each(origins)('allows PATCH preflight for %s without authentication', async origin => {
    const response = await middleware(request('OPTIONS', origin));
    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe(origin);
    expect(response.headers.get('Access-Control-Allow-Methods')?.split(', ')).toEqual(['GET','POST','PUT','PATCH','DELETE','OPTIONS']);
    expect(response.headers.get('Access-Control-Allow-Headers')).toBe('Content-Type, Authorization');
    expect(response.headers.get('Access-Control-Max-Age')).toBe('86400');
    expect(auth.create).not.toHaveBeenCalled();
  });

  it.each(origins)('keeps actual PATCH response CORS for %s', async origin => {
    const response = await middleware(request('PATCH', origin));
    expect(response.status).toBe(200);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe(origin);
    expect(response.headers.get('Access-Control-Allow-Methods')).toBe('GET, POST, PUT, PATCH, DELETE, OPTIONS');
    expect(response.headers.get('Access-Control-Allow-Headers')).toBe('Content-Type, Authorization');
    expect(response.headers.get('Access-Control-Allow-Credentials')).toBe('true');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(auth.getUser).toHaveBeenCalledTimes(1);
  });

  it.each(['GET','POST','PUT','DELETE'])('preserves existing %s transport behavior', async method => {
    const response = await middleware(request(method, origins[0]));
    expect(response.status).toBe(200);
    expect(response.headers.get('Access-Control-Allow-Methods')?.split(', ')).toContain(method);
  });

  it.each(['https://unknown.example.test', 'https://admin.waaiio.com.example.test', 'null', undefined])(
    'does not allow unknown/missing preflight origin %s', async origin => {
      const response = await middleware(request('OPTIONS', origin));
      expect(response.status).toBe(403);
      expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
      expect(auth.create).not.toHaveBeenCalled();
    },
  );

  it.each(['/api/admin/reseller-payouts/synthetic-payout','/api/email/send'])(
    'denies unknown-origin mutation before reaching %s', async path => {
      const response = await middleware(request('POST', 'https://unknown.example.test', path));
      expect(response.status).toBe(403);
      expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
      expect(auth.create).not.toHaveBeenCalled();
    },
  );
});
