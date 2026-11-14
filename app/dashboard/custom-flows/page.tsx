'use client';

import { useBusiness, useCapabilities } from '@/components/dashboard/DashboardProvider';
import { FlowBuilder } from '@/components/custom-flows/FlowBuilder';
import { getCountry } from '@/lib/countries';

export default function CustomFlowsPage() {
  const business = useBusiness();
  const { capabilities } = useCapabilities();
  if (!capabilities.includes('custom_flow')) return <p>Enable Custom flows on an eligible plan to use the builder.</p>;
  return <FlowBuilder key={business.id} businessId={business.id} timezone={business.timezone} currency={getCountry(business.country_code ?? 'NG')?.currency_code ?? 'NGN'} />;
}
