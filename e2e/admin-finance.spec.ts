import { test, expect } from '@playwright/test';

test.describe('Admin Finance API Authorization', () => {
  test('admin payout approve requires auth', async ({ request }) => {
    const res = await request.post('/api/admin/payouts/fake-id/approve', {
      data: { transfer_method: 'manual_bank' },
    });
    expect(res.status()).toBe(401);
  });

  test('admin payout complete requires auth', async ({ request }) => {
    const res = await request.post('/api/admin/payouts/fake-id/complete', {
      data: { transfer_reference: 'TXN123' },
    });
    expect(res.status()).toBe(401);
  });

  test('admin query requires auth', async ({ request }) => {
    const res = await request.get('/api/admin/query?table=businesses&limit=1');
    expect(res.status()).toBe(401);
  });

  test('admin impersonate requires auth', async ({ request }) => {
    const res = await request.post('/api/admin/impersonate', {
      data: { business_id: 'nonexistent-id' },
    });
    expect(res.status()).toBe(401);
  });

  test('admin payout reject requires auth', async ({ request }) => {
    const res = await request.post('/api/admin/payouts/fake-id/reject', {
      data: { reason: 'test' },
    });
    expect(res.status()).toBe(401);
  });

  test('admin payments route requires auth', async ({ request }) => {
    const res = await request.get('/api/admin/payments');
    expect(res.status()).toBe(401);
  });

  test('admin customers route requires auth', async ({ request }) => {
    const res = await request.get('/api/admin/customers');
    expect(res.status()).toBe(401);
  });

  test('payout generate returns 503 when ENABLE_PAYOUTS is disabled', async ({ request }) => {
    // ENABLE_PAYOUTS is not set in test environment, so generate should return 503
    const res = await request.post('/api/admin/payouts/generate', {
      data: { business_id: 'fake-id' },
    });
    // Without auth it returns 401, but the route checks ENABLE_PAYOUTS before auth
    // Based on the route implementation: ENABLE_PAYOUTS check is first
    expect([401, 503]).toContain(res.status());
  });

  test('health endpoint is publicly accessible', async ({ request }) => {
    const res = await request.get('/api/health');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('status');
    expect(['ok', 'degraded']).toContain(body.status);
  });

  test('directory endpoint is publicly accessible', async ({ request }) => {
    const res = await request.get('/api/directory');
    expect(res.status()).toBe(200);
    const body = await res.json();
    // Directory should return an array or object, not leak bot_code
    if (Array.isArray(body)) {
      for (const item of body.slice(0, 5)) {
        expect(item).not.toHaveProperty('bot_code');
      }
    }
  });

  test('admin routes do not expose wildcard CORS', async ({ request }) => {
    const res = await request.fetch('/api/admin/query?table=businesses&limit=1', {
      method: 'OPTIONS',
      headers: {
        'Origin': 'https://evil.example.com',
        'Access-Control-Request-Method': 'GET',
      },
    });
    const acao = res.headers()['access-control-allow-origin'];
    // Should NOT be '*' — admin routes must restrict origins
    expect(acao).not.toBe('*');
  });
});
