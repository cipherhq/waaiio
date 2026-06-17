'use client';

import { useEffect, useState } from 'react';
import { useBusiness } from '@/components/dashboard/DashboardProvider';
import { createClient } from '@/lib/supabase/client';
import { useRouter } from 'next/navigation';

interface KeywordCampaign {
  id: string;
  name: string;
  keyword: string;
  description: string | null;
  response_type: 'text' | 'image' | 'link' | 'buttons';
  response_text: string;
  response_media_url: string | null;
  is_active: boolean;
  starts_at: string | null;
  ends_at: string | null;
  opt_in_message: string | null;
  response_count: number;
  created_at: string;
}

interface CampaignResponse {
  id: string;
  phone: string;
  customer_name: string | null;
  responded_at: string;
}

type ViewMode = 'list' | 'add' | 'edit' | 'responses';

// Reserved keywords that the bot already handles — warn users about these
const RESERVED_KEYWORDS = [
  'stop', 'quit', 'exit', 'end', 'annuler', 'arreter', 'dake', 'dawó', 'gyae',
  'start over', 'restart', 'reset', 'recommencer', 'tun bẹrẹ', 'start again',
  'hi', 'hello', 'menu', 'help', 'cancel', 'book', 'order', 'pay',
];

const RESPONSE_TYPES: { value: KeywordCampaign['response_type']; label: string; description: string }[] = [
  { value: 'text', label: 'Text', description: 'Plain text message' },
  { value: 'image', label: 'Image', description: 'Image with optional caption' },
  { value: 'link', label: 'Link', description: 'Text with a clickable link' },
  { value: 'buttons', label: 'Buttons', description: 'Text with interactive buttons' },
];

