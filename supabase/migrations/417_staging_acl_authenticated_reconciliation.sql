-- 417: Staging ACL reconciliation — authenticated grants for dashboard surfaces
--
-- Root cause (#496): Tables created by early migrations have RLS policies
-- but no table-level GRANT for authenticated role. Staging Supabase lacks
-- ALTER DEFAULT PRIVILEGES coverage, so these tables are postgres-only.
--
-- This migration grants ONLY the privileges required by confirmed code paths.
-- Each GRANT is justified by a specific dashboard page or component that
-- reads/writes via createClient() (browser, authenticated role).
--
-- Scope: narrow reconciliation for 5 tables confirmed returning 403 on staging.
-- Does NOT grant TRUNCATE, TRIGGER, or REFERENCES.
-- Does NOT grant to anon or PUBLIC.
-- Does NOT change RLS policies.
-- Idempotent: GRANT is a no-op if privilege already exists.

-- ══════════════════════════════════════════════════════════════
-- authenticated grants — dashboard browser createClient() surfaces
-- ══════════════════════════════════════════════════════════════

-- parties: app/dashboard/parties/page.tsx (browser CRUD via createClient())
-- RLS: "Business owners manage parties" (M131), "Admin reads parties" (M219)
GRANT SELECT, INSERT, UPDATE, DELETE ON public.parties TO authenticated;

-- category_templates: lib/categoryConfig.ts (browser SELECT via createClient())
-- RLS: "anyone_can_read_active_templates" (M014), "admin_all_category_templates" (M014)
GRANT SELECT ON public.category_templates TO authenticated;

-- event_tickets: app/dashboard/events/page.tsx, app/dashboard/tickets/page.tsx,
--   app/dashboard/events/checkin/page.tsx (browser SELECT via createClient())
-- RLS: "business_owner_tickets" FOR ALL (M072), "public_verify_ticket" SELECT (M072)
GRANT SELECT ON public.event_tickets TO authenticated;

-- payment_links: app/dashboard/scan-to-pay/page.tsx (browser SELECT via createClient())
-- RLS: "owners_manage_payment_links" (M191)
-- Note: service_role S,I,U already granted by M415 for API routes.
GRANT SELECT ON public.payment_links TO authenticated;

-- promo_codes: app/dashboard/products/components/ProductForm.tsx (browser SELECT via createClient())
-- RLS: owner S,I,U,D policies (M021), service_select (M021/M090)
-- Note: service_role S,I,U,D already granted by M413 for API routes.
GRANT SELECT ON public.promo_codes TO authenticated;
