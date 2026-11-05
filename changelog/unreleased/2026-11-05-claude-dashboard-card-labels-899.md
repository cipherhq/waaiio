## 2026-11-05 — Dashboard cards say what they count; "today" uses the business's time zone (#899)

Owner decision (2026-11-05, #899, option A; the usage bars keep the limit check's month). Labels and the "today" date only: every number still means what it meant.

What changed (`app/dashboard/page.tsx`):
- **Labels.** Shop-type categories (`entityName: 'order'`: shop, food delivery, Instagram vendor, mall vendor, pharmacy, catering, tailor, bakery, printing, supermarket, food truck) labelled the **bookings** cards as "orders", next to the real orders cards. Those cards now say "bookings": "Total bookings", "Pending bookings", "bookings this month" and "Recent bookings". Other categories keep their own word (for example "appointments").
- **"Today's …" → "… scheduled today"** for every category. The card has always counted bookings whose date is today, not things paid today.
- **Revenue.** When the business also takes orders, the all-payments card (`get_business_revenue`, which includes order payments) was labelled "<Entity> Revenue" or "Giving Revenue". It is now "Total revenue". "Order Revenue" and the plain "Revenue" card are unchanged.
- **Time zone.** "Today" was the UTC date, so a Lagos business saw yesterday until 01:00.
  - It is now the business's own date, using the existing `getLocalNow` and `timezoneFitsCountry` (`lib/bot/flows/shared/table-same-day.ts`).
  - `businesses.timezone` is `NOT NULL DEFAULT 'Africa/Lagos'` and the app never sets it, so many US and GB businesses still carry the Lagos default. As in the bot (Owner decision 2026-11-04), the stored zone is trusted only when it fits the country:
    - NG → Africa/Lagos;
    - GH → Africa/Accra;
    - GB → Europe/London;
    - US and CA → America/*.
  - Otherwise the card keeps the UTC date, as before. In practice Nigerian businesses on Lagos get their own date; US and GB businesses on the Lagos default are unchanged.
- **Unchanged on purpose:**
  - the monthly usage bars still count from UTC midnight on the 1st, matching the enforced limit in `lib/tier-limits.ts`;
  - "Completion Rate" is untouched, pending a separate decision;
  - no query shape, total or permission changes; only the date sent by the "scheduled today" count can differ, and only for businesses whose zone fits their country.
- **Tests:** `lib/__tests__/dashboard-card-labels-899.test.tsx` renders the real page against a fake Supabase client. It checks the labels and the date the page queries for:
  - Lagos (NG);
  - New York (US);
  - London (GB);
  - US and GB on the Lagos default (UTC date);
  - NG on UTC;
  - missing and invalid zones;
  - the month boundary.

Affects: the merchant dashboard overview page only.

Could break: anything that looks for the old card wording (none found in tests or e2e). Merchants used to "Today's orders" will see "Bookings scheduled today".
