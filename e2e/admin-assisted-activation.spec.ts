import { expect, test } from '@playwright/test';

test('#551 invited customer owns credentials, consent, and canonical free activation', async ({ page }) => {
  const calls: string[] = [];
  await page.route('https://supabase.test/**', async route => {
    calls.push('password');
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'user-551', email: 'owner@example.test' }) });
  });
  await page.route('**/api/account/consent', async route => {
    calls.push('consent');
    expect(route.request().postDataJSON()).toMatchObject({ terms_accepted: true, ai_processing: true });
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true }) });
  });
  await page.route('**/api/onboarding/activate-admin-invite', async route => {
    calls.push('acceptance');
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, business_id: 'business-551', intended_plan: 'free', checkout_required: false, whatsapp_authorization_required: false }) });
  });
  await page.route('**/api/onboarding/verify', async route => {
    calls.push('verify');
    expect(route.request().postDataJSON()).toMatchObject({ business_id: 'business-551', plan: 'free' });
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'success', business_id: 'business-551', bot_code: 'EXACT' }) });
  });
  await page.route('**/dashboard', route => route.fulfill({ status: 200, contentType: 'text/html', body: '<h1>Exact customer dashboard</h1>' }));

  await page.goto('/activate');
  await page.getByLabel('New password').fill('Customer-Owned-551!');
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Activate account' }).click();
  await expect(page.getByRole('heading', { name: 'Exact customer dashboard' })).toBeVisible();
  expect(calls).toEqual(['password', 'consent', 'acceptance', 'verify']);
});
