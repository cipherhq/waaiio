-- Fix 5 overly permissive RLS policies found in security audit
-- Only drops the USING(true) policies and adds scoped replacements where needed

-- ═══════════════════════════════════════════════════════════════════
-- 1. product_variants: drop USING(true) "service_select"
--    Owner policies already exist (select, insert, update, delete)
--    Bot flow uses service_role which bypasses RLS anyway
-- ═══════════════════════════════════════════════════════════════════
DROP POLICY IF EXISTS "product_variants_service_select" ON public.product_variants;

-- ═══════════════════════════════════════════════════════════════════
-- 2. event_tickets: drop USING(true) "public_verify_ticket"
--    Owner policy already exists (business_owner_tickets)
--    QR verification uses service_role via API route
-- ═══════════════════════════════════════════════════════════════════
DROP POLICY IF EXISTS "public_verify_ticket" ON public.event_tickets;

-- ═══════════════════════════════════════════════════════════════════
-- 3. event_invites: drop USING(true) "Guests view own invite"
--    Owner policy already exists (Business owners manage invites)
--    RSVP via invite token uses service_role via API route
-- ═══════════════════════════════════════════════════════════════════
DROP POLICY IF EXISTS "Guests view own invite" ON public.event_invites;

-- ═══════════════════════════════════════════════════════════════════
-- 4. service_addons: drop USING(true), add scoped read for active services
--    Owner policies already exist (insert, update, delete)
--    Bot needs to read add-ons for active services
-- ═══════════════════════════════════════════════════════════════════
DROP POLICY IF EXISTS "service_addons_select" ON public.service_addons;

-- Owner can read their own add-ons
CREATE POLICY "service_addons_owner_read" ON public.service_addons
  FOR SELECT USING (
    business_id IN (SELECT id FROM public.businesses WHERE owner_id = auth.uid())
  );

-- ═══════════════════════════════════════════════════════════════════
-- 5. site_pages: drop "any business owner can manage" policy
--    Admin policies already exist (admin_select, admin_insert, admin_update, admin_delete)
--    Public read for published pages already exists
-- ═══════════════════════════════════════════════════════════════════
DROP POLICY IF EXISTS "Authenticated users can manage pages" ON public.site_pages;
