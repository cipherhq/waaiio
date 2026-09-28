import { afterEach, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { POST } from '@/app/api/auth/staging-signup/route';
import { STAGING_APP_PROJECT_ID, STAGING_SUPABASE_URL } from '@/lib/staging-test-mode';

const originalProjectId = process.env.VERCEL_PROJECT_ID;
const originalSupabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;

afterEach(() => {
  if (originalProjectId === undefined) delete process.env.VERCEL_PROJECT_ID;
  else process.env.VERCEL_PROJECT_ID = originalProjectId;

  if (originalSupabaseUrl === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  else process.env.NEXT_PUBLIC_SUPABASE_URL = originalSupabaseUrl;
});

describe('#449 staging signup route', () => {
  it('is hidden outside the dedicated staging environment', async () => {
    process.env.VERCEL_PROJECT_ID = 'prj_not_staging';
    process.env.NEXT_PUBLIC_SUPABASE_URL = STAGING_SUPABASE_URL;

    const request = new NextRequest('http://localhost/api/auth/staging-signup', {
      method: 'POST',
      body: JSON.stringify({ email: 'tester@example.com', password: 'secret123' }),
      headers: { 'content-type': 'application/json' },
    });

    const response = await POST(request);
    expect(response.status).toBe(404);
  });

  it('enters the staging-only path only when both staging identities match', async () => {
    process.env.VERCEL_PROJECT_ID = STAGING_APP_PROJECT_ID;
    process.env.NEXT_PUBLIC_SUPABASE_URL = STAGING_SUPABASE_URL;

    const request = new NextRequest('http://localhost/api/auth/staging-signup', {
      method: 'POST',
      body: JSON.stringify({ email: 'tester@example.com', password: '123' }),
      headers: { 'content-type': 'application/json' },
    });

    const response = await POST(request);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      message: 'Password must be at least 6 characters.',
    });
  });
});
