/**
 * #1109 reviewer follow-ups:
 * - admin CORS answers carry `Vary: Origin` (helper and middleware);
 * - the generate-sign-link edge function allows admin-staging and fails
 *   closed for unknown origins instead of answering with the first entry.
 */
import { describe, expect, it } from 'vitest';
import { resolve } from 'path';
import { readFileSync } from 'fs';
import { NextRequest } from 'next/server';
import { adminCorsHeaders } from '@/lib/admin-cors';

const shared = await import(resolve(__dirname, '../../supabase/functions/_shared/cors-origins.ts'));

describe('Vary: Origin on admin CORS', () => {
  it('adminCorsHeaders sets Vary for allowed and unknown origins', () => {
    expect(adminCorsHeaders('https://admin-staging.waaiio.com').Vary).toBe('Origin');
    expect(adminCorsHeaders('https://evil.example')).toMatchObject({ 'Access-Control-Allow-Origin': '', Vary: 'Origin' });
  });

  it('middleware preflight for /api/admin/* sets Vary', async () => {
    const { middleware } = await import('@/middleware');
    const res = await middleware(new NextRequest('https://www.waaiio.com/api/admin/audit', {
      method: 'OPTIONS', headers: { Origin: 'https://admin-staging.waaiio.com' },
    }));
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://admin-staging.waaiio.com');
    expect(res.headers.get('Vary')).toContain('Origin');
  });
});

describe('edge function allowed origins', () => {
  const allowed = shared.edgeAllowedOrigins('https://staging.waaiio.com');

  it('includes admin-staging and the configured app URL', () => {
    expect(allowed).toContain('https://admin-staging.waaiio.com');
    expect(allowed).toContain('https://admin.waaiio.com');
    expect(allowed[0]).toBe('https://staging.waaiio.com');
  });

  it('echoes an allowed origin and fails closed for others', () => {
    expect(shared.resolveEdgeOrigin('https://admin-staging.waaiio.com', allowed)).toBe('https://admin-staging.waaiio.com');
    expect(shared.resolveEdgeOrigin('https://evil.example', allowed)).toBe('');
    expect(shared.resolveEdgeOrigin(null, allowed)).toBe('');
  });

  it('generate-sign-link uses the shared list and sends Vary', () => {
    const src = readFileSync(resolve(__dirname, '../../supabase/functions/generate-sign-link/index.ts'), 'utf8');
    expect(src).toContain("from '../_shared/cors-origins.ts'");
    expect(src).not.toMatch(/allowedOrigins\[0\]/);
    expect(src.match(/'Vary': 'Origin'/g)).toHaveLength(2);
  });
});
