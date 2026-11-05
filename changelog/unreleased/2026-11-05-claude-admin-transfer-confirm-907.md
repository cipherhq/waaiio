## 2026-11-05 — Admin panel no longer confirms bank transfers (#907)

**What changed:** Removed the **Confirm Transfer** button and its handler from the admin Pending Transfers page (`admin/src/pages/PendingTransfers.tsx`). A pending transfer's detail now explains that only the business can confirm it from its own dashboard. Reject is unchanged. Owner decision C on #907.

**Why:** The admin confirm wrote `payments.amount = expected_amount`, which is minor units (100× too large). It also skipped `confirm_order_transfer_atomic` / `confirm_nonorder_transfer_atomic` and their checks: status lock, business match, amount, duplicate-payment fence, stock and promo. In production, RLS allows admins to update only `pending_transfers`. So the button just flipped the transfer to `confirmed`, wrote no payment, fee, booking, order or invoice change, and still showed success. The merchant could then no longer confirm. It also called `/api/admin/notify-transfer-confirmed`, which does not exist. No ×100 payment rows exist in production.

**Affects:** Admin Pending Transfers detail view only. The merchant confirm route (`app/api/dashboard/pending-transfers/[id]`) and the database functions are untouched. Both custody routes, fees, refunds and payouts are unchanged.

**What could break:** An admin can no longer confirm a transfer for a merchant; the merchant must do it. Three transfers confirmed from the admin panel on 2026-06-26 still have no payment record. Any correction is a separate, Owner-approved data task.

**Tests:** `admin/src/__tests__/pending-transfers-no-admin-confirm-907.test.tsx` (rendered).
