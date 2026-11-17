'use client';

import { useBusiness, useCapabilities } from '@/components/dashboard/DashboardProvider';
import { FlowBuilder } from '@/components/custom-flows/FlowBuilder';
import { BUSINESS_FIELDS } from '@/lib/bot/custom-flow/data';

export default function CustomFlowsPage() {
  const business = useBusiness();
  const { capabilities } = useCapabilities();
  if (!capabilities.includes('custom_flow')) return <p>Enable Custom flows on an eligible plan to use the builder.</p>;
  return <FlowBuilder key={business.id} businessId={business.id} businessDetails={Object.fromEntries(BUSINESS_FIELDS.map(field=>[field,business[field]]))} country={business.country_code} />;
}
