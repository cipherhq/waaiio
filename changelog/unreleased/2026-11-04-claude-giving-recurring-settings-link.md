## 2026-11-04 — Giving: "Open recurring settings" opens the page that can fix the block; Settings opens the linked tab

- **What changed:**
  1. On the Giving add/edit form, the "Open recurring settings" link goes to the page that can clear the block named above it (Owner decision 2026-11-05):
     - Recurring switched off: `/dashboard/settings?tab=payments&section=recurring` (Payments > Recurring Payments, expanded).
     - Recurring paused by plan: `/dashboard/settings?tab=account` (Account > Plan & Upgrade, expanded).
     - Recurring not selected: `/dashboard/capabilities`.
     All three are relative paths. The message wording is unchanged.
  2. The Recurring Payments section on Settings > Payments now also shows for businesses with Giving. Before, it showed only for Payment or Crowdfunding, so a Giving-only business could not switch recurring on there (Owner decision 2026-11-05).
  3. The Settings page now reads `tab` and `section` with `useSearchParams()` instead of `window.location`. On an in-app link click, Next.js updates the address bar only after the new page first renders, so Settings read the old address and opened the Business tab. A full page load already worked.
- **Files:**
  - `app/dashboard/giving/page.tsx`: link destination per blocked state.
  - `app/dashboard/settings/tabs/PaymentsTab.tsx`: Recurring section condition adds `giving`.
  - `app/dashboard/settings/page.tsx`: query read.
  - `lib/__tests__/merchant-settings-785.test.tsx`: rendered tests for each blocked state (message and link), the Giving-only Recurring section, and Settings opening Payments > Recurring and Account > Plan & Upgrade from an in-app click.
  - `lib/__tests__/business-logo-753.test.tsx`: its `next/navigation` mock now provides `useSearchParams`.
- **Affects:** the Giving link, the Payments tab for Giving businesses, and every in-app link to `/dashboard/settings?tab=...`. For example, Billing's "Manage renewal" now opens the Account tab on click. No message wording, eligibility rules, bot or payment-routing changes. The Recurring toggle saves the same `recurring_enabled` field as before.
- **Could break:**
  - The link text stays "Open recurring settings" in all three states, including when it goes to Plan & Upgrade or Capabilities.
  - Settings picks its tab when the page first opens. Changing only the query while already on Settings does not switch tabs, which was also true before.
