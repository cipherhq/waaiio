-- 415: Staging launch ACL repair — least-privilege grants for postgres-only tables
--
-- Root cause (#478): Staging Supabase project lacks ALTER DEFAULT PRIVILEGES
-- coverage. Tables created by early migrations (001-021) have RLS policies
-- but no table-level privileges for service_role or authenticated.
-- Production inherited these via legacy initialization defaults.
--
-- This migration grants ONLY the privileges required by actual code paths.
-- Each GRANT is justified by a specific API route or dashboard page.
--
-- Scope exclusions (already sufficient or owned by other migrations):
--   services, products, product_variants, orders, order_items, appointments,
--   business_capabilities — CTO-verified staging grants exist
--   businesses — M293 (authenticated S,I,U + service_role ALL)
--   whatsapp_channels — M293 (authenticated S + service_role S,I,U,D)
--   profiles — M247/M353 (authenticated S + service_role ALL)
--   subscriptions, subscription_payments — M410
--   events, event_ticket_types — M412
--   promo_codes — M413
--   signup_open — M414
--   messaging_allowances — M368 (authenticated S + service_role S,I,U)
--   platform_settings — M408 (service_role S)
--   refunds — M355 (authenticated S + service_role ALL)
--
-- Dependency closure approach:
--   Each route cited by this migration has been traced for ALL .from() calls.
--   Transitive dependencies already granted elsewhere are listed above.
--   Only dependencies confirmed postgres-only on live staging are included.
--
-- Rules enforced:
--   - No GRANT ALL
--   - No anon / PUBLIC grants
--   - No TRUNCATE / TRIGGER / REFERENCES
--   - No RLS / policy changes
--   - No ALTER DEFAULT PRIVILEGES
--   - Idempotent (GRANT is a no-op if privilege already exists)

-- ══════════════════════════════════════════════════════════════
-- service_role grants — API routes using createServiceClient()
-- ══════════════════════════════════════════════════════════════

-- payment_links: /api/pay-link/manage (POST/PATCH/DELETE)
GRANT SELECT, INSERT, UPDATE ON public.payment_links TO service_role;

-- attendance_log: /api/checkin/manual + /api/checkin (POST)
GRANT SELECT, INSERT ON public.attendance_log TO service_role;

-- business_staff: /api/staff (POST/PUT/DELETE)
GRANT SELECT, INSERT, UPDATE, DELETE ON public.business_staff TO service_role;

-- business_members: /api/team (POST/PATCH/DELETE)
GRANT SELECT, INSERT, UPDATE, DELETE ON public.business_members TO service_role;

-- contracts + contract_signers: /api/contracts/send, bulk-send, revoke, update
GRANT SELECT, INSERT, UPDATE ON public.contracts TO service_role;
GRANT SELECT, INSERT, UPDATE ON public.contract_signers TO service_role;

-- customer_profiles: /api/customers/import (upsert), /api/customers/delete (update)
GRANT SELECT, INSERT, UPDATE ON public.customer_profiles TO service_role;

-- canned_responses: /api/chat/canned-responses (POST/PUT/DELETE)
GRANT SELECT, INSERT, UPDATE, DELETE ON public.canned_responses TO service_role;

-- chat_conversations: /api/chat/send, resolve, reopen, assign
GRANT SELECT, INSERT, UPDATE ON public.chat_conversations TO service_role;

-- chat_messages: /api/chat/send (insert), /api/customers/delete (delete)
GRANT SELECT, INSERT, DELETE ON public.chat_messages TO service_role;

-- waitlist_entries: /api/waitlist/notify (update)
GRANT SELECT, UPDATE ON public.waitlist_entries TO service_role;

-- queue_entries: /api/queue/update, /api/queue/call-next (update)
GRANT SELECT, UPDATE ON public.queue_entries TO service_role;

-- loyalty_points: /api/loyalty/redeem (rpc), /api/referrals/validate (insert+update)
GRANT SELECT, INSERT, UPDATE ON public.loyalty_points TO service_role;

-- referrals: /api/referrals/validate (update)
GRANT SELECT, INSERT, UPDATE ON public.referrals TO service_role;

-- notifications: various API routes + cron (insert)
GRANT SELECT, INSERT ON public.notifications TO service_role;

-- alerts: lib/alerts/create-alert.ts via service client (insert)
GRANT SELECT, INSERT ON public.alerts TO service_role;

-- business_bank_accounts: /api/dashboard/bank-account (POST/PUT/DELETE)
GRANT SELECT, INSERT, UPDATE ON public.business_bank_accounts TO service_role;

-- signed_waivers: /api/waivers/sign (insert)
GRANT SELECT, INSERT ON public.signed_waivers TO service_role;

-- business_faq: /api/faq (POST/PUT/DELETE) via createServiceClient()
GRANT SELECT, INSERT, UPDATE, DELETE ON public.business_faq TO service_role;

-- business_locations: /api/locations (POST/PUT/DELETE) via createServiceClient()
GRANT SELECT, INSERT, UPDATE, DELETE ON public.business_locations TO service_role;

-- ── Transitive dependencies (route dependency closure) ──────

-- loyalty_transactions: /api/loyalty/redeem (INSERT), /api/referrals/validate (INSERT),
--   handlePostCompletion in queue/call-next (INSERT)
GRANT SELECT, INSERT ON public.loyalty_transactions TO service_role;

-- waiver_templates: /api/waivers/sign (SELECT template by token before insert)
GRANT SELECT ON public.waiver_templates TO service_role;

-- bookings: /api/customers/delete (UPDATE to anonymize PII),
--   handlePostCompletion (UPDATE feedback marker)
GRANT SELECT, UPDATE ON public.bookings TO service_role;

-- bot_sessions: /api/customers/delete (UPDATE to deactivate),
--   /api/chat/resolve via resolveConversation() (UPDATE to deactivate)
GRANT SELECT, UPDATE ON public.bot_sessions TO service_role;

-- audit_log: /api/customers/delete via logAudit() (INSERT)
GRANT SELECT, INSERT ON public.audit_log TO service_role;

-- ══════════════════════════════════════════════════════════════
-- authenticated grants — dashboard browser + SSR createClient()
-- ══════════════════════════════════════════════════════════════

-- invoices: /api/invoices (SSR createClient insert/update)
GRANT SELECT, INSERT, UPDATE ON public.invoices TO authenticated;

-- invoice_items: /api/invoices (SSR createClient insert/delete)
GRANT SELECT, INSERT, DELETE ON public.invoice_items TO authenticated;

-- campaigns: dashboard/campaigns/page.tsx (browser insert/update)
GRANT SELECT, INSERT, UPDATE ON public.campaigns TO authenticated;

-- delivery_zones: dashboard/settings/tabs/PaymentsTab.tsx (browser CRUD)
GRANT SELECT, INSERT, UPDATE, DELETE ON public.delivery_zones TO authenticated;

-- service_addons: dashboard/services/page.tsx (browser insert/update)
GRANT SELECT, INSERT, UPDATE ON public.service_addons TO authenticated;

-- service_packages: /api/packages (SSR createClient insert/update)
GRANT SELECT, INSERT, UPDATE ON public.service_packages TO authenticated;

-- reservations: dashboard/properties/[id]/page.tsx (browser update)
GRANT SELECT, UPDATE ON public.reservations TO authenticated;

-- surveys: /api/surveys (SSR createClient CRUD)
GRANT SELECT, INSERT, UPDATE, DELETE ON public.surveys TO authenticated;

-- polls: /api/polls (SSR createClient CRUD)
GRANT SELECT, INSERT, UPDATE, DELETE ON public.polls TO authenticated;
