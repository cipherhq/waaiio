'use client';

import { useState, useEffect, useCallback } from 'react';
import { useBusiness } from '@/components/dashboard/DashboardProvider';
import { createClient } from '@/lib/supabase/client';
import { PageHelp } from '@/components/dashboard/PageHelp';
import EmptyState from '@/components/dashboard/EmptyState';

interface Campaign {
  id: string;
  name: string;
  type: string;
  status: string;
  recipient_count: number;
  sent_count: number;
  delivered_count: number;
  converted_count: number;
  created_at: string;
}

type CampaignType = 'sms_invite' | 'whatsapp_template';
type TargetFilter = 'all' | 'has_consent' | 'custom';

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

const statusStyles: Record<string, string> = {
  draft: 'bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-300',
  scheduled: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300',
  sending: 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300',
  sent: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300',
  failed: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300',
};

const typeLabels: Record<string, string> = {
  sms_invite: 'SMS Invite',
  whatsapp_template: 'WhatsApp Template',
};

export default function GrowthCampaignsPage() {
  const business = useBusiness();
  const supabase = createClient();

  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [creditsAvailable, setCreditsAvailable] = useState(0);

  // Form state
  const [formName, setFormName] = useState('');
  const [formType, setFormType] = useState<CampaignType>('whatsapp_template');
  const [formTarget, setFormTarget] = useState<TargetFilter>('has_consent');
  const [formMessage, setFormMessage] = useState('');
  const [formSaving, setFormSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [recipientEstimate, setRecipientEstimate] = useState(0);

  const loadCampaigns = useCallback(async () => {
    setLoading(true);
    const [campaignRes, creditsRes] = await Promise.all([
      supabase
        .from('growth_campaigns')
        .select('id, name, type, status, recipient_count, sent_count, delivered_count, converted_count, created_at')
        .eq('business_id', business.id)
        .order('created_at', { ascending: false }),
      supabase
        .from('growth_credits')
        .select('balance')
        .eq('business_id', business.id)
        .limit(1)
        .maybeSingle(),
    ]);
    setCampaigns((campaignRes.data as Campaign[]) || []);
    setCreditsAvailable(creditsRes.data?.balance ?? 0);
    setLoading(false);
  }, [business.id, supabase]);

  useEffect(() => {
    loadCampaigns();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [business.id]);

  // Estimate recipients when target changes
  useEffect(() => {
    async function estimateRecipients() {
      let query = supabase
        .from('growth_contacts')
        .select('*', { count: 'exact', head: true })
        .eq('business_id', business.id)
        .eq('opted_out', false);

      if (formTarget === 'has_consent') {
        query = query.eq('has_consent', true);
      }

      const { count } = await query;
      setRecipientEstimate(count ?? 0);
    }
    if (showForm) {
      estimateRecipients();
    }
  }, [showForm, formTarget, business.id, supabase]);

  const creditCost = recipientEstimate; // 1 credit per recipient
  const hasEnoughCredits = creditsAvailable >= creditCost;

  async function handleCreateCampaign(e: React.FormEvent) {
    e.preventDefault();
    if (!formName.trim() || !formMessage.trim()) return;
    setFormSaving(true);
    setFormError(null);

    const { error } = await supabase.from('growth_campaigns').insert({
      business_id: business.id,
      name: formName.trim(),
      type: formType,
      status: 'draft',
      target_filter: formTarget,
      message_template: formMessage.trim(),
      recipient_count: recipientEstimate,
      sent_count: 0,
      delivered_count: 0,
      converted_count: 0,
    });

    setFormSaving(false);
    if (error) {
      setFormError('Failed to create campaign');
    } else {
      setFormName('');
      setFormType('whatsapp_template');
      setFormTarget('has_consent');
      setFormMessage('');
      setShowForm(false);
      loadCampaigns();
    }
  }

  async function handleSendCampaign(campaignId: string) {
    const { error } = await supabase
      .from('growth_campaigns')
      .update({ status: 'sending' })
      .eq('id', campaignId)
      .eq('business_id', business.id);

    if (!error) {
      loadCampaigns();
    }
  }

  return (
    <div className="mx-auto max-w-5xl px-4 py-6 sm:px-6">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Campaigns</h1>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          Create and manage outreach campaigns to grow your audience
        </p>
        <PageHelp
          pageKey="growth-campaigns"
          title="Growth Campaigns"
          description="Create campaigns to reach your contacts via WhatsApp templates or SMS invites. Each message costs 1 credit."
        />
      </div>

      {/* Credits bar */}
      <div className="mb-4 flex items-center justify-between rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-4 py-3">
        <div>
          <span className="text-sm text-gray-500 dark:text-gray-400">Credits Available: </span>
          <span className="text-sm font-semibold text-gray-900 dark:text-white">{creditsAvailable}</span>
        </div>
        <button
          type="button"
          onClick={() => setShowForm(!showForm)}
          className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 transition-colors"
        >
          {showForm ? 'Cancel' : 'Create Campaign'}
        </button>
      </div>

      {/* Create campaign form */}
      {showForm && (
        <form
          onSubmit={handleCreateCampaign}
          className="mb-6 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5"
        >
          <h2 className="mb-4 text-sm font-semibold text-gray-900 dark:text-white">New Campaign</h2>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400">
                Campaign Name <span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                required
                value={formName}
                onChange={(e) => setFormName(e.target.value)}
                placeholder="e.g. Summer Special"
                className="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 px-3 py-2 text-sm text-gray-900 dark:text-white placeholder:text-gray-400 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400">Type</label>
              <select
                value={formType}
                onChange={(e) => setFormType(e.target.value as CampaignType)}
                className="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 px-3 py-2 text-sm text-gray-900 dark:text-white focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
              >
                <option value="whatsapp_template">WhatsApp Template</option>
                <option value="sms_invite">SMS Invite</option>
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400">Target</label>
              <select
                value={formTarget}
                onChange={(e) => setFormTarget(e.target.value as TargetFilter)}
                className="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 px-3 py-2 text-sm text-gray-900 dark:text-white focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
              >
                <option value="all">All Contacts</option>
                <option value="has_consent">Has Consent Only</option>
                <option value="custom">Custom Filter</option>
              </select>
            </div>
            <div className="flex items-end gap-4">
              <div className="text-sm">
                <p className="text-gray-500 dark:text-gray-400">Est. recipients: <span className="font-semibold text-gray-900 dark:text-white">{recipientEstimate}</span></p>
                <p className="text-gray-500 dark:text-gray-400">Credit cost: <span className={`font-semibold ${hasEnoughCredits ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>{creditCost}</span></p>
              </div>
            </div>
          </div>
          <div className="mt-4">
            <label className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400">
              Message <span className="text-red-500">*</span>
            </label>
            <textarea
              required
              value={formMessage}
              onChange={(e) => setFormMessage(e.target.value)}
              rows={4}
              placeholder="Type your message here..."
              className="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 px-3 py-2 text-sm text-gray-900 dark:text-white placeholder:text-gray-400 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
            />
          </div>

          {formError && (
            <p className="mt-2 text-sm text-red-600 dark:text-red-400">{formError}</p>
          )}

          <div className="mt-4 flex justify-end gap-3">
            <button
              type="button"
              onClick={() => setShowForm(false)}
              className="rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={formSaving || !formName.trim() || !formMessage.trim()}
              className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50 transition-colors"
            >
              {formSaving ? 'Creating...' : 'Create Campaign'}
            </button>
          </div>
        </form>
      )}

      {/* Loading */}
      {loading && (
        <div className="flex items-center justify-center py-16">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-brand-600 border-t-transparent" />
        </div>
      )}

      {/* Empty state */}
      {!loading && campaigns.length === 0 && !showForm && (
        <EmptyState
          icon={'\uD83D\uDCE2'}
          title="No campaigns yet"
          description="Create your first campaign to reach your contacts"
          actionLabel="Create Campaign"
          onAction={() => setShowForm(true)}
        />
      )}

      {/* Campaigns list */}
      {!loading && campaigns.length > 0 && (
        <>
          {/* Desktop table */}
          <div className="hidden sm:block overflow-hidden rounded-xl border border-gray-200 dark:border-gray-700">
            <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
              <thead className="bg-gray-50 dark:bg-gray-800">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">Name</th>
                  <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">Type</th>
                  <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">Status</th>
                  <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">Recipients</th>
                  <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">Sent</th>
                  <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">Delivered</th>
                  <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">Converted</th>
                  <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">Created</th>
                  <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200 dark:divide-gray-700 bg-white dark:bg-gray-900">
                {campaigns.map((campaign) => (
                  <tr key={campaign.id} className="hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors">
                    <td className="whitespace-nowrap px-4 py-3 text-sm font-medium text-gray-900 dark:text-white">
                      {campaign.name}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-sm text-gray-500 dark:text-gray-400">
                      {typeLabels[campaign.type] || campaign.type}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-sm">
                      <span className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium ${statusStyles[campaign.status] || statusStyles.draft}`}>
                        {campaign.status}
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-sm text-gray-500 dark:text-gray-400">
                      {campaign.recipient_count}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-sm text-gray-500 dark:text-gray-400">
                      {campaign.sent_count}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-sm text-gray-500 dark:text-gray-400">
                      {campaign.delivered_count}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-sm text-gray-500 dark:text-gray-400">
                      {campaign.converted_count}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-sm text-gray-500 dark:text-gray-400">
                      {formatDate(campaign.created_at)}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-sm">
                      {campaign.status === 'draft' && (
                        <button
                          type="button"
                          disabled={!hasEnoughCredits}
                          onClick={() => handleSendCampaign(campaign.id)}
                          className="rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-700 disabled:opacity-50 transition-colors"
                          title={!hasEnoughCredits ? 'Insufficient credits' : 'Send campaign'}
                        >
                          Send
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Mobile cards */}
          <div className="space-y-3 sm:hidden">
            {campaigns.map((campaign) => (
              <div
                key={campaign.id}
                className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-4"
              >
                <div className="flex items-start justify-between">
                  <div>
                    <p className="text-sm font-medium text-gray-900 dark:text-white">{campaign.name}</p>
                    <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">{typeLabels[campaign.type] || campaign.type}</p>
                  </div>
                  <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${statusStyles[campaign.status] || statusStyles.draft}`}>
                    {campaign.status}
                  </span>
                </div>
                <div className="mt-3 grid grid-cols-4 gap-2 text-center">
                  <div>
                    <p className="text-sm font-semibold text-gray-900 dark:text-white">{campaign.recipient_count}</p>
                    <p className="text-[10px] text-gray-500 dark:text-gray-400">Recipients</p>
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-gray-900 dark:text-white">{campaign.sent_count}</p>
                    <p className="text-[10px] text-gray-500 dark:text-gray-400">Sent</p>
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-gray-900 dark:text-white">{campaign.delivered_count}</p>
                    <p className="text-[10px] text-gray-500 dark:text-gray-400">Delivered</p>
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-gray-900 dark:text-white">{campaign.converted_count}</p>
                    <p className="text-[10px] text-gray-500 dark:text-gray-400">Converted</p>
                  </div>
                </div>
                <div className="mt-3 flex items-center justify-between">
                  <span className="text-xs text-gray-400">{formatDate(campaign.created_at)}</span>
                  {campaign.status === 'draft' && (
                    <button
                      type="button"
                      disabled={!hasEnoughCredits}
                      onClick={() => handleSendCampaign(campaign.id)}
                      className="rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-700 disabled:opacity-50 transition-colors"
                    >
                      Send
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
