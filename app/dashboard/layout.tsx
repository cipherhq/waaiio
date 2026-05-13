import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { createClient } from '@/lib/supabase/server';
import { DashboardProvider } from '@/components/dashboard/DashboardProvider';
import { Sidebar } from '@/components/dashboard/Sidebar';
import { ImpersonationBanner } from '@/components/dashboard/ImpersonationBanner';
import { AlertBanner } from '@/components/dashboard/AlertBanner';
import { FloatingHelp } from '@/components/dashboard/FloatingHelp';
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
          .eq('is_enabled', true);

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
            <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
              <a href="#main-content" className="skip-link">Skip to content</a>
              <ImpersonationBanner businessName={impersonatedBusinessName} />
              <AlertBanner />
              <Sidebar />
              <main className="lg:pl-64">
                <div id="main-content" className="mx-auto max-w-6xl px-4 py-6 sm:px-6 lg:px-8 dark:text-gray-100">
                  {children}
                </div>
              </main>
            </div>
          </DashboardProvider>
        );
      }
    }
  }

  // Normal (non-impersonation) flow
  const { data: business, error: bizError } = await supabase
    .from('businesses')
    .select('*')
    .eq('owner_id', user.id)
    .in('status', ['active', 'pending'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!business) {
    console.error('Dashboard: no business found for user', user.id, bizError?.message);
    redirect('/get-started');
  }

  // Load capabilities from DB
  const { data: capRows } = await supabase
    .from('business_capabilities')
    .select('capability')
    .eq('business_id', business.id)
    .eq('is_enabled', true);

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

  return (
    <DashboardProvider business={businessWithCaps} userId={user.id}>
      <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
              <a href="#main-content" className="skip-link">Skip to content</a>
        <AlertBanner />
        <Sidebar />
        <main className="lg:pl-64">
          <div id="main-content" className="mx-auto max-w-6xl px-4 py-6 sm:px-6 lg:px-8 dark:text-gray-100">
            {children}
            <FloatingHelp />
          </div>
        </main>
      </div>
    </DashboardProvider>
  );
}
