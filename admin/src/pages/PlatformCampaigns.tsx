import { useEffect, useState } from 'react';
import { adminApiGet, getAdminApiBase } from '@/lib/adminApi';
import { supabase } from '@/lib/supabase';
import { Megaphone, Plus, QrCode, Copy, Check, ExternalLink, Link2, ChevronLeft, ToggleLeft, ToggleRight } from 'lucide-react';

interface Campaign {
  id: string;
  name: string;
  campaign_type: string;
  status: string;
  market_scope: string[];
  consent_type: string;
  starts_at: string | null;
  ends_at: string | null;
  created_at: string;
}

interface Asset {
  id: string;
  campaign_id: string;
  source_type: string;
  source_label: string | null;
  market: string;
  attribution_token: string;
  prefilled_message: string;
  is_active: boolean;
  created_at: string;
  click_count?: number;
}

interface Channel {
  id: string;
  phone_number: string;
  country_code: string;
  display_name: string | null;
}

const STATUS_COLORS: Record<string, string> = {
  draft: 'bg-gray-100 text-gray-700',
  active: 'bg-green-100 text-green-700',
  paused: 'bg-amber-100 text-amber-700',
  completed: 'bg-blue-100 text-blue-700',
  archived: 'bg-gray-200 text-gray-500',
};

const SOURCE_TYPES = [
  { value: 'website_button', label: 'Website Button' },
  { value: 'website_qr', label: 'Website QR' },
  { value: 'instagram_link', label: 'Instagram Link' },
  { value: 'instagram_qr', label: 'Instagram QR' },
  { value: 'billboard_qr', label: 'Billboard QR' },
  { value: 'flyer_qr', label: 'Flyer QR' },
  { value: 'event_qr', label: 'Event QR' },
  { value: 'direct_link', label: 'Direct Link' },
  { value: 'email_link', label: 'Email Link' },
  { value: 'other', label: 'Other' },
];

const CONSENT_TYPES = [
  { value: 'opt_in', label: 'Opt-in (marketing consent)' },
  { value: 'informational', label: 'Informational (no marketing consent)' },
  { value: 'transactional', label: 'Transactional' },
];

