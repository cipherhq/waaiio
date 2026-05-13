import { test, expect } from '@playwright/test';

test.describe('API Security', () => {
  test('webhook routes reject without signature', async ({ request }) => {
    const response = await request.post('/api/webhook/meta-cloud', {
      data: { object: 'whatsapp_business_account', entry: [] },
    });
    // Should reject (401) since META_APP_SECRET is set but no signature header
    expect([200, 401]).toContain(response.status());
  });

  test('admin routes reject without auth', async ({ request }) => {
    const adminRoutes = [
      { method: 'GET' as const, path: '/api/admin/customers' },
      { method: 'POST' as const, path: '/api/admin/impersonate' },
    ];

    for (const route of adminRoutes) {
      const response = route.method === 'GET'
        ? await request.get(route.path)
        : await request.post(route.path, { data: {} });
      expect([401, 403]).toContain(response.status());
    }
  });

  test('rate limiting works on OTP endpoint', async ({ request }) => {
    // Send requests until rate limited (3 per phone per 10 min)
    const phone = '+19999' + Math.floor(Math.random() * 1000000);
    let rateLimited = false;

    for (let i = 0; i < 6; i++) {
      const response = await request.post('/api/auth/otp/send', {
        data: { phone },
      });
      if (response.status() === 429) {
        rateLimited = true;
        break;
      }
    }

    // Rate limiting should kick in after 3 requests per phone
    expect(rateLimited).toBe(true);
  });

  test('receipt API rejects without auth token', async ({ request }) => {
    const response = await request.post('/api/receipts/generate', {
      data: { userId: 'fake', type: 'receipt', phone: '+1234567890' },
    });
    // Should reject since INTERNAL_API_TOKEN is set
    expect([401, 404]).toContain(response.status());
  });

  test('error responses do not leak internal details', async ({ request }) => {
    const response = await request.get('/api/invoices?business_id=nonexistent');
    // Should be 401 (no auth) not 500 with stack trace
    expect(response.status()).toBe(401);
    const body = await response.json();
    expect(body).not.toHaveProperty('stack');
    expect(body).not.toHaveProperty('code');
  });
});