export default function KeywordCampaignsPage() {
  const business = useBusiness();
  const router = useRouter();
  const [campaigns, setCampaigns] = useState<KeywordCampaign[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [view, setView] = useState<ViewMode>('list');
  const [responses, setResponses] = useState<CampaignResponse[]>([]);
  const [responsesLoading, setResponsesLoading] = useState(false);

  // Form state
  const [form, setForm] = useState({
    id: '',
    name: '',
    keyword: '',
    description: '',
    response_type: 'text' as KeywordCampaign['response_type'],
    response_text: '',
    response_media_url: '',
    is_active: true,
    starts_at: '',
    ends_at: '',
    opt_in_message: '',
  });

  useEffect(() => {
    loadCampaigns();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [business.id]);

  async function loadCampaigns() {
    try {
      const res = await fetch(`/api/keyword-campaigns?business_id=${business.id}`);
      if (res.ok) {
        const data = await res.json();
        setCampaigns(data.campaigns || []);
      }
    } catch {
      // Non-critical
    }
    setLoading(false);
  }

  function openAdd() {
    setForm({
      id: '',
      name: '',
      keyword: '',
      description: '',
      response_type: 'text',
      response_text: '',
      response_media_url: '',
      is_active: true,
      starts_at: '',
      ends_at: '',
      opt_in_message: '',
    });
    setView('add');
  }

  function openEdit(campaign: KeywordCampaign) {
    setForm({
      id: campaign.id,
      name: campaign.name,
      keyword: campaign.keyword,
      description: campaign.description || '',
      response_type: campaign.response_type,
      response_text: campaign.response_text,
      response_media_url: campaign.response_media_url || '',
      is_active: campaign.is_active,
      starts_at: campaign.starts_at ? campaign.starts_at.slice(0, 10) : '',
      ends_at: campaign.ends_at ? campaign.ends_at.slice(0, 10) : '',
      opt_in_message: campaign.opt_in_message || '',
    });
    setView('edit');
  }

  async function openResponses(campaign: KeywordCampaign) {
    setForm({
      id: campaign.id,
      name: campaign.name,
      keyword: campaign.keyword,
      description: campaign.description || '',
      response_type: campaign.response_type,
      response_text: campaign.response_text,
      response_media_url: campaign.response_media_url || '',
      is_active: campaign.is_active,
      starts_at: campaign.starts_at ? campaign.starts_at.slice(0, 10) : '',
      ends_at: campaign.ends_at ? campaign.ends_at.slice(0, 10) : '',
      opt_in_message: campaign.opt_in_message || '',
    });
    setView('responses');
    loadResponses(campaign.id);
  }

  async function loadResponses(campaignId: string) {
    setResponsesLoading(true);
    try {
      const res = await fetch(`/api/keyword-campaigns/${campaignId}/responses?business_id=${business.id}`);
      if (res.ok) {
        const data = await res.json();
        setResponses(data.responses || []);
      }
    } catch {
      // Non-critical
    }
    setResponsesLoading(false);
  }

  const isReservedKeyword = RESERVED_KEYWORDS.includes(form.keyword.toLowerCase().trim());

  async function handleSave() {
    if (!form.name.trim() || !form.keyword.trim() || !form.response_text.trim()) return;
    setSaving(true);

    const payload = {
      business_id: business.id,
      name: form.name.trim(),
      keyword: form.keyword.trim().toUpperCase(),
      description: form.description.trim() || null,
      response_type: form.response_type,
      response_text: form.response_text.trim(),
      response_media_url: form.response_type === 'image' && form.response_media_url.trim() ? form.response_media_url.trim() : null,
      is_active: form.is_active,
      starts_at: form.starts_at || null,
      ends_at: form.ends_at || null,
      opt_in_message: form.opt_in_message.trim() || null,
    };

    try {
      if (view === 'add') {
        await fetch('/api/keyword-campaigns', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
      } else {
        await fetch(`/api/keyword-campaigns/${form.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
      }
    } catch {
      // Error handling
    }

    setSaving(false);
    setView('list');
    loadCampaigns();
  }

  async function handleDelete() {
    if (!form.id || !confirm('Delete this keyword campaign? Response history will be preserved.')) return;
    try {
      await fetch(`/api/keyword-campaigns/${form.id}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ business_id: business.id }),
      });
    } catch {
      // Error handling
    }
    setView('list');
    loadCampaigns();
  }

  function exportResponsesCsv() {
    if (responses.length === 0) return;
    const header = 'Phone,Customer Name,Responded At';
    const rows = responses.map(r =>
      `"${r.phone}","${(r.customer_name || 'Unknown').replace(/"/g, '""')}","${new Date(r.responded_at).toLocaleString()}"`
    );
    const csv = [header, ...rows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `keyword-campaign-${form.keyword}-responses.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  if (loading) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-brand border-t-transparent" />
      </div>
    );
  }

  // ═══════════════════════════════════════════
  // RESPONSES VIEW
  // ═══════════════════════════════════════════
  if (view === 'responses') {
    return (
      <div>
        <div className="flex items-center gap-3">
          <button
            onClick={() => setView('list')}
            className="rounded-lg p-2 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-700 dark:hover:text-gray-300"
          >
            <svg aria-hidden="true" className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
          </button>
          <div>
            <h1 className="text-xl font-bold text-gray-900 dark:text-gray-100">
              Responses: {form.name}
            </h1>
            <p className="text-sm text-gray-500 dark:text-gray-400">
              Keyword: <span className="inline-block rounded-full bg-brand/10 px-2 py-0.5 text-xs font-bold text-brand">{form.keyword.toUpperCase()}</span>
            </p>
          </div>
        </div>

        <div className="mt-4 flex items-center gap-3">
          <button
            onClick={exportResponsesCsv}
            disabled={responses.length === 0}
            className="rounded-lg border border-gray-200 dark:border-gray-600 px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50"
          >
            Export CSV
          </button>
          <button
            onClick={() => router.push(`/dashboard/broadcasts?campaign_id=${form.id}`)}
            disabled={responses.length === 0}
            className="rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white hover:bg-brand-600 disabled:opacity-50"
          >
            Send Broadcast to Respondents
          </button>
          <span className="text-sm text-gray-500 dark:text-gray-400">{responses.length} respondent{responses.length !== 1 ? 's' : ''}</span>
        </div>

        <div className="mt-4">
          {responsesLoading ? (
            <div className="flex justify-center py-8">
              <div className="h-6 w-6 animate-spin rounded-full border-2 border-brand border-t-transparent" />
            </div>
          ) : responses.length === 0 ? (
            <div className="rounded-xl border border-dashed border-gray-200 dark:border-gray-700 py-12 text-center">
              <svg aria-hidden="true" className="mx-auto h-10 w-10 text-gray-300 dark:text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
              <p className="mt-3 text-sm text-gray-500 dark:text-gray-400">No responses yet</p>
              <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">
                Responses will appear here when customers send the keyword "{form.keyword.toUpperCase()}"
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-700">
              <table className="w-full text-sm">
                <thead className="border-b border-gray-100 dark:border-gray-700 bg-gray-50 dark:bg-gray-800">
                  <tr>
                    <th scope="col" className="px-4 py-2.5 text-left text-xs font-medium text-gray-500 dark:text-gray-400">Phone</th>
                    <th scope="col" className="px-4 py-2.5 text-left text-xs font-medium text-gray-500 dark:text-gray-400">Customer Name</th>
                    <th scope="col" className="px-4 py-2.5 text-left text-xs font-medium text-gray-500 dark:text-gray-400">Responded At</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50 dark:divide-gray-700">
                  {responses.map(r => (
                    <tr key={r.id}>
                      <td className="px-4 py-2.5 font-medium text-gray-900 dark:text-gray-100 whitespace-nowrap">{r.phone}</td>
                      <td className="px-4 py-2.5 text-gray-700 dark:text-gray-300">{r.customer_name || 'Unknown'}</td>
                      <td className="px-4 py-2.5 text-gray-500 dark:text-gray-400 whitespace-nowrap">
                        {new Date(r.responded_at).toLocaleString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    );
  }

  // ═══════════════════════════════════════════
  // ADD / EDIT — Full-page two-column form
  // ═══════════════════════════════════════════
  if (view === 'add' || view === 'edit') {
    return (
      <div>
        {/* Header */}
        <div className="flex items-center gap-3">
          <button
            onClick={() => setView('list')}
            className="rounded-lg p-2 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-700 dark:hover:text-gray-300"
          >
            <svg aria-hidden="true" className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
          </button>
          <h1 className="text-xl font-bold text-gray-900 dark:text-gray-100">
            {view === 'add' ? 'New Keyword Campaign' : 'Edit Keyword Campaign'}
          </h1>
        </div>

        <div className="mt-5 grid gap-6 lg:grid-cols-[1fr_280px]">
          {/* Left column: Main fields */}
          <div className="space-y-4">
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">
                Campaign Name <span className="text-red-400">*</span>
              </label>
              <input
                type="text"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="e.g. Summer Promo 2026"
                className="w-full rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-3 text-sm text-gray-900 dark:text-gray-100 outline-none focus:border-brand"
                autoFocus
              />
            </div>

            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">
                Keyword <span className="text-red-400">*</span>
              </label>
              <input
                type="text"
                value={form.keyword}
                onChange={(e) => setForm({ ...form, keyword: e.target.value.toUpperCase() })}
                placeholder="e.g. SUMMER"
                className="w-full rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-3 text-sm font-mono font-bold text-gray-900 dark:text-gray-100 uppercase outline-none focus:border-brand"
              />
              <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">
                Customers text this word to your WhatsApp number to trigger the auto-response
              </p>
              {isReservedKeyword && (
                <div className="mt-2 flex items-start gap-2 rounded-lg bg-amber-50 dark:bg-amber-900/20 px-3 py-2">
                  <svg aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
                  </svg>
                  <p className="text-xs text-amber-700 dark:text-amber-400">
                    "{form.keyword}" is a reserved bot word. Using it may conflict with existing bot navigation.
                    Consider a different keyword.
                  </p>
                </div>
              )}
            </div>

            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">Description</label>
              <textarea
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
                rows={2}
                placeholder="Internal description for your reference..."
                className="w-full rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-3 text-sm text-gray-900 dark:text-gray-100 outline-none focus:border-brand"
              />
            </div>

            {/* Response Type */}
            <div>
              <label className="mb-2 block text-sm font-medium text-gray-700 dark:text-gray-300">
                Response Type <span className="text-red-400">*</span>
              </label>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {RESPONSE_TYPES.map(rt => (
                  <button
                    key={rt.value}
                    type="button"
                    onClick={() => setForm({ ...form, response_type: rt.value })}
                    className={`rounded-lg border px-3 py-2.5 text-left transition ${
                      form.response_type === rt.value
                        ? 'border-brand bg-brand/5 dark:bg-brand/10'
                        : 'border-gray-200 dark:border-gray-600 hover:border-gray-300 dark:hover:border-gray-500'
                    }`}
                  >
                    <p className={`text-sm font-medium ${form.response_type === rt.value ? 'text-brand' : 'text-gray-700 dark:text-gray-300'}`}>
                      {rt.label}
                    </p>
                    <p className="mt-0.5 text-xs text-gray-400 dark:text-gray-500">{rt.description}</p>
                  </button>
                ))}
              </div>
            </div>

            {/* Response Text */}
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">
                Response Message <span className="text-red-400">*</span>
              </label>
              <textarea
                value={form.response_text}
                onChange={(e) => setForm({ ...form, response_text: e.target.value })}
                rows={4}
                placeholder={
                  form.response_type === 'link'
                    ? 'e.g. Check out our summer deals: https://example.com/summer'
                    : form.response_type === 'buttons'
                    ? 'e.g. Thanks for your interest! Choose an option below:'
                    : 'The message customers will receive...'
                }
                className="w-full rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-3 text-sm text-gray-900 dark:text-gray-100 outline-none focus:border-brand"
              />
              {form.response_text.length > 0 && (
                <p className="mt-1 text-xs text-gray-400">
                  {form.response_text.length} / 1024 characters
                  {form.response_text.length > 1024 && (
                    <span className="ml-1 text-red-400">Exceeds WhatsApp body limit</span>
                  )}
                </p>
              )}
            </div>

            {/* Image URL (only for image type) */}
            {form.response_type === 'image' && (
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">
                  Image URL
                </label>
                <input
                  type="url"
                  value={form.response_media_url}
                  onChange={(e) => setForm({ ...form, response_media_url: e.target.value })}
                  placeholder="https://example.com/image.jpg"
                  className="w-full rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-3 text-sm text-gray-900 dark:text-gray-100 outline-none focus:border-brand"
                />
                <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">
                  Public URL to an image (JPEG, PNG). WhatsApp does not support WebP.
                </p>
              </div>
            )}

            {/* Opt-in message */}
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">
                Opt-in Confirmation
              </label>
              <input
                type="text"
                value={form.opt_in_message}
                onChange={(e) => setForm({ ...form, opt_in_message: e.target.value })}
                placeholder="e.g. You're now subscribed to our updates!"
                className="w-full rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-3 text-sm text-gray-900 dark:text-gray-100 outline-none focus:border-brand"
              />
              <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">
                Optional follow-up message after the auto-response (e.g. opt-in confirmation)
              </p>
            </div>

            {/* Date range */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">Start Date</label>
                <input
                  type="date"
                  value={form.starts_at}
                  onChange={(e) => setForm({ ...form, starts_at: e.target.value })}
                  className="w-full rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-3 text-sm text-gray-900 dark:text-gray-100 outline-none focus:border-brand"
                />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">End Date</label>
                <input
                  type="date"
                  value={form.ends_at}
                  onChange={(e) => setForm({ ...form, ends_at: e.target.value })}
                  className="w-full rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-3 text-sm text-gray-900 dark:text-gray-100 outline-none focus:border-brand"
                />
              </div>
            </div>

            {/* WhatsApp Preview */}
            <div>
              <p className="mb-2 text-sm font-semibold text-gray-700 dark:text-gray-300">WhatsApp Preview</p>
              <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 p-4">
                <div className="max-w-[320px]">
                  {/* Incoming keyword */}
                  <div className="mb-2 flex justify-end">
                    <div className="rounded-lg bg-green-100 dark:bg-green-900/30 px-3 py-2 text-sm text-green-800 dark:text-green-300">
                      {form.keyword || 'KEYWORD'}
                    </div>
                  </div>
                  {/* Bot response */}
                  <div className="flex justify-start">
                    <div className="space-y-2 rounded-lg bg-white dark:bg-gray-700 px-3 py-2 shadow-sm max-w-[280px]">
                      {form.response_type === 'image' && form.response_media_url && (
                        <div className="h-32 w-full rounded bg-gray-100 dark:bg-gray-600 flex items-center justify-center">
                          <svg aria-hidden="true" className="h-8 w-8 text-gray-300 dark:text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                          </svg>
                        </div>
                      )}
                      <p className="text-sm text-gray-800 dark:text-gray-200 whitespace-pre-wrap">
                        {form.response_text || 'Your response message will appear here...'}
                      </p>
                      {form.response_type === 'buttons' && (
                        <div className="space-y-1 border-t border-gray-100 dark:border-gray-600 pt-2">
                          <div className="rounded bg-gray-50 dark:bg-gray-600 px-2 py-1.5 text-center text-xs font-medium text-brand">Button 1</div>
                          <div className="rounded bg-gray-50 dark:bg-gray-600 px-2 py-1.5 text-center text-xs font-medium text-brand">Button 2</div>
                        </div>
                      )}
                    </div>
                  </div>
                  {/* Opt-in follow-up */}
                  {form.opt_in_message && (
                    <div className="mt-2 flex justify-start">
                      <div className="rounded-lg bg-white dark:bg-gray-700 px-3 py-2 shadow-sm max-w-[280px]">
                        <p className="text-sm text-gray-800 dark:text-gray-200">{form.opt_in_message}</p>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* Edit mode: response count */}
            {view === 'edit' && (
              <div className="flex items-center gap-3">
                <button
                  onClick={() => openResponses({
                    ...form,
                    description: form.description || null,
                    response_media_url: form.response_media_url || null,
                    starts_at: form.starts_at || null,
                    ends_at: form.ends_at || null,
                    opt_in_message: form.opt_in_message || null,
                    response_count: campaigns.find(c => c.id === form.id)?.response_count ?? 0,
                    created_at: campaigns.find(c => c.id === form.id)?.created_at ?? '',
                  })}
                  className="rounded-lg border border-gray-200 dark:border-gray-600 px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700"
                >
                  View Responses ({campaigns.find(c => c.id === form.id)?.response_count ?? 0})
                </button>
              </div>
            )}
          </div>

          {/* Right column: Settings */}
          <div className="space-y-3">
            <p className="text-xs font-medium uppercase tracking-wide text-gray-400 dark:text-gray-500">Settings</p>

            <ToggleRow
              label="Active"
              description="Campaign is live and responds to the keyword"
              checked={form.is_active}
              onChange={(v) => setForm({ ...form, is_active: v })}
            />

            {form.starts_at && form.ends_at && (
              <div className="rounded-lg border border-gray-100 dark:border-gray-700 bg-white dark:bg-gray-800 p-3">
                <p className="text-xs font-medium text-gray-500 dark:text-gray-400">Campaign Duration</p>
                <p className="mt-1 text-sm text-gray-900 dark:text-gray-100">
                  {new Date(form.starts_at).toLocaleDateString()} - {new Date(form.ends_at).toLocaleDateString()}
                </p>
              </div>
            )}

            {view === 'edit' && (
              <div className="rounded-lg border border-gray-100 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 p-3">
                <p className="text-xs font-medium uppercase tracking-wide text-gray-400 dark:text-gray-500">Total Responses</p>
                <p className="mt-1 text-lg font-bold text-gray-900 dark:text-gray-100">
                  {campaigns.find(c => c.id === form.id)?.response_count ?? 0}
                </p>
              </div>
            )}
          </div>
        </div>

        {/* Save / Cancel / Delete footer */}
        <div className="mt-6 flex gap-3 border-t border-gray-100 dark:border-gray-700 pt-4">
          <button
            onClick={handleSave}
            disabled={saving || !form.name.trim() || !form.keyword.trim() || !form.response_text.trim()}
            className="rounded-lg bg-brand px-6 py-2.5 text-sm font-semibold text-white hover:bg-brand-600 disabled:opacity-50"
          >
            {saving ? 'Saving...' : view === 'add' ? 'Create Campaign' : 'Save Changes'}
          </button>
          <button
            onClick={() => setView('list')}
            className="rounded-lg border border-gray-200 dark:border-gray-600 px-4 py-2.5 text-sm font-medium text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700"
          >
            Cancel
          </button>
          {view === 'edit' && (
            <button
              onClick={handleDelete}
              className="ml-auto rounded-lg px-4 py-2.5 text-sm font-medium text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20"
            >
              Delete Campaign
            </button>
          )}
        </div>
      </div>
    );
  }

  // ═══════════════════════════════════════════
  // CAMPAIGN LIST
  // ═══════════════════════════════════════════
  return (
    <div>
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Keyword Campaigns</h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Auto-respond when customers text a keyword to your WhatsApp
          </p>
        </div>
        <button
          onClick={openAdd}
          className="rounded-lg bg-brand px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-600"
        >
          + New Campaign
        </button>
      </div>

      {campaigns.length === 0 ? (
        <div className="mt-8 rounded-xl border border-dashed border-gray-200 dark:border-gray-700 p-12 text-center">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-gray-50 dark:bg-gray-800">
            <svg aria-hidden="true" className="h-6 w-6 text-gray-300 dark:text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 20l4-16m2 16l4-16M6 9h14M4 15h14" />
            </svg>
          </div>
          <p className="mt-3 text-sm text-gray-500 dark:text-gray-400">Create your first keyword campaign</p>
          <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">
            Set up a keyword like "PROMO" and customers who text it will get an instant auto-response
          </p>
          <button
            onClick={openAdd}
            className="mt-4 rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white hover:bg-brand-600"
          >
            + New Campaign
          </button>
        </div>
      ) : (
        <div className="mt-6 space-y-3">
          {campaigns.map((campaign) => (
            <div
              key={campaign.id}
              className="rounded-xl border border-gray-100 dark:border-gray-700 bg-white dark:bg-gray-800 p-5 transition hover:shadow-sm"
            >
              <div className="flex items-start justify-between">
                <div
                  className="min-w-0 flex-1 pr-4 cursor-pointer"
                  onClick={() => openEdit(campaign)}
                >
                  <div className="flex items-center gap-2">
                    <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">{campaign.name}</h3>
                    <span className="inline-block rounded-full bg-brand/10 px-2.5 py-0.5 text-xs font-bold text-brand font-mono">
                      {campaign.keyword}
                    </span>
                  </div>
                  {campaign.description && (
                    <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400 line-clamp-1">{campaign.description}</p>
                  )}
                </div>
                <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${
                  campaign.is_active ? 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400' : 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400'
                }`}>
                  {campaign.is_active ? 'Active' : 'Inactive'}
                </span>
              </div>

              <div className="mt-3 flex items-center gap-4 text-xs text-gray-500 dark:text-gray-400">
                <button
                  onClick={() => openResponses(campaign)}
                  className="flex items-center gap-1 hover:text-brand transition"
                >
                  <svg aria-hidden="true" className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" />
                  </svg>
                  {campaign.response_count} response{campaign.response_count !== 1 ? 's' : ''}
                </button>
                <span className="capitalize">{campaign.response_type}</span>
                {campaign.starts_at && campaign.ends_at && (
                  <span>
                    {new Date(campaign.starts_at).toLocaleDateString()} - {new Date(campaign.ends_at).toLocaleDateString()}
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Reusable toggle row ──
function ToggleRow({ label, description, checked, onChange }: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between rounded-lg border border-gray-100 dark:border-gray-700 bg-white dark:bg-gray-800 p-3">
      <div className="mr-3">
        <p className="text-sm font-medium text-gray-800 dark:text-gray-200">{label}</p>
        <p className="text-xs text-gray-400 dark:text-gray-500">{description}</p>
      </div>
      <button
        type="button"
        onClick={() => onChange(!checked)}
        className={`relative h-6 w-11 shrink-0 rounded-full transition ${checked ? 'bg-brand' : 'bg-gray-200 dark:bg-gray-600'}`}
      >
        <div className="absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition" style={{ left: checked ? '22px' : '2px' }} />
      </button>
    </div>
  );
}
