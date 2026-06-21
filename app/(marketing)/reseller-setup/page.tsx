import type { Metadata } from 'next';
import SetupWizard from './SetupWizard';

export const metadata: Metadata = {
  title: 'Partner Setup — Waaiio',
  description: 'Complete your Waaiio Partner Program setup and start managing client accounts.',
  robots: { index: false, follow: false },
};

export default async function ResellerSetupPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;

  return <SetupWizard token={token || ''} />;
}
