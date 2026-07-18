# External Blockers & Provider Readiness

## Payment Provider Sandbox — BLOCKED

### Status
Customer payments are ENABLED (payment links work, webhooks process).
Payout provider transfers are DISABLED (`ENABLE_PAYOUTS=false`).

### What is tested (Level B — provider stub)
- Payment initialization creates correct gateway session
- Webhook signature verification (all 5 gateways)
- Amount matching and mismatch rejection
- Payment status transitions (pending → success/failed)
- Platform fee recording
- Refund processing logic

### What is NOT tested (requires live sandbox)
- Real Paystack test-mode charge
- Real Stripe checkout session
- Real gateway webhook delivery
- Real transfer/payout execution
- Card authorization storage
- Subscription plan creation on gateway

### Activation Checklist (manual, before enabling live payments)
1. Obtain Paystack test secret key → set `PAYSTACK_SECRET_KEY`
2. Obtain Stripe test secret key → set `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`
3. Configure webhook URLs in each gateway dashboard
4. Execute one test charge per gateway (₦100/\$1)
5. Verify webhook fires and payment updates in DB
6. Verify receipt is sent (WhatsApp + email)
7. Test refund through gateway
8. Verify platform fee recorded correctly
9. Only then: set `ENABLE_PAYOUTS=true` for payout testing
10. Execute one test payout per gateway
11. Verify transfer webhook updates payout status

### Server-Side Payment Control
Customer payments are controlled by:
- Business must have `payment` capability enabled
- Business must have gateway credentials configured (`payout_accounts` or `settings.payment_credentials`)
- Payment initialization checks for valid gateway config before creating session
- If no gateway credentials: payment link shows "contact business" message

There is no global `ENABLE_PAYMENTS` kill switch. Customer payments are per-business gated by credential presence.

---

## Staging Migration — BLOCKED

### Status
Migrations have been validated on clean local Supabase (280 migrations applied successfully).
No staging or production migrations have been applied.

### Credentials Required
- Supabase staging project access token (`SUPABASE_ACCESS_TOKEN`)
- Staging project ref (currently: `tqjvrzopvtczxfxiwmnz`)
- Admin access to staging Supabase dashboard

### Backup Procedure
```bash
# Before migration
supabase db dump -p $STAGING_PASSWORD --host $STAGING_HOST > backup_$(date +%Y%m%d_%H%M%S).sql

# Or via Management API
curl -s "https://api.supabase.com/v1/projects/$STAGING_REF/database/backups" \
  -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN"
```

### Migration Command
```bash
# Apply all pending migrations
SQL=$(cat supabase/migrations/269_*.sql supabase/migrations/270_*.sql ... supabase/migrations/280_*.sql)
curl -s -X POST "https://api.supabase.com/v1/projects/$STAGING_REF/database/query" \
  -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d "$(jq -n --arg q "$SQL" '{query: $q}')"
```

Or per-file for safety:
```bash
for f in 269 270 271 272 273 274 275 276 277 278 279 280; do
  SQL=$(cat supabase/migrations/${f}_*.sql)
  echo "Applying migration $f..."
  curl -s -X POST "https://api.supabase.com/v1/projects/$STAGING_REF/database/query" \
    -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
    -H "Content-Type: application/json" \
    -d "$(jq -n --arg q "$SQL" '{query: $q}')"
  echo " done."
done
```

### Validation Queries (post-migration)
```sql
-- 1. Latest migration number
SELECT MAX(version::integer) FROM supabase_migrations.schema_migrations;
-- Expected: 280

-- 2. New tables exist
SELECT 1 FROM information_schema.tables WHERE table_name = 'invoice_payment_applications';

-- 3. New RPCs exist and have correct privileges
SELECT has_function_privilege('anon', oid, 'EXECUTE') FROM pg_proc WHERE proname = 'apply_invoice_payment';
-- Expected: false

-- 4. Triggers attached
SELECT tgname FROM pg_trigger WHERE tgname LIKE 'trg_protect_campaign%';
SELECT tgname FROM pg_trigger WHERE tgname LIKE 'trg_flag_payouts%';

-- 5. Destination columns exist
SELECT column_name FROM information_schema.columns WHERE table_name = 'business_payouts' AND column_name LIKE 'destination_%';
```

### Rollback/Recovery Steps
1. Restore from backup: `psql $STAGING_URL < backup_file.sql`
2. Or use Supabase point-in-time recovery (Pro plan)
3. New migrations are additive (CREATE OR REPLACE, ADD COLUMN IF NOT EXISTS) — no destructive DDL

### Responsible Person
- Production migration approval: Babajide Ace (project owner)
- Staging access: requires `SUPABASE_ACCESS_TOKEN` from project owner

---

## Admin E2E in CI — NOT STARTED

### Status
84 `__shortest__` test files exist but use the Shortest framework (not Playwright).
5 Playwright admin tests exist but skip when admin app is unavailable.

### What's needed
- Build and start admin app (`cd admin && npm run build && npm run preview`) in CI
- Or rewrite critical admin tests in Playwright targeting the admin URL

### Current coverage
Admin finance/payout operations are tested at Level B via handler integration tests.
Admin panel UI is not tested in CI.

### Inventory of 84 __shortest__ files
- 40 admin files: auth, businesses, communication, content, finance, healthcare, navigation, operations, users
- 44 dashboard files: auth, dashboard, website
- Status: NOT EXECUTED in CI, NOT COUNTED as coverage
