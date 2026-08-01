import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { createClient } from '@/lib/supabase/server';
import { DashboardProvider } from '@/components/dashboard/DashboardProvider';
import { Sidebar } from '@/components/dashboard/Sidebar';
import { ImpersonationBanner } from '@/components/dashboard/ImpersonationBanner';
import { AlertBanner } from '@/components/dashboard/AlertBanner';
import { FloatingHelp } from '@/components/dashboard/FloatingHelp';
import { Copilot } from '@/components/dashboard/Copilot';
import { NotificationBell } from '@/components/dashboard/NotificationBell';
import { IdleTimeout } from '@/components/dashboard/IdleTimeout';
import { CATEGORY_DEFAULT_CAPABILITIES } from '@/lib/capabilities/types';
import { getEffectiveCapabilities, type ConfiguredCapability } from '@/lib/capabilities/policy';
import type { CapabilityId } from '@/lib/capabilities/types';
import { logger } from '@/lib/logger';
import { safeLogErrorContext } from '@/lib/errors';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Dashboard',
};

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect('/login?redirect=/dashboard');

  // Check if user is a reseller
  const { data: resellerRow } = await supabase
    .from('resellers')
    .select('id')
    .eq('user_id', user.id)
    .maybeSingle();
  const isReseller = !!resellerRow;

  // Check for impersonation cookies
  const cookieStore = await cookies();
  const impersonateBusinessId = cookieStore.get('impersonate_business_id')?.value;
  const impersonateAdminId = cookieStore.get('impersonate_admin_id')?.value;

  let isImpersonating = false;
  let impersonatedBusinessName = '';

  if (impersonateBusinessId && impersonateAdminId) {
    // Validate the admin is still valid using authoritative app_metadata
    const { verifyAdminRole } = await import('@/lib/admin-auth');
    const isAdmin = await verifyAdminRole(impersonateAdminId, { requiredRole: 'admin' });

    // Impersonation is admin-only — must match token issuance and validation endpoints
    if (isAdmin) {
      // Verify impersonation token exists and is valid (used, not expired)
      const { data: tokenRecord } = await supabase
        .from('admin_impersonation_tokens')
        .select('id, expires_at')
        .eq('admin_id', impersonateAdminId)
        .eq('business_id', impersonateBusinessId)
        .not('used_at', 'is', null) // Must have been used (validated)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (!tokenRecord || new Date(tokenRecord.expires_at) < new Date()) {
        // Token expired or doesn't exist — clear cookies and proceed to normal flow
        const cs = await cookies();
        cs.delete('impersonate_business_id');
        cs.delete('impersonate_admin_id');
        // Fall through to normal business loading below
      } else {
      // Load the impersonated business
      const { data: impBiz } = await supabase
        .from('businesses')
        .select('*')
        .eq('id', impersonateBusinessId)
        .maybeSingle();

      if (impBiz) {
        isImpersonating = true;
        impersonatedBusinessName = impBiz.name;

        // Use the impersonated business instead of the user's own business
        const { data: capRows } = await supabase
          .from('business_capabilities')
          .select('capability')
          .eq('business_id', impBiz.id)
          .eq('is_enabled', true)
          .order('sort_order', { ascending: true })
          .order('capability', { ascending: true });

        let capabilities: CapabilityId[];
        if (capRows && capRows.length > 0) {
          capabilities = capRows.map(r => r.capability as CapabilityId);
        } else {
          capabilities = CATEGORY_DEFAULT_CAPABILITIES[impBiz.category] ||
            [impBiz.flow_type as CapabilityId] ||
            ['scheduling'];
        }

        const { data: overrideRows } = await supabase
          .from('capability_overrides')
          .select('capability')
          .eq('business_id', impBiz.id);

        const capabilityOverrides: CapabilityId[] = (overrideRows || []).map(
          r => r.capability as CapabilityId,
        );

        const businessWithCaps = { ...impBiz, capabilities, capabilityOverrides };

        return (
          <DashboardProvider business={businessWithCaps} userId={user.id} isReseller={isReseller}>
            <div data-dashboard className="flex h-screen overflow-hidden bg-gray-50 dark:bg-gray-900">
              <a href="#main-content" className="skip-link">Skip to content</a>
              <Sidebar />
              <IdleTimeout />
              <main className="flex-1 overflow-y-auto md:ml-64">
                <ImpersonationBanner businessName={impersonatedBusinessName} />
                <AlertBanner />
                <div className="fixed right-4 top-4 z-40 md:right-6 md:top-4">
                  <NotificationBell />
                </div>
                <div id="main-content" className="mx-auto max-w-7xl px-4 pt-16 pb-6 md:pt-6 md:pb-6 sm:px-6 lg:px-8 dark:text-gray-100">
                  {children}
                </div>
              </main>
            </div>
          </DashboardProvider>
        );
      }
      } // end else (valid token)
    }
  }

  // Normal (non-impersonation) flow
  // Fetch ALL user's businesses for the switcher
  const { data: allUserBusinesses, error: bizError } = await supabase
    .from('businesses')
    .select('*')
    .eq('owner_id', user.id)
    .in('status', ['active', 'pending'])
    .order('created_at', { ascending: false });

  // Check cookie for selected business
  const selectedBusinessId = cookieStore.get('waaiio_business_id')?.value;

  let business = null;
  if (selectedBusinessId && allUserBusinesses?.length) {
    // Use the cookie-selected business (already verified owner_id via query above)
    business = allUserBusinesses.find(b => b.id === selectedBusinessId) || null;
  }
  // Fallback to most recent business
  if (!business) {
    business = allUserBusinesses?.[0] || null;
  }

  if (!business) {
    logger.withContext({ op: 'dashboard.layout', userId: user.id, ...safeLogErrorContext(bizError) }).error('Dashboard: no business found for user');
    redirect('/get-started');
  }

  // Load all capability rows (enabled AND disabled) for policy resolution
  const { data: capRows, error: capError } = await supabase
    .from('business_capabilities')
    .select('capability, is_enabled, sort_order')
    .eq('business_id', business.id)
    .order('sort_order', { ascending: true })
    .order('capability', { ascending: true });

  // Load capability overrides
  const { data: overrideRows, error: overrideError } = await supabase
    .from('capability_overrides')
    .select('capability')
    .eq('business_id', business.id);

  const capabilityOverrides: CapabilityId[] = (overrideRows || []).map(
    r => r.capability as CapabilityId,
  );

  let capabilities: CapabilityId[] = [];  // effective — backward-compatible
  let selectedCapabilities: CapabilityId[] = [];  // is_enabled=true (effective + paused)
  let pausedCapabilities: Array<{ capability: CapabilityId; reason: string }> = [];
  let disabledCapabilities: CapabilityId[] = [];

  if (capError) {
    // DB read error — fail closed with empty capabilities rather than exposing defaults
    console.warn('[DASHBOARD] Capability read failed:', capError.message);
    capabilities = [];
  } else if (capRows && capRows.length > 0) {
    // Use the authoritative policy resolver
    const policyResult = getEffectiveCapabilities({
      configuredCapabilities: capRows as ConfiguredCapability[],
      overrides: overrideError ? [] : capabilityOverrides,
      tier: business.subscription_tier,
      trialEndsAt: business.trial_ends_at,
    });
    capabilities = policyResult.effective;
    selectedCapabilities = policyResult.selected;
    pausedCapabilities = policyResult.paused;
    disabledCapabilities = policyResult.disabled;
  } else {
    // Zero-row fallback for legacy businesses — route through policy for tier/trial filtering
    const legacyDefaults = CATEGORY_DEFAULT_CAPABILITIES[business.category] ||
      [business.flow_type as CapabilityId] ||
      ['scheduling'];
    const legacyRows = legacyDefaults.map((cap: CapabilityId) => ({
      capability: cap, is_enabled: true, sort_order: 0,
    }));
    const policyResult = getEffectiveCapabilities({
      configuredCapabilities: legacyRows,
      overrides: overrideError ? [] : capabilityOverrides,
      tier: business.subscription_tier,
      trialEndsAt: business.trial_ends_at,
    });
    capabilities = policyResult.effective;
    selectedCapabilities = policyResult.selected;
    pausedCapabilities = policyResult.paused;
    disabledCapabilities = policyResult.disabled;
  }

  const businessWithCaps = {
    ...business,
    capabilities,              // effective — Sidebar gating, bot dispatch (backward-compatible)
    selectedCapabilities,      // is_enabled=true — capability management page initialization
    pausedCapabilities,        // selected but tier-blocked — upgrade prompts
    disabledCapabilities,      // explicitly disabled — capability management
    capabilityOverrides,
  };

  // Build lightweight list for business switcher
  const allBusinessesList = (allUserBusinesses || []).map(b => ({
    id: b.id,
    name: b.name,
    category: b.category,
    logo_url: b.logo_url,
  }));

  return (
    <DashboardProvider business={businessWithCaps} userId={user.id} allBusinesses={allBusinessesList} isReseller={isReseller}>
      <div data-dashboard className="flex h-screen overflow-hidden bg-gray-50 dark:bg-gray-900">
              <a href="#main-content" className="skip-link">Skip to content</a>
        <Sidebar />
        <IdleTimeout />
        <main className="flex-1 overflow-y-auto md:ml-64">
          <AlertBanner />
          <div id="main-content" className="relative mx-auto max-w-7xl px-4 pt-16 pb-6 md:pt-6 md:pb-6 sm:px-6 lg:px-8 dark:text-gray-100">
            <div className="mb-2 flex h-8 items-center justify-end md:absolute md:right-6 md:top-4 md:mb-0">
              <NotificationBell />
            </div>
            {children}
            <FloatingHelp />
            <Copilot />
          </div>
        </main>
      </div>
    </DashboardProvider>
  );
}
