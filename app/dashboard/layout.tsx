import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { DashboardProvider } from '@/components/dashboard/DashboardProvider';
import { Sidebar } from '@/components/dashboard/Sidebar';
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
      <div className="min-h-screen bg-gray-50">
        <Sidebar />
        <main className="lg:pl-64">
          <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6 lg:px-8">
            {children}
          </div>
        </main>
      </div>
    </DashboardProvider>
  );
}
