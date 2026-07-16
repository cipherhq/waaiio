# Security & Reliability Audit Report

**Repository:** cipherhq/waaiio
**Date:** 2026-07-15
**Auditor:** Claude Opus 4.6

---

## P0-1: Attendance RLS and Admin Analytics

### Finding ATT-01: Unrestricted INSERT policy on attendance_log
- **Severity:** CRITICAL
- **File:** `supabase/migrations/229_attendance_log.sql` line 28-29
- **Evidence:** `CREATE POLICY "service_insert" ON attendance_log FOR INSERT WITH CHECK (true)` — allows ANY role (anon, authenticated) to insert directly, not just service_role
- **Exploit:** Attacker bypasses `/api/checkin` rate limiting by inserting directly via Supabase anon client. Can spam fake attendance for any business (14k+/day)
- **Impact:** Data integrity, analytics corruption, storage abuse
- **Fix:** Remove the policy. Service role already bypasses RLS. Public inserts go through the rate-limited API only.
- **Status:** TO FIX

### Finding ATT-02: No column constraints on attendance_log
- **Severity:** HIGH
- **File:** `supabase/migrations/229_attendance_log.sql`
- **Evidence:** `customer_name TEXT NOT NULL` with no length limit. No CHECK constraints on source, phone, email, notes
- **Exploit:** Insert multi-MB strings into name/notes fields, bloat DB
- **Fix:** Add CHECK constraints: name <= 200, phone <= 30, email <= 320, notes <= 2000, source IN ('web','whatsapp','manual')
- **Status:** TO FIX

### Finding ATT-03: No admin RLS policy on attendance_log
- **Severity:** HIGH
- **File:** `supabase/migrations/229_attendance_log.sql`
- **Evidence:** Only `owners_read` policy exists. Admin panel uses `adminDb` which is the anon client with auth session (not service client). Admin queries will be denied by RLS.
- **Impact:** Admin Engagement page shows zero data (silent failure)
- **Fix:** Add SELECT policy using `is_admin_or_support()` function
- **Status:** TO FIX

### Finding ATT-04: Missing error handling in admin Engagement page
- **Severity:** MEDIUM
- **File:** `admin/src/pages/EngagementActivity.tsx`
- **Evidence:** Queries don't check for errors. RLS denial silently produces zero counts.
- **Fix:** Check `error` from every query, show error state instead of zero
- **Status:** TO FIX

### Finding ATT-05: Missing input validation in checkin API
- **Severity:** MEDIUM
- **File:** `app/api/checkin/route.ts` lines 19-75
- **Evidence:** No length validation on customer_name, customer_phone, customer_email, notes
- **Fix:** Add server-side length validation matching DB constraints
- **Status:** TO FIX

---

## P0-2: Meta Catalog Order Idempotency

### Finding ORD-01: Catalog orders bypass deduplication
- **Severity:** CRITICAL
- **File:** `app/api/webhook/meta-cloud/route.ts` line 437
- **Evidence:** `msg.type === 'order'` is handled with `continue` BEFORE the dedup check at line 559-571
- **Exploit:** Meta retransmits webhook → duplicate order created, inventory double-decremented
- **Fix:** Move dedup check before ALL message processing including orders
- **Status:** TO FIX

### Finding ORD-02: Non-transactional order creation
- **Severity:** CRITICAL
- **File:** `app/api/webhook/meta-cloud/route.ts` lines 131-175
- **Evidence:** Order insert, order_items insert, and decrement_stock are 3 separate operations
- **Exploit:** Partial failure → order exists but inventory not decremented, or inventory decremented but order_items missing
- **Fix:** Create atomic RPC (like existing `purchase_tickets_atomic`)
- **Status:** TO FIX

### Finding ORD-03: Silent inventory underflow
- **Severity:** HIGH
- **File:** `supabase/migrations/020_new_capabilities.sql` line 165-172
- **Evidence:** `GREATEST(0, stock - qty)` clamps to zero without error. No row lock.
- **Exploit:** Concurrent orders both see stock=1, both succeed, actual stock goes to -1 (clamped to 0)
- **Fix:** Add FOR UPDATE lock, raise exception if insufficient stock
- **Status:** TO FIX

### Finding ORD-04: Webhook price trusted over DB price
- **Severity:** MEDIUM
- **File:** `app/api/webhook/meta-cloud/route.ts` line 95
- **Evidence:** `item.item_price || product.price` — webhook price takes precedence
- **Fix:** Always use DB price as authoritative
- **Status:** TO FIX

---

## P0-3: Payment Webhook Reliability

### Finding PAY-01: Idempotency record inserted before processing completes
- **Severity:** CRITICAL
- **Files:** All 5 webhook handlers (Stripe, Paystack, Flutterwave, Square, PayPal)
- **Evidence:** `processed_webhook_events` upsert happens before financial writes. If processing throws, event is marked "processed" but payment is incomplete.
- **Exploit:** Paystack sends webhook → idempotency recorded → booking creation fails → Paystack retries → dedup rejects → payment permanently lost
- **Fix:** Implement state machine: received → processing → completed/failed
- **Status:** TO FIX

### Finding PAY-02: processSuccessfulPayment not fully idempotent
- **Severity:** HIGH
- **File:** `lib/payments/process-success.ts`
- **Evidence:** Booking confirmation has no status guard (line 35-43). Invoice payment adds amount_paid without idempotency (line 326-333). Double-call doubles invoice amounts.
- **Fix:** Add `.eq('status', 'pending')` guard on all financial updates
- **Status:** TO FIX

### Finding PAY-03: Flutterwave webhook returns 500 on processing error
- **Severity:** HIGH
- **File:** `app/api/webhooks/flutterwave/route.ts` line 159
- **Evidence:** Returns 500 after idempotency is recorded. Flutterwave retries indefinitely but dedup blocks reprocessing.
- **Fix:** Return 200 after recording, queue failed events for retry
- **Status:** TO FIX

---

## P0-4: Meta Token / Media Handling

### Finding TOK-01: Encrypted token used directly in API calls
- **Severity:** CRITICAL
- **File:** `app/api/webhook/meta-cloud/route.ts` lines 481, 483-485, 489-491
- **Evidence:** `resolved.channel.meta_access_token` (encrypted ciphertext) used as Bearer token for media download. Will fail with 401 for any dedicated channel with encrypted token.
- **Impact:** Voice message downloads broken for all dedicated numbers
- **Fix:** Use `resolved.cloud` (MetaCloudService with decrypted token) for all API calls
- **Status:** TO FIX

---

## Implementation Priority

1. **ATT-01 + ATT-02** — Remove unsafe INSERT policy, add constraints (migration)
2. **TOK-01** — Fix encrypted token in media download (immediate breakage)
3. **ORD-01** — Move dedup before order handling
4. **PAY-01** — State machine for webhook processing
5. **ATT-03 + ATT-04** — Admin RLS + error handling
6. **ORD-02 + ORD-03** — Atomic order RPC
7. **PAY-02 + PAY-03** — processSuccessfulPayment idempotency
8. **ATT-05** — Input validation
