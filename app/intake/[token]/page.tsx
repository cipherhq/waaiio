import type { Metadata } from 'next';
import { IntakeFormView } from '@/components/intake/IntakeFormView';

// The link is a private, single-use secret: keep it out of search engines and
// out of the Referer header sent to other sites.
export const metadata: Metadata = {
  title: 'Client intake form',
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};

export default async function IntakePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <IntakeFormView token={token} />;
}
