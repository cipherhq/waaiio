import { createServiceClient } from '@/lib/supabase/service';
import { loadPublicCampaign } from '@/lib/campaigns/public-donation';
import { formatCurrencyCode } from '@/lib/constants';
import DonationForm from './DonationForm';

export const dynamic = 'force-dynamic';

export default async function DonationPage({ params }: { params: Promise<{ campaignId: string }> }) {
  const { campaignId } = await params;
  const campaign = await loadPublicCampaign(createServiceClient(), campaignId).catch(() => null);
  if (!campaign) return <main className="mx-auto max-w-lg px-6 py-16"><h1 className="text-xl font-semibold">This campaign is not accepting donations.</h1></main>;
  return (
    <main className="mx-auto max-w-lg px-6 py-12">
      <p className="mb-2 text-sm text-gray-600">{campaign.business.name}</p>
      <h1 className="text-3xl font-semibold tracking-tight">{campaign.title}</h1>
      {campaign.description && <p className="mt-4 whitespace-pre-wrap text-gray-700">{campaign.description}</p>}
      <dl className="my-8 grid grid-cols-2 gap-4 rounded-xl bg-gray-50 p-4">
        <div><dt className="text-sm text-gray-600">Raised</dt><dd className="text-lg font-semibold">{formatCurrencyCode(campaign.raised_amount, campaign.currency)}</dd></div>
        {campaign.goal_amount > 0 && <div><dt className="text-sm text-gray-600">Goal</dt><dd className="text-lg font-semibold">{formatCurrencyCode(campaign.goal_amount, campaign.currency)}</dd></div>}
      </dl>
      <DonationForm campaignId={campaign.id} currency={campaign.currency} minimum={campaign.min_donation || 1} maximum={Math.min(campaign.max_donation || 10_000_000, 10_000_000)} />
    </main>
  );
}
