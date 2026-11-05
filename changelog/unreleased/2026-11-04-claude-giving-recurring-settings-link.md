## 2026-11-04 — Settings opens the tab a link names; Recurring Payments for Giving businesses

- **What changed:**
  1. The Settings page now reads `tab` and `section` with `useSearchParams()` instead of `window.location`. On an in-app link click, Next.js updates the address bar only after the new page first renders, so Settings read the old address and opened the Business tab. A full page load already worked. As a result, the Giving form's "Open recurring settings" link now really opens the page it points to:
     - Recurring switched off: Payments > Recurring Payments, expanded.
     - Recurring paused by plan: Account > Plan & Upgrade, expanded.
     - Recurring not selected: the Capabilities page.
     These destinations are unchanged from #785, and the Giving page change only names that expression `recurringFixHref`. Owner decision 2026-11-05: keep a destination that can clear each block.
  2. The Recurring Payments section on Settings > Payments now also shows for businesses with Giving. Before, it showed only for Payment or Crowdfunding, so a Giving-only business could not switch recurring on there (Owner decision 2026-11-05).
  3. Saving that Recurring setting now refreshes the dashboard's business data. Before, the Giving checkbox stayed blocked, and the toggle showed off again, until a full page reload. This was also true for Payment and Crowdfunding businesses. Settings > Business already refreshes after its saves in the same way.
- **Files:**
  - `app/dashboard/settings/page.tsx`: query read.
  - `app/dashboard/settings/tabs/PaymentsTab.tsx`: the Recurring section condition adds `giving`, and the save refreshes the business data.
  - `app/dashboard/giving/page.tsx`: the existing link destinations moved into `recurringFixHref`, with no behaviour change.
  - `lib/__tests__/merchant-settings-785.test.tsx`: rendered tests for:
    - each blocked state (message and link);
    - the Giving-only Recurring section and its save refresh;
    - Settings opening Payments > Recurring and Account > Plan & Upgrade from an in-app click.
  - `lib/__tests__/business-logo-753.test.tsx`: its `next/navigation` mock now provides `useSearchParams`.
- **Affects:**
  - Every in-app link to `/dashboard/settings?tab=...`. For example, Billing's "Manage renewal" now opens the Account tab on click.
  - The Payments tab for Giving businesses.
  - The Recurring save.
  - Unchanged: message wording, eligibility rules, bot, payment routing. The Recurring toggle saves the same `recurring_enabled` field as before.
- **Could break:**
  - The link text stays "Open recurring settings" in all three states, including when it goes to Plan & Upgrade or Capabilities.
  - Settings picks its tab when the page first opens. Changing only the query while already on Settings does not switch tabs, which was also true before.
