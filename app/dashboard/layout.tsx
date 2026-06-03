import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { createClient } from '@/lib/supabase/server';
import { DashboardProvider } from '@/components/dashboard/DashboardProvider';
import { Sidebar } from '@/components/dashboard/Sidebar';
import { ImpersonationBanner } from '@/components/dashboard/ImpersonationBanner';
import { AlertBanner } from '@/components/dashboard/AlertBanner';
import { FloatingHelp } from '@/components/dashboard/FloatingHelp';
import { IdleTimeout } from '@/components/dashboard/IdleTimeout';
import { CATEGORY_DEFAULT_CAPABILITIES } from '@/lib/capabilities/types';
import type { CapabilityId } from '@/lib/capabilities/types';

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

  // Check for impersonation cookies
  const cookieStore = await cookies();
  const impersonateBusinessId = cookieStore.get('impersonate_business_id')?.value;
  const impersonateAdminId = cookieStore.get('impersonate_admin_id')?.value;

  let isImpersonating = false;
  let impersonatedBusinessName = '';

  if (impersonateBusinessId && impersonateAdminId) {
    // Validate the admin is still valid (admin or support role)
    const { data: adminProfile } = await supabase
      .from('profiles')
      .select('role')
      .eq('id', impersonateAdminId)
      .maybeSingle();

    // Impersonation is admin-only — must match token issuance and validation endpoints
    if (adminProfile && adminProfile.role === 'admin') {
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
          <DashboardProvider business={businessWithCaps} userId={user.id}>
            <div data-dashboard className="min-h-screen bg-gray-50 dark:bg-gray-900">
              <a href="#main-content" className="skip-link">Skip to content</a>
              <ImpersonationBanner businessName={impersonatedBusinessName} />
              <AlertBanner />
              <Sidebar />
              <IdleTimeout />
              <main className="md:pl-64">
                <div id="main-content" className="mx-auto max-w-6xl px-4 py-6 sm:px-6 lg:px-8 dark:text-gray-100">
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
    console.error('Dashboard: no business found for user', user.id, bizError?.message);
    redirect('/get-started');
  }

  // Load capabilities from DB (ordered by sort_order for bot menu)
  const { data: capRows } = await supabase
    .from('business_capabilities')
    .select('capability')
    .eq('business_id', business.id)
    .eq('is_enabled', true)
    .order('sort_order', { ascending: true })
    .order('capability', { ascending: true });

  let capabilities: CapabilityId[];
  if (capRows && capRows.length > 0) {
    capabilities = capRows.map(r => r.capability as CapabilityId);
  } else {
    // Fallback: derive from category or flow_type
    capabilities = CATEGORY_DEFAULT_CAPABILITIES[business.category] ||
      [business.flow_type as CapabilityId] ||
      ['scheduling'];
  }

  // Load capability overrides
  const { data: overrideRows } = await supabase
    .from('capability_overrides')
    .select('capability')
    .eq('business_id', business.id);

  const capabilityOverrides: CapabilityId[] = (overrideRows || []).map(
    r => r.capability as CapabilityId,
  );

  const businessWithCaps = { ...business, capabilities, capabilityOverrides };

  // Build lightweight list for business switcher
  const allBusinessesList = (allUserBusinesses || []).map(b => ({
    id: b.id,
    name: b.name,
    category: b.category,
    logo_url: b.logo_url,
  }));

  return (
    <DashboardProvider business={businessWithCaps} userId={user.id} allBusinesses={allBusinessesList}>
      <div data-dashboard className="min-h-screen bg-gray-50 dark:bg-gray-900">
              <a href="#main-content" className="skip-link">Skip to content</a>
        <AlertBanner />
        <Sidebar />
        <IdleTimeout />
        <main className="md:pl-64">
          <div id="main-content" className="mx-auto max-w-6xl px-4 py-6 sm:px-6 lg:px-8 dark:text-gray-100">
            {children}
            <FloatingHelp />
          </div>
        </main>
      </div>
    </DashboardProvider>
  );
}
