## 2026-11-18 — Admin Giving page shows giving at every business (#1105)

- **What changed:** the admin Giving page (`admin/src/pages/Giving.tsx`) now reads through a new role-checked `GET /api/admin/giving` (`app/api/admin/giving/route.ts`, admin and finance, the page's own roles; service client, read only). It used to load only businesses in the `church`/`mosque`/`ngo`/`crowdfunding_org` categories and never read `campaign_donations`, so on staging it showed ₦0 and no records for TestBiz (category `shop`).
- **Which records:** bookings with `flow_type='payment'` for a service with `service_type='giving'` (the bot's own "my giving" rule), plus every `campaign_donations` row, at any business. Ordinary payments are not included.
- **Status and totals:** each record has one status: success (booking deposit paid or donation success), refunded (deposit refunded or linked payment refunded), failed, cancelled or pending. "Total Given (successful)", Givers and Organizations count successful records only. The Contributions count and the table still list every record, filtered by the status filter (now Success/Pending/Failed/Refunded/Cancelled).
- **Currency:** each record uses its own payment or donation currency, else the business's country currency from `countries`. Totals are shown per currency.
- **Type:** "Giving" (giving-service bookings) or "Crowdfunding" (campaign donations, purpose = campaign title), instead of a type guessed from the business category.
- **Errors:** a failed read shows an alert and disables CSV export instead of an empty page with zero totals.
- **Affects:** admin Giving page only. No writes, no RLS, grant or migration change.
- **What could break:** the route reads up to 5,000 rows of each kind (the page says so when it hits the cap). Givers are counted by phone first, then user id or email, so one person's bookings and donations count once.
- **Tests:** `lib/__tests__/admin-giving-route-1105.test.ts` (route), `admin/src/__tests__/giving-records-1105.test.tsx` (rendered page).
