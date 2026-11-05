## 2026-11-05 — Dashboard cards say what they count; "today" uses the business's time zone (#899)

Owner decision (2026-11-05, #899, option A; the usage bars keep the limit check's month). Labels and the "today" date only: every number still means what it meant.

What changed (`app/dashboard/page.tsx`):
- **Labels.** Shop-type categories (`entityName: 'order'`: shop, food delivery, Instagram vendor, mall vendor, pharmacy, catering, tailor, bakery, printing, supermarket, food truck) labelled the **bookings** cards as "orders", next to the real orders cards. Those cards now say "bookings": "Total bookings", "Pending bookings", "bookings this month" and "Recent bookings". Other categories keep their own word (for example "appointments").
- **"Today's …" → "… scheduled today"** for every category. The card has always counted bookings whose date is today, not things paid today.
- **Revenue.** When the business also takes orders, the all-payments card (`get_business_revenue`, which includes order payments) was labelled "<Entity> Revenue" or "Giving Revenue". It is now "Total revenue". "Order Revenue" and the plain "Revenue" card are unchanged.
- **Time zone.** "Today" was the UTC date, so a Lagos business saw yesterday until 01:00. It is now the business's own date from `businesses.timezone`, using the existing `getLocalNow` (`lib/bot/flows/shared/table-same-day.ts`). If the time zone is missing or invalid, it falls back to the UTC date as before.
- **Unchanged on purpose:**
  - the monthly usage bars still count from UTC midnight on the 1st, matching the enforced limit in `lib/tier-limits.ts`;
  - "Completion Rate" is untouched, pending a separate decision;
  - no query, total or permission changes.
- **Tests:** `lib/__tests__/dashboard-card-labels-899.test.tsx` renders the real page against a fake Supabase client. It checks the labels, and the date the page queries for Lagos, UTC, New York, missing and invalid time zones, and the month boundary.

Affects: the merchant dashboard overview page only.

Could break: anything that looks for the old card wording (none found in tests or e2e). Merchants used to "Today's orders" will see "Bookings scheduled today".
