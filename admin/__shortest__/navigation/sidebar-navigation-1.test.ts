import { shortest } from "@antiwork/shortest";

shortest.beforeAll(async ({ page }) => {
  await page.goto("/login");
  await page.fill('input[type="email"]', process.env.SHORTEST_ADMIN_EMAIL!);
  await page.fill('input[type="password"]', process.env.SHORTEST_ADMIN_PASSWORD!);
  await page.click('button[type="submit"]');
  await page.waitForURL("**/dashboard**", { timeout: 15000 });
});

shortest("Verify the admin sidebar contains navigation links for all major sections: Dashboard, Users, Businesses, Bookings, Orders, Payments, Subscriptions, Recurring, Tickets, Bot Management, Keywords, WhatsApp, Notifications, Broadcasts, Support, Payouts, Finance, Content, Events, Campaigns, Countries, Settings, Audit Log");