async function apiFetch(path: string, method: string, body?: Record<string, unknown>) {
  const base = getAdminApiBase();
  const { data: session } = await supabase.auth.getSession();
  const token = session?.session?.access_token;
  if (!token) throw new Error('Not authenticated');
  const opts: RequestInit = { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` } };
  if (body) opts.body = JSON.stringify(body);
  return fetch(`${base}${path}`, opts);
}

export default function PlatformCampaigns() {
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedCampaign, setSelectedCampaign] = useState<Campaign | null>(null);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [counts, setCounts] = useState({ participants: 0, events: 0, assets: 0 });

  // Create campaign form
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [newType, setNewType] = useState('opt_in');
  const [newConsent, setNewConsent] = useState('');
  const [creating, setCreating] = useState(false);

  // Create asset form
  const [showAssetForm, setShowAssetForm] = useState(false);
  const [assetSourceType, setAssetSourceType] = useState('website_button');
  const [assetSourceLabel, setAssetSourceLabel] = useState('');
  const [assetChannelId, setAssetChannelId] = useState('');
  const [assetMessage, setAssetMessage] = useState('');
  const [creatingAsset, setCreatingAsset] = useState(false);

  // Tracked link display
  const [copiedToken, setCopiedToken] = useState<string | null>(null);

  async function loadCampaigns() {
    try {
      const res = await adminApiGet('/api/admin/platform-campaigns');
      if (res.ok) {
        const json = await res.json();
        setCampaigns(json.data || []);
      } else setError('Failed to load campaigns');
    } catch { setError('Failed to connect'); }
    setLoading(false);
  }

  async function loadCampaignDetail(c: Campaign) {
    setSelectedCampaign(c);
    setError(null);
    try {
      const [detailRes, channelsRes] = await Promise.all([
        apiFetch(`/api/admin/platform-campaigns/${c.id}`, 'GET'),
        apiFetch(`/api/admin/platform-campaigns/${c.id}/channels`, 'GET'),
      ]);
      if (detailRes.ok) {
        const json = await detailRes.json();
        setAssets(json.assets || []);
        setCounts(json.counts || { participants: 0, events: 0, assets: 0 });
      }
      if (channelsRes.ok) {
        const json = await channelsRes.json();
        setChannels(json.data || []);
      }
    } catch { setError('Failed to load details'); }
  }

  useEffect(() => { loadCampaigns(); }, []);

  async function handleCreateCampaign() {
    if (!newName.trim() || !newConsent) return;
    setCreating(true); setError(null);
    try {
      const res = await apiFetch('/api/admin/platform-campaigns', 'POST', {
        name: newName.trim(), campaign_type: newType, consent_type: newConsent,
      });
      if (res.ok) {
        setNewName(''); setNewConsent(''); setShowCreate(false);
        await loadCampaigns();
      } else {
        const json = await res.json().catch(() => ({ error: 'Failed' }));
        setError(json.error);
      }
    } catch { setError('Failed to create'); }
    setCreating(false);
  }

  async function handleStatusChange(status: string) {
    if (!selectedCampaign) return;
    try {
      const res = await apiFetch(`/api/admin/platform-campaigns/${selectedCampaign.id}`, 'PUT', { status });
      if (res.ok) {
        const json = await res.json();
        setSelectedCampaign(json.data);
        await loadCampaigns();
      } else {
        const json = await res.json().catch(() => ({ error: 'Failed' }));
        setError(json.error);
      }
    } catch { setError('Failed to update'); }
  }

  async function handleCreateAsset() {
    if (!selectedCampaign || !assetChannelId || !assetMessage.trim()) return;
    setCreatingAsset(true); setError(null);
    try {
      const res = await apiFetch(`/api/admin/platform-campaigns/${selectedCampaign.id}/assets`, 'POST', {
        source_type: assetSourceType,
        source_label: assetSourceLabel.trim() || null,
        channel_id: assetChannelId,
        prefilled_message: assetMessage.trim(),
      });
      if (res.ok) {
        setShowAssetForm(false); setAssetMessage(''); setAssetSourceLabel('');
        await loadCampaignDetail(selectedCampaign);
      } else {
        const json = await res.json().catch(() => ({ error: 'Failed' }));
        setError(json.error);
      }
    } catch { setError('Failed to create asset'); }
    setCreatingAsset(false);
  }

  async function handleToggleAsset(asset: Asset) {
    if (!selectedCampaign) return;
    try {
      await apiFetch(`/api/admin/platform-campaigns/${selectedCampaign.id}/assets/${asset.id}`, 'PUT', {
        is_active: !asset.is_active,
      });
      await loadCampaignDetail(selectedCampaign);
    } catch { setError('Failed to update asset'); }
  }

  function copyTrackedLink(token: string) {
    const url = `${window.location.origin.replace(/admin[.-]?/, '').replace(/:\d+$/, ':3000')}/go/${token}`;
    navigator.clipboard.writeText(url).then(() => {
      setCopiedToken(token);
      setTimeout(() => setCopiedToken(null), 2000);
    });
  }

  if (loading) {
    return <div className="flex min-h-[40vh] items-center justify-center"><div className="h-8 w-8 animate-spin rounded-full border-4 border-brand border-t-transparent" /></div>;
  }

  // Campaign detail view
  if (selectedCampaign) {
    return (
      <div className="space-y-6">
        <button onClick={() => { setSelectedCampaign(null); setAssets([]); }} className="flex items-center gap-1 text-sm text-gray-500 hover:text-brand">
          <ChevronLeft className="h-4 w-4" /> Back to campaigns
        </button>

        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold text-gray-900">{selectedCampaign.name}</h1>
            <div className="mt-1 flex items-center gap-2 text-xs text-gray-500">
              <span className="capitalize">{selectedCampaign.campaign_type.replace(/_/g, ' ')}</span>
              <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${STATUS_COLORS[selectedCampaign.status] || ''}`}>{selectedCampaign.status}</span>
              <span>Consent: {selectedCampaign.consent_type}</span>
            </div>
          </div>
          <div className="flex gap-2">
            {selectedCampaign.status === 'draft' && (
              <button onClick={() => handleStatusChange('active')} className="rounded-xl bg-green-100 px-3 py-1.5 text-xs font-bold text-green-700 hover:bg-green-200">Activate</button>
            )}
            {selectedCampaign.status === 'active' && (
              <button onClick={() => handleStatusChange('paused')} className="rounded-xl bg-amber-100 px-3 py-1.5 text-xs font-bold text-amber-700 hover:bg-amber-200">Pause</button>
            )}
            {selectedCampaign.status === 'paused' && (
              <button onClick={() => handleStatusChange('active')} className="rounded-xl bg-green-100 px-3 py-1.5 text-xs font-bold text-green-700 hover:bg-green-200">Resume</button>
            )}
            {['draft', 'paused', 'completed'].includes(selectedCampaign.status) && (
              <button onClick={() => handleStatusChange('archived')} className="rounded-xl bg-gray-100 px-3 py-1.5 text-xs font-bold text-gray-600 hover:bg-gray-200">Archive</button>
            )}
          </div>
        </div>

        {/* Counts */}
        <div className="grid grid-cols-3 gap-4">
          <div className="rounded-2xl border border-gray-200 bg-white p-4 text-center">
            <p className="text-2xl font-bold text-gray-900">{counts.participants}</p>
            <p className="text-xs text-gray-500">Participants</p>
          </div>
          <div className="rounded-2xl border border-gray-200 bg-white p-4 text-center">
            <p className="text-2xl font-bold text-gray-900">{counts.events}</p>
            <p className="text-xs text-gray-500">Events</p>
          </div>
          <div className="rounded-2xl border border-gray-200 bg-white p-4 text-center">
            <p className="text-2xl font-bold text-gray-900">{counts.assets}</p>
            <p className="text-xs text-gray-500">Tracked Assets</p>
          </div>
        </div>

        {error && <div className="rounded-xl bg-red-50 px-4 py-2 text-sm text-red-700">{error}</div>}

        {/* Assets */}
        <div className="rounded-2xl border border-gray-200 bg-white p-5">
          <div className="flex items-center justify-between mb-4">
            <h3 className="flex items-center gap-2 text-sm font-bold text-gray-700"><Link2 className="h-4 w-4" /> Tracked Links & QR Codes</h3>
            <button onClick={() => setShowAssetForm(!showAssetForm)} className="flex items-center gap-1.5 rounded-xl bg-brand px-3 py-1.5 text-xs font-bold text-white hover:bg-brand-600">
              <Plus className="h-3.5 w-3.5" /> Create Asset
            </button>
          </div>

          {showAssetForm && (
            <div className="mb-4 rounded-xl border border-brand-100 bg-brand-50/30 p-4 space-y-3">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <label className="mb-1 block text-xs font-medium text-gray-700">Source Type</label>
                  <select value={assetSourceType} onChange={e => setAssetSourceType(e.target.value)} className="w-full rounded-xl border border-gray-300 px-3 py-2 text-sm">
                    {SOURCE_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                  </select>
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-gray-700">Label (optional)</label>
                  <input type="text" value={assetSourceLabel} onChange={e => setAssetSourceLabel(e.target.value)} placeholder="e.g. Billboard @ Times Square" maxLength={200} className="w-full rounded-xl border border-gray-300 px-3 py-2 text-sm" />
                </div>
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-gray-700">Shared Waaiio Channel</label>
                {channels.length === 0 ? (
                  <p className="text-xs text-amber-600">No eligible shared channels found for this campaign's market scope.</p>
                ) : (
                  <select value={assetChannelId} onChange={e => setAssetChannelId(e.target.value)} className="w-full rounded-xl border border-gray-300 px-3 py-2 text-sm">
                    <option value="">Select a channel...</option>
                    {channels.map(ch => (
                      <option key={ch.id} value={ch.id}>{ch.country_code} — {ch.phone_number}{ch.display_name ? ` (${ch.display_name})` : ''}</option>
                    ))}
                  </select>
                )}
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-gray-700">Prefilled Message (max 1000 chars)</label>
                <textarea value={assetMessage} onChange={e => setAssetMessage(e.target.value)} maxLength={1000} rows={2} placeholder="e.g. Notify me when Waaiio launches" className="w-full rounded-xl border border-gray-300 px-3 py-2 text-sm" />
                <p className="mt-1 text-xs text-gray-400">The server will append a visible Ref token automatically.</p>
              </div>
              <div className="flex gap-2">
                <button onClick={handleCreateAsset} disabled={creatingAsset || !assetChannelId || !assetMessage.trim()} className="rounded-xl bg-brand px-4 py-2 text-xs font-bold text-white hover:bg-brand-600 disabled:opacity-50">
                  {creatingAsset ? 'Creating...' : 'Create Tracked Asset'}
                </button>
                <button onClick={() => setShowAssetForm(false)} className="rounded-xl px-3 py-2 text-xs text-gray-500 hover:bg-gray-100">Cancel</button>
              </div>
            </div>
          )}

          {assets.length === 0 ? (
            <p className="text-sm text-gray-400 text-center py-6">No tracked assets yet. Create one to get a tracked WhatsApp link.</p>
          ) : (
            <div className="space-y-3">
              {assets.map(a => (
                <div key={a.id} className={`rounded-xl border p-4 ${a.is_active ? 'border-gray-200 bg-white' : 'border-gray-100 bg-gray-50 opacity-60'}`}>
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-semibold text-gray-900">{SOURCE_TYPES.find(t => t.value === a.source_type)?.label || a.source_type}</span>
                        {a.source_label && <span className="text-xs text-gray-500">— {a.source_label}</span>}
                        <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-mono text-gray-600">{a.market}</span>
                      </div>
                      <div className="mt-1 flex items-center gap-3 text-xs text-gray-500">
                        <span className="font-mono">Ref: {a.attribution_token}</span>
                        <span>{a.click_count || 0} clicks</span>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <button onClick={() => copyTrackedLink(a.attribution_token)} className="flex items-center gap-1 rounded-lg border border-gray-200 px-2.5 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50">
                        {copiedToken === a.attribution_token ? <Check className="h-3.5 w-3.5 text-green-600" /> : <Copy className="h-3.5 w-3.5" />}
                        {copiedToken === a.attribution_token ? 'Copied!' : 'Copy Link'}
                      </button>
                      <button onClick={() => handleToggleAsset(a)} className="text-gray-400 hover:text-gray-600" title={a.is_active ? 'Deactivate' : 'Activate'}>
                        {a.is_active ? <ToggleRight className="h-5 w-5 text-green-500" /> : <ToggleLeft className="h-5 w-5" />}
                      </button>
                    </div>
                  </div>
                  <div className="mt-2 rounded-lg bg-gray-50 px-3 py-2 text-xs text-gray-600 font-mono break-all">
                    /go/{a.attribution_token}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }

  // Campaign list view
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Megaphone className="h-6 w-6 text-brand" />
          <div>
            <h1 className="text-xl font-bold text-gray-900">Platform Campaigns</h1>
            <p className="text-sm text-gray-500">Tracked WhatsApp campaigns with QR/link attribution</p>
          </div>
        </div>
        <button onClick={() => setShowCreate(!showCreate)} className="flex items-center gap-2 rounded-xl bg-brand px-4 py-2 text-sm font-bold text-white transition hover:bg-brand-600">
          <Plus className="h-4 w-4" /> New Campaign
        </button>
      </div>

      {showCreate && (
        <div className="rounded-2xl border border-brand-100 bg-brand-50/30 p-5 space-y-4">
          <h3 className="text-sm font-bold text-gray-800">Create Campaign</h3>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">Name</label>
              <input type="text" value={newName} onChange={e => setNewName(e.target.value)} placeholder="e.g. Launch Waitlist US" maxLength={200} className="w-full rounded-xl border border-gray-300 px-3 py-2 text-sm" />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">Type</label>
              <select value={newType} onChange={e => setNewType(e.target.value)} className="w-full rounded-xl border border-gray-300 px-3 py-2 text-sm">
                <option value="opt_in">Opt-in</option>
                <option value="waitlist">Waitlist</option>
                <option value="survey">Survey</option>
                <option value="feedback">Feedback</option>
                <option value="data_collection">Data Collection</option>
                <option value="notification">Notification</option>
                <option value="broadcast">Broadcast</option>
              </select>
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">Consent Type <span className="text-red-500">*</span></label>
              <select value={newConsent} onChange={e => setNewConsent(e.target.value)} className="w-full rounded-xl border border-gray-300 px-3 py-2 text-sm">
                <option value="">Select consent type...</option>
                {CONSENT_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
            </div>
          </div>
          <div className="flex gap-2">
            <button onClick={handleCreateCampaign} disabled={creating || !newName.trim() || !newConsent} className="rounded-xl bg-brand px-5 py-2 text-sm font-bold text-white transition hover:bg-brand-600 disabled:opacity-50">
              {creating ? 'Creating...' : 'Create'}
            </button>
            <button onClick={() => setShowCreate(false)} className="rounded-xl px-4 py-2 text-sm text-gray-500 hover:bg-gray-100">Cancel</button>
          </div>
        </div>
      )}

      {error && <div className="rounded-xl bg-red-50 px-4 py-2 text-sm text-red-700">{error}</div>}

      {campaigns.length === 0 ? (
        <div className="rounded-2xl border border-gray-200 bg-white p-12 text-center">
          <Megaphone className="mx-auto h-10 w-10 text-gray-300" />
          <p className="mt-3 text-sm text-gray-500">No campaigns yet. Create your first tracked campaign.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {campaigns.map(c => (
            <button key={c.id} onClick={() => loadCampaignDetail(c)} className="w-full rounded-2xl border border-gray-200 bg-white p-5 text-left transition hover:border-brand-100 hover:shadow-sm">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-sm font-bold text-gray-900">{c.name}</h3>
                  <div className="mt-1 flex items-center gap-2 text-xs text-gray-500">
                    <span className="capitalize">{c.campaign_type.replace(/_/g, ' ')}</span>
                    <span>· {c.consent_type}</span>
                    {c.market_scope.length > 0 && <span>· {c.market_scope.join(', ')}</span>}
                    <span>· {new Date(c.created_at).toLocaleDateString()}</span>
                  </div>
                </div>
                <span className={`rounded-full px-3 py-1 text-xs font-semibold ${STATUS_COLORS[c.status] || STATUS_COLORS.draft}`}>{c.status}</span>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
