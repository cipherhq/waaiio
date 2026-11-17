'use client';

import { useBusiness } from '@/components/dashboard/DashboardProvider';
import { FlowAnswers } from '@/components/custom-flows/FlowAnswers';

// Answers are history: like other read_history views they stay readable,
// downloadable and deletable even if the Custom flows add-on is turned off.
// The Sidebar link is gated on custom_flow.
export default function FlowAnswersPage() {
  const business = useBusiness();
  return <FlowAnswers key={business.id} businessId={business.id} timezone={business.timezone} country={business.country_code} />;
}
