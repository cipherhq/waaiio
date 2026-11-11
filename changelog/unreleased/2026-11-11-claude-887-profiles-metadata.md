## 2026-11-11 — 30-day account deletion stops pretending, and rule tags are saved on the merchant's customer list (#887)

**Why:** code read and wrote `profiles.metadata`, a column that has never existed on staging or production. As a result:
- a 30-day account deletion said "scheduled" but saved nothing, while still cancelling the merchant's customer subscriptions and closing bot chats;
- the dashboard's "Cancel Deletion" button and banner could never work;
- the "Assign tag" rule never saved its tag.

Re-checked at `647d887b`. In both databases `profiles` has no `metadata` column and no deletion, status or tag column. `customer_profiles.tags` exists, unique by (business, phone).

**The Owner decided on 2026-11-10** ("Yes, all three", recorded on #887):
- (1B) refuse a 30-day deletion until it is really built;
- (3A) save rule tags on that business's own customer record, creating the record if it is missing;
- (2A) make admin Suspend a real sign-in ban. This is **not in this change** (see below).

**What changed**
- **`app/api/account/route.ts`:**
  - **30-day deletion:** `DELETE` with `{ gracePeriod: true }` now returns `409` with code `grace_period_unavailable` and the message "We couldn't schedule a 30-day deletion. Nothing has been changed. Please contact support@waaiio.com to delete your account." It returns before any subscription is cancelled, any bot chat is closed, any audit row is written or any email is sent. The never-working scheduling block is removed.
  - **Cancel deletion:** `PATCH` now answers `400 No deletion scheduled` for a signed-in user without reading the missing column.
  - **Immediate deletion:** unchanged. Its own problems remain recorded on #887 for a separate lane.
- **`app/dashboard/page.tsx`:** removed the scheduled-deletion check (a `profiles.metadata` read), the banner and the Cancel Deletion button. They could never show, because nothing can be scheduled.
- **Settings → Delete account:** no change. It already shows the server's error inside the modal, so an owner who picks the 30-day option now sees the message above and stays signed in.
- **`lib/bot/automation/rules-engine.ts`:** `assign_tag` now adds the tag to `customer_profiles.tags` for the rule's own business, matched by business and the "+" phone number, without duplicates.
  - If there is no record, it creates one (business, phone, tags). If the record was created at the same moment (unique-key `23505`), it tags that record instead.
  - A failed lookup, create or update throws (`assign_tag_lookup_failed`, `assign_tag_create_failed` or `assign_tag_update_failed`), so `evaluateRules` logs it per rule as before.
  - It no longer looks a person up across the whole platform `profiles` table. The unused `sanitizeFilterValue` import is removed.
- **Tests:**
  - new: `lib/__tests__/account-deletion-grace-887.test.ts` (route handlers) and `lib/__tests__/dashboard-no-deletion-banner-887.test.tsx` (rendered dashboard);
  - `lib/bot/automation/__tests__/rules-engine-actions.test.ts`: the old "persists the tag in profiles.metadata" test is replaced by 10 `customer_profiles` tests;
  - `lib/__tests__/data-deletion-page-402.test.ts`: two source assertions that expected the removed banner and the `deletion_scheduled` code now assert the new behaviour.

**Not changed / follow-ups**
- **Admin Suspend (2A)** comes in the next lane. The step-up table only accepts a fixed list of action names, enforced by the database (`admin_step_up_authorizations_action_type_check`), so the Owner chose (2026-11-11) one small migration that adds `user_suspension`, kept in step with the source-only M496 (#799).
- **The public `/data-deletion` page** still describes the 30-day option and the Cancel Deletion button. Changing that wording on a page Meta requires is a separate Owner copy decision.
- **The real 30-day deletion (1A)** gets its own migration-first lane. The Owner answered its three product questions on 2026-11-11: pause the bot during the wait; cancel subscriptions at request time; keep money records after deletion.

**What could break:** an owner who picks the 30-day option now gets an error instead of a false "scheduled" message. That is intended. A rule with "Assign tag" now creates a customer record for a phone the business has never seen. This matches what the bot does when someone chats. No migration, and no change to RLS, grants or payments.
