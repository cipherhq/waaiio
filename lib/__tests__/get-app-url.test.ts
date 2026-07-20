import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('getAppUrl', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  async function loadModule() {
    return await import('@/lib/get-app-url');
  }

  it('returns configured NEXT_PUBLIC_APP_URL when valid', async () => {
    process.env.NEXT_PUBLIC_APP_URL = 'https://www.waaiio.com';
    const { getAppUrl } = await loadModule();
    expect(getAppUrl()).toBe('https://www.waaiio.com');
  });

  it('strips trailing newline from configured URL', async () => {
    process.env.NEXT_PUBLIC_APP_URL = 'https://www.waaiio.com\n';
    const { getAppUrl } = await loadModule();
    expect(getAppUrl()).toBe('https://www.waaiio.com');
  });

  it('strips trailing CRLF from configured URL', async () => {
    process.env.NEXT_PUBLIC_APP_URL = 'https://www.waaiio.com\r\n';
    const { getAppUrl } = await loadModule();
    expect(getAppUrl()).toBe('https://www.waaiio.com');
  });

  it('rejects embedded newline after trim', async () => {
    process.env.NEXT_PUBLIC_APP_URL = 'https://evil.com\n/path';
    const { getAppUrl } = await loadModule();
    // Falls through to fallback
    expect(getAppUrl()).toBe('https://www.waaiio.com');
  });

  it('falls back to Vercel branch URL in preview', async () => {
    process.env.NEXT_PUBLIC_APP_URL = '';
    process.env.VERCEL_ENV = 'preview';
    process.env.VERCEL_BRANCH_URL = 'waaiio-git-fix-combined-18-19-20-bajides-projects.vercel.app';
    const { getAppUrl } = await loadModule();
    expect(getAppUrl()).toBe('https://waaiio-git-fix-combined-18-19-20-bajides-projects.vercel.app');
  });

  it('falls back to VERCEL_URL in preview when branch URL missing', async () => {
    process.env.NEXT_PUBLIC_APP_URL = '';
    process.env.VERCEL_ENV = 'preview';
    process.env.VERCEL_URL = 'waaiio-df56hdjcj-bajides-projects.vercel.app';
    const { getAppUrl } = await loadModule();
    expect(getAppUrl()).toBe('https://waaiio-df56hdjcj-bajides-projects.vercel.app');
  });

  it('does not use Vercel system vars outside preview', async () => {
    process.env.NEXT_PUBLIC_APP_URL = '';
    process.env.VERCEL_ENV = 'production';
    process.env.VERCEL_BRANCH_URL = 'waaiio-xyz.vercel.app';
    const { getAppUrl } = await loadModule();
    expect(getAppUrl()).toBe('https://www.waaiio.com');
  });

  it('returns production fallback when nothing configured', async () => {
    delete process.env.NEXT_PUBLIC_APP_URL;
    delete process.env.VERCEL_ENV;
    const { getAppUrl } = await loadModule();
    expect(getAppUrl()).toBe('https://www.waaiio.com');
  });

  it('rejects javascript: scheme', async () => {
    process.env.NEXT_PUBLIC_APP_URL = 'javascript:alert(1)';
    const { getAppUrl } = await loadModule();
    expect(getAppUrl()).toBe('https://www.waaiio.com');
  });

  it('rejects credentials in URL', async () => {
    process.env.NEXT_PUBLIC_APP_URL = 'https://user:pass@evil.com';
    const { getAppUrl } = await loadModule();
    expect(getAppUrl()).toBe('https://www.waaiio.com');
  });

  it('rejects whitespace-only value', async () => {
    process.env.NEXT_PUBLIC_APP_URL = '   \n  ';
    const { getAppUrl } = await loadModule();
    expect(getAppUrl()).toBe('https://www.waaiio.com');
  });

  it('rejects non-https URL in non-dev', async () => {
    process.env.NEXT_PUBLIC_APP_URL = 'http://waaiio.com';
    const { getAppUrl } = await loadModule();
    expect(getAppUrl()).toBe('https://www.waaiio.com');
  });
});

