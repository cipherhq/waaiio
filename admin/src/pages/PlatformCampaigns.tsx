import { useEffect, useState } from 'react';
import { adminApiGet, adminApiPut, getAdminApiBase } from '@/lib/adminApi';
import { supabase } from '@/lib/supabase';
import { Megaphone, Plus, QrCode, ExternalLink } from 'lucide-react';

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

const STATUS_COLORS: Record<string, string> = {
  draft: 'bg-gray-100 text-gray-700',
  active: 'bg-green-100 text-green-700',
  paused: 'bg-amber-100 text-amber-700',
  completed: 'bg-blue-100 text-blue-700',
  archived: 'bg-gray-200 text-gray-500',
};

export default function PlatformCampaigns() {
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  // Create form
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [newType, setNewType] = useState('opt_in');

  async function loadCampaigns() {
    try {
      const res = await adminApiGet('/api/admin/platform-campaigns');
      if (res.ok) {
        const json = await res.json();
        setCampaigns(json.data || []);
      } else {
        setError('Failed to load campaigns');
      }
    } catch {
      setError('Failed to connect');
    }
    setLoading(false);
  }

  useEffect(() => { loadCampaigns(); }, []);

  async function handleCreate() {
    if (!newName.trim()) return;
    setCreating(true);
    setError(null);
    try {
      const base = getAdminApiBase();
      const { data: session } = await supabase.auth.getSession();
      const token = session?.session?.access_token;
      if (!token) throw new Error('Not authenticated');

      const res = await fetch(`${base}/api/admin/platform-campaigns`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ name: newName.trim(), campaign_type: newType }),
      });
      if (res.ok) {
        setNewName('');
        setShowCreate(false);
        await loadCampaigns();
      } else {
        const json = await res.json().catch(() => ({ error: 'Failed' }));
        setError(json.error || 'Failed to create campaign');
      }
    } catch {
      setError('Failed to create campaign');
    }
    setCreating(false);
  }

  if (loading) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-brand border-t-transparent" />
      </div>
    );
  }

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
        <button
          onClick={() => setShowCreate(!showCreate)}
          className="flex items-center gap-2 rounded-xl bg-brand px-4 py-2 text-sm font-bold text-white transition hover:bg-brand-600"
        >
          <Plus className="h-4 w-4" /> New Campaign
        </button>
      </div>

      {showCreate && (
        <div className="rounded-2xl border border-brand-100 bg-brand-50/30 p-5 space-y-4">
          <h3 className="text-sm font-bold text-gray-800">Create Campaign</h3>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">Name</label>
              <input
                type="text"
                value={newName}
                onChange={e => setNewName(e.target.value)}
                placeholder="e.g. Launch Waitlist US"
                className="w-full rounded-xl border border-gray-300 px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">Type</label>
              <select
                value={newType}
                onChange={e => setNewType(e.target.value)}
                className="w-full rounded-xl border border-gray-300 px-3 py-2 text-sm"
              >
                <option value="opt_in">Opt-in</option>
                <option value="waitlist">Waitlist</option>
                <option value="survey">Survey</option>
                <option value="feedback">Feedback</option>
                <option value="data_collection">Data Collection</option>
                <option value="notification">Notification</option>
                <option value="broadcast">Broadcast</option>
              </select>
            </div>
          </div>
          <div className="flex gap-2">
            <button
              onClick={handleCreate}
              disabled={creating || !newName.trim()}
              className="rounded-xl bg-brand px-5 py-2 text-sm font-bold text-white transition hover:bg-brand-600 disabled:opacity-50"
            >
              {creating ? 'Creating...' : 'Create'}
            </button>
            <button
              onClick={() => setShowCreate(false)}
              className="rounded-xl px-4 py-2 text-sm text-gray-500 hover:bg-gray-100"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {error && (
        <div className="rounded-xl bg-red-50 px-4 py-2 text-sm text-red-700">{error}</div>
      )}

      {campaigns.length === 0 ? (
        <div className="rounded-2xl border border-gray-200 bg-white p-12 text-center">
          <Megaphone className="mx-auto h-10 w-10 text-gray-300" />
          <p className="mt-3 text-sm text-gray-500">No campaigns yet. Create your first tracked campaign.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {campaigns.map(c => (
            <div key={c.id} className="rounded-2xl border border-gray-200 bg-white p-5">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-sm font-bold text-gray-900">{c.name}</h3>
                  <div className="mt-1 flex items-center gap-2 text-xs text-gray-500">
                    <span className="capitalize">{c.campaign_type.replace(/_/g, ' ')}</span>
                    {c.market_scope.length > 0 && (
                      <span>· {c.market_scope.join(', ')}</span>
                    )}
                    <span>· {new Date(c.created_at).toLocaleDateString()}</span>
                  </div>
                </div>
                <span className={`rounded-full px-3 py-1 text-xs font-semibold ${STATUS_COLORS[c.status] || STATUS_COLORS.draft}`}>
                  {c.status}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
