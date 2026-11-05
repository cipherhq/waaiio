## 2026-11-04 — Giving: "Open recurring settings" always opens Payments > Recurring

- **What changed:**
  1. On the Giving add/edit form, the "Open recurring settings" link now always goes to `/dashboard/settings?tab=payments&section=recurring` (Owner request). Before, it went there only when the business had the Recurring capability. When Recurring was paused by plan it went to `/dashboard/settings?tab=account`, and when Recurring was not selected it went to `/dashboard/capabilities` (set in #785).
  2. The Settings page now reads `tab` and `section` with `useSearchParams()` instead of `window.location`. On an in-app link click, Next.js updates the address bar only after the new page first renders, so Settings read the old address and opened the Business tab. A full page load already worked.
- **Files:**
  - `app/dashboard/giving/page.tsx`: one `href`.
  - `app/dashboard/settings/page.tsx`: query read.
  - `lib/__tests__/merchant-settings-785.test.tsx`: the rendered Giving test covers all three blocked states. A new rendered Settings test models an in-app click: the router has the new query while the address still shows Giving.
  - `lib/__tests__/business-logo-753.test.tsx`: its `next/navigation` mock now provides `useSearchParams`.
- **Affects:** the Giving link, and every in-app link to `/dashboard/settings?tab=...`. For example, Billing's "Manage renewal" now opens the Account tab on click. No wording, eligibility, saving or bot changes.
- **Could break:**
  - When Recurring is paused by plan or not selected, the message above the link still says to upgrade or to use the Capabilities page, but the link now opens Payments > Recurring.
  - The Recurring section on that tab only shows for businesses with Payment or Crowdfunding, so a Giving-only business lands on the Payments tab without it.
  - Settings picks its tab when the page first opens. Changing only the query while already on Settings does not switch tabs, which was also true before.