describe('getCsrfAllowedOrigins', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  async function loadModule() {
    return await import('@/lib/get-app-url');
  }

  it('includes the exact branch alias in Preview', async () => {
    process.env.NEXT_PUBLIC_APP_URL = 'https://www.waaiio.com';
    process.env.VERCEL_ENV = 'preview';
    process.env.VERCEL_BRANCH_URL = 'waaiio-git-fix-combined-18-19-20-bajides-projects.vercel.app';
    process.env.VERCEL_URL = 'waaiio-df56hdjcj-bajides-projects.vercel.app';
    const { getCsrfAllowedOrigins } = await loadModule();
    const origins = getCsrfAllowedOrigins();
    expect(origins).toContain('https://waaiio-git-fix-combined-18-19-20-bajides-projects.vercel.app');
  });

  it('includes the exact deployment-specific URL in Preview', async () => {
    process.env.NEXT_PUBLIC_APP_URL = 'https://www.waaiio.com';
    process.env.VERCEL_ENV = 'preview';
    process.env.VERCEL_BRANCH_URL = 'waaiio-git-fix-combined-18-19-20-bajides-projects.vercel.app';
    process.env.VERCEL_URL = 'waaiio-df56hdjcj-bajides-projects.vercel.app';
    const { getCsrfAllowedOrigins } = await loadModule();
    const origins = getCsrfAllowedOrigins();
    expect(origins).toContain('https://waaiio-df56hdjcj-bajides-projects.vercel.app');
  });

  it('rejects unrelated *.vercel.app origin', async () => {
    process.env.NEXT_PUBLIC_APP_URL = 'https://www.waaiio.com';
    process.env.VERCEL_ENV = 'preview';
    process.env.VERCEL_BRANCH_URL = 'waaiio-git-fix-combined-18-19-20-bajides-projects.vercel.app';
    const { getCsrfAllowedOrigins } = await loadModule();
    const origins = getCsrfAllowedOrigins();
    expect(origins).not.toContain('https://attacker-app.vercel.app');
    expect(origins).not.toContain('https://other-project.vercel.app');
  });

  it('does not include staging.waaiio.com unless explicitly configured', async () => {
    process.env.NEXT_PUBLIC_APP_URL = 'https://www.waaiio.com';
    process.env.VERCEL_ENV = 'preview';
    process.env.VERCEL_BRANCH_URL = 'waaiio-git-fix-combined-18-19-20-bajides-projects.vercel.app';
    const { getCsrfAllowedOrigins } = await loadModule();
    const origins = getCsrfAllowedOrigins();
    expect(origins).not.toContain('https://staging.waaiio.com');
  });

  it('rejects newline-injected configured URL', async () => {
    process.env.NEXT_PUBLIC_APP_URL = 'https://evil.com\nhttps://www.waaiio.com';
    const { getCsrfAllowedOrigins } = await loadModule();
    const origins = getCsrfAllowedOrigins();
    expect(origins).not.toContain('https://evil.com');
  });

  it('rejects credential-bearing URL', async () => {
    process.env.NEXT_PUBLIC_APP_URL = 'https://admin:secret@waaiio.com';
    const { getCsrfAllowedOrigins } = await loadModule();
    const origins = getCsrfAllowedOrigins();
    expect(origins).not.toContain('https://admin:secret@waaiio.com');
    expect(origins).not.toContain('https://waaiio.com');
  });

  it('rejects javascript: scheme', async () => {
    process.env.NEXT_PUBLIC_APP_URL = 'javascript:alert(1)';
    const { getCsrfAllowedOrigins } = await loadModule();
    const origins = getCsrfAllowedOrigins();
    expect(origins).not.toContain('javascript:alert(1)');
  });

  it('rejects non-HTTPS configured URL', async () => {
    process.env.NEXT_PUBLIC_APP_URL = 'http://waaiio.com';
    const { getCsrfAllowedOrigins } = await loadModule();
    const origins = getCsrfAllowedOrigins();
    expect(origins).not.toContain('http://waaiio.com');
  });

  it('preserves production origins and localhost', async () => {
    process.env.NEXT_PUBLIC_APP_URL = 'https://www.waaiio.com';
    delete process.env.VERCEL_ENV;
    const { getCsrfAllowedOrigins } = await loadModule();
    const origins = getCsrfAllowedOrigins();
    expect(origins).toContain('https://www.waaiio.com');
    expect(origins).toContain('https://waaiio.com');
    expect(origins).toContain('https://admin.waaiio.com');
    expect(origins).toContain('https://admin-staging.waaiio.com');
    expect(origins).toContain('http://localhost:3000');
    expect(origins).toContain('http://localhost:8083');
  });

  it('does not add Vercel system URLs outside preview', async () => {
    process.env.NEXT_PUBLIC_APP_URL = 'https://www.waaiio.com';
    process.env.VERCEL_ENV = 'production';
    process.env.VERCEL_URL = 'waaiio-prod-xyz.vercel.app';
    const { getCsrfAllowedOrigins } = await loadModule();
    const origins = getCsrfAllowedOrigins();
    expect(origins).not.toContain('https://waaiio-prod-xyz.vercel.app');
  });

  it('handles completely empty configuration gracefully', async () => {
    delete process.env.NEXT_PUBLIC_APP_URL;
    delete process.env.VERCEL_ENV;
    delete process.env.ADMIN_ORIGIN;
    const { getCsrfAllowedOrigins } = await loadModule();
    const origins = getCsrfAllowedOrigins();
    // Should still have hardcoded admin and localhost origins
    expect(origins).toContain('https://admin.waaiio.com');
    expect(origins).toContain('http://localhost:3000');
  });

  it('accepts POST /api/payouts/accept-terms for legitimate Preview origin', async () => {
    // Simulates the exact CSRF check the middleware performs
    process.env.NEXT_PUBLIC_APP_URL = 'https://www.waaiio.com';
    process.env.VERCEL_ENV = 'preview';
    process.env.VERCEL_BRANCH_URL = 'waaiio-git-fix-combined-18-19-20-bajides-projects.vercel.app';
    const { getCsrfAllowedOrigins } = await loadModule();
    const origins = getCsrfAllowedOrigins();
    const browserOrigin = 'https://waaiio-git-fix-combined-18-19-20-bajides-projects.vercel.app';
    // This is the exact check the middleware does
    expect(origins.includes(browserOrigin)).toBe(true);
  });
});
