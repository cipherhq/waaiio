import { useEffect, useRef, useState } from 'react';
import { supabase, adminDb } from '@/lib/supabase';
import { Pagination } from '@/components/Pagination';
import { StatusBadge } from '@/components/StatusBadge';
import { DetailModal, DetailRow } from '@/components/DetailModal';
import { SummaryCard } from '@/components/SummaryCard';
import { fmtDate, fmtDateTime, fmtRelative } from '@/lib/formatters';
import { Phone, Globe, Settings, Radio } from 'lucide-react';

/* ─── Types ─── */

interface WhatsAppChannel {
  id: string;
  phone: string | null;
  country: string | null;
  provider: string | null;
  status: string;
  created_at: string;
  updated_at: string | null;
  [key: string]: unknown;
}

interface WhatsAppConfig {
  id: string;
  business_id: string;
  business_name?: string;
  channel_id: string | null;
  phone: string | null;
  webhook_url: string | null;
  status: string;
  created_at: string;
  updated_at: string | null;
  [key: string]: unknown;
}

interface BusinessOption {
  id: string;
  name: string;
}

/* ─── Component ─── */

export default function WhatsAppChannels() {
  const [tab, setTab] = useState<'channels' | 'configs'>('channels');

  // Channels state
  const [channels, setChannels] = useState<WhatsAppChannel[]>([]);
  const [channelPage, setChannelPage] = useState(1);
  const [selectedChannel, setSelectedChannel] = useState<WhatsAppChannel | null>(null);

  // Configs state
  const [configs, setConfigs] = useState<WhatsAppConfig[]>([]);
  const [businesses, setBusinesses] = useState<BusinessOption[]>([]);
  const [configPage, setConfigPage] = useState(1);
  const [selectedConfig, setSelectedConfig] = useState<WhatsAppConfig | null>(null);

  // Config modal actions
  const [editWebhook, setEditWebhook] = useState('');
  const [savingWebhook, setSavingWebhook] = useState(false);
  const [togglingStatus, setTogglingStatus] = useState(false);

  const [loading, setLoading] = useState(true);
  const perPage = 20;

  // Add channel form
  const [showAddForm, setShowAddForm] = useState(false);
  const [addForm, setAddForm] = useState({
    phone_number: '',
    phone_number_id: '',
    waba_id: '',
    display_name: '',
    country_code: 'US',
    channel_type: 'dedicated' as 'dedicated' | 'shared',
    business_id: '',
  });
  const [addSaving, setAddSaving] = useState(false);
  const [addError, setAddError] = useState('');
  const [allBusinesses, setAllBusinesses] = useState<BusinessOption[]>([]);

  const loadingRef = useRef(false);

  async function loadData() {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);

    try {
      const [channelRes, configRes] = await Promise.all([
        adminDb.from('whatsapp_channels').select('*').order('created_at', { ascending: false }),
        adminDb.from('whatsapp_config').select('*').order('created_at', { ascending: false }),
      ]);

      const channelRows = channelRes.data || [];
      const configRows = configRes.data || [];

      setChannels(channelRows);

      // Enrich configs with business names
      const bizIds = [...new Set(configRows.map(c => c.business_id).filter(Boolean))];
      const { data: bizData } = bizIds.length > 0
        ? await adminDb.from('businesses').select('id, name').in('id', bizIds)
        : { data: [] };

      const bizMap = new Map((bizData || []).map(b => [b.id, b.name]));
      setBusinesses(
        (bizData || []).map(b => ({ id: b.id, name: b.name })).sort((a, b) => a.name.localeCompare(b.name))
      );

      const enrichedConfigs: WhatsAppConfig[] = configRows.map(c => ({
        ...c,
        business_name: bizMap.get(c.business_id) || 'Unknown',
      }));

      setConfigs(enrichedConfigs);

      // Load all businesses for the add channel form
      const { data: allBiz } = await adminDb.from('businesses').select('id, name').eq('status', 'active').order('name');
      setAllBusinesses((allBiz || []).map(b => ({ id: b.id, name: b.name })));
    } catch (error) {
      console.warn('Failed to load WhatsApp data:', error);
    } finally {
      setLoading(false);
      loadingRef.current = false;
    }
  }

  async function handleAddChannel() {
    if (!addForm.phone_number.trim() || !addForm.phone_number_id.trim()) {
      setAddError('Phone number and Phone Number ID are required');
      return;
    }
    setAddSaving(true);
    setAddError('');

    try {
      // Get the Meta access token from the existing shared channel (reuse platform token)
      const { data: existingChannel } = await adminDb
        .from('whatsapp_channels')
        .select('meta_access_token, waba_id')
        .eq('channel_type', 'shared')
        .eq('is_active', true)
        .limit(1)
        .maybeSingle();

      const { error } = await adminDb.from('whatsapp_channels').insert({
        phone_number: addForm.phone_number.replace(/[^0-9]/g, ''),
        phone_number_id: addForm.phone_number_id.trim(),
        waba_id: addForm.waba_id.trim() || existingChannel?.waba_id || null,
        meta_access_token: existingChannel?.meta_access_token || null,
        display_name: addForm.display_name.trim() || null,
        country_code: addForm.country_code,
        channel_type: addForm.channel_type,
        business_id: addForm.channel_type === 'dedicated' && addForm.business_id ? addForm.business_id : null,
        provider: 'meta_cloud',
        is_active: true,
        connection_status: 'active',
      });

      if (error) {
        setAddError(error.message || 'Failed to add channel');
        setAddSaving(false);
        return;
      }

      // Auto-subscribe the WABA to webhooks
      const wabaId = addForm.waba_id.trim() || existingChannel?.waba_id;
      const token = existingChannel?.meta_access_token;
      if (wabaId && token) {
        try {
          await fetch(`https://graph.facebook.com/v22.0/${wabaId}/subscribed_apps`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}` },
          });
        } catch { /* non-critical */ }
      }

      // If dedicated, also assign to the business
      if (addForm.channel_type === 'dedicated' && addForm.business_id) {
        const { data: newChannel } = await adminDb
          .from('whatsapp_channels')
          .select('id')
          .eq('phone_number', addForm.phone_number.replace(/[^0-9]/g, ''))
          .maybeSingle();

        if (newChannel) {
          await adminDb.from('businesses').update({
            assigned_channel_id: newChannel.id,
            wa_method: 'transfer',
          }).eq('id', addForm.business_id);
        }
      }

      setShowAddForm(false);
      setAddForm({ phone_number: '', phone_number_id: '', waba_id: '', display_name: '', country_code: 'US', channel_type: 'dedicated', business_id: '' });
      await loadData();
    } catch (err) {
      setAddError('Something went wrong');
    } finally {
      setAddSaving(false);
    }
  }

  useEffect(() => { loadData(); }, []);

  // Stats
  const activeChannels = channels.filter(c => (c as any).connection_status === 'active' || c.status === 'active').length;
  const totalChannels = channels.length;
  const activeConfigs = configs.filter(c => c.status === 'active').length;
  const totalConfigs = configs.length;

  // Channel pagination
  const channelTotal = Math.max(1, Math.ceil(channels.length / perPage));
  const channelItems = channels.slice((channelPage - 1) * perPage, channelPage * perPage);

  // Config pagination
  const configTotal = Math.max(1, Math.ceil(configs.length / perPage));
  const configItems = configs.slice((configPage - 1) * perPage, configPage * perPage);

  // Toggle config status
  async function handleToggleStatus() {
    if (!selectedConfig) return;
    setTogglingStatus(true);

    try {
      const newStatus = selectedConfig.status === 'active' ? 'inactive' : 'active';
      const { error } = await adminDb
        .from('whatsapp_config')
        .update({ status: newStatus, updated_at: new Date().toISOString() })
        .eq('id', selectedConfig.id);

      if (error) throw error;

      setSelectedConfig({ ...selectedConfig, status: newStatus });
      await loadData();
    } catch (error) {
      console.error('Toggle status error:', error);
      alert('Failed to update status');
    } finally {
      setTogglingStatus(false);
    }
  }

  // Save webhook URL
  async function handleSaveWebhook() {
    if (!selectedConfig) return;
    setSavingWebhook(true);

    try {
      const { error } = await adminDb
        .from('whatsapp_config')
        .update({ webhook_url: editWebhook || null, updated_at: new Date().toISOString() })
        .eq('id', selectedConfig.id);

      if (error) throw error;

      setSelectedConfig({ ...selectedConfig, webhook_url: editWebhook || null });
      await loadData();
    } catch (error) {
      console.error('Save webhook error:', error);
      alert('Failed to save webhook URL');
    } finally {
      setSavingWebhook(false);
    }
  }

  // Open config modal and seed webhook field
  function openConfigModal(config: WhatsAppConfig) {
    setSelectedConfig(config);
    setEditWebhook(config.webhook_url || '');
  }

  if (loading) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-brand border-t-transparent" />
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">WhatsApp Channels</h1>
          <p className="mt-1 text-sm text-gray-500">Manage WhatsApp channels and business configurations</p>
        </div>
        <button onClick={() => setShowAddForm(!showAddForm)}
          className="rounded-xl bg-brand px-4 py-2.5 text-sm font-bold text-white transition hover:bg-brand-600">
          + Add Channel
        </button>
      </div>

      {/* Add Channel Form */}
      {showAddForm && (
        <div className="mt-4 rounded-xl border border-brand-100 bg-brand-50/30 p-5">
          <h3 className="text-sm font-semibold text-gray-900 mb-4">Add WhatsApp Channel</h3>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Phone Number *</label>
              <input type="text" value={addForm.phone_number} onChange={e => setAddForm({ ...addForm, phone_number: e.target.value })}
                placeholder="e.g. +12029226251"
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand focus:outline-none" />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Meta Phone Number ID *</label>
              <input type="text" value={addForm.phone_number_id} onChange={e => setAddForm({ ...addForm, phone_number_id: e.target.value })}
                placeholder="From Meta WhatsApp Manager"
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand focus:outline-none" />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">WABA ID</label>
              <input type="text" value={addForm.waba_id} onChange={e => setAddForm({ ...addForm, waba_id: e.target.value })}
                placeholder="Optional — reuses platform WABA"
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand focus:outline-none" />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Display Name</label>
              <input type="text" value={addForm.display_name} onChange={e => setAddForm({ ...addForm, display_name: e.target.value })}
                placeholder="e.g. Dee Interiors"
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand focus:outline-none" />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Country</label>
              <select value={addForm.country_code} onChange={e => setAddForm({ ...addForm, country_code: e.target.value })}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand focus:outline-none">
                <option value="US">US</option>
                <option value="NG">Nigeria</option>
                <option value="GB">UK</option>
                <option value="CA">Canada</option>
                <option value="GH">Ghana</option>
                <option value="KE">Kenya</option>
                <option value="ZA">South Africa</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Channel Type</label>
              <select value={addForm.channel_type} onChange={e => setAddForm({ ...addForm, channel_type: e.target.value as 'dedicated' | 'shared' })}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand focus:outline-none">
                <option value="dedicated">Dedicated (for one business)</option>
                <option value="shared">Shared (platform number)</option>
              </select>
            </div>
            {addForm.channel_type === 'dedicated' && (
              <div className="sm:col-span-2 lg:col-span-3">
                <label className="block text-xs font-medium text-gray-600 mb-1">Assign to Business</label>
                <select value={addForm.business_id} onChange={e => setAddForm({ ...addForm, business_id: e.target.value })}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand focus:outline-none">
                  <option value="">Select a business...</option>
                  {allBusinesses.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
                </select>
              </div>
            )}
          </div>
          {addError && <p className="mt-2 text-xs text-red-600">{addError}</p>}
          <div className="mt-4 flex gap-2">
            <button onClick={handleAddChannel} disabled={addSaving}
              className="rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white hover:bg-brand-600 disabled:opacity-50">
              {addSaving ? 'Adding...' : 'Add Channel'}
            </button>
            <button onClick={() => setShowAddForm(false)}
              className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50">
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Stats Cards */}
      <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <SummaryCard label="Total Channels" value={totalChannels} icon={Phone} color="green" />
        <SummaryCard label="Active Channels" value={activeChannels} icon={Radio} color="blue" />
        <SummaryCard label="Total Configs" value={totalConfigs} icon={Settings} color="purple" />
        <SummaryCard label="Active Configs" value={activeConfigs} icon={Globe} color="yellow" />
      </div>

      {/* Tabs */}
      <div className="mt-6 flex gap-1 rounded-lg bg-gray-100 p-1 w-fit">
        <button
          onClick={() => { setTab('channels'); setChannelPage(1); }}
          className={`rounded-md px-4 py-2 text-sm font-medium transition ${
            tab === 'channels' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
          }`}
        >
          Channels ({channels.length})
        </button>
        <button
          onClick={() => { setTab('configs'); setConfigPage(1); }}
          className={`rounded-md px-4 py-2 text-sm font-medium transition ${
            tab === 'configs' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
          }`}
        >
          Business Configs ({configs.length})
        </button>
      </div>

      {/* ─── Channels Tab ─── */}
      {tab === 'channels' && (
        <>
          <div className="mt-4 overflow-x-auto rounded-xl border border-gray-200 bg-white">
            {channelItems.length === 0 ? (
              <div className="py-16 text-center text-sm text-gray-500">No channels found</div>
            ) : (
              <table className="w-full text-sm">
                <thead className="border-b border-gray-100 bg-gray-50">
                  <tr>
                    <th className="px-4 py-3 text-left font-medium text-gray-500">Phone</th>
                    <th className="px-4 py-3 text-left font-medium text-gray-500">Name</th>
                    <th className="px-4 py-3 text-left font-medium text-gray-500">Country</th>
                    <th className="px-4 py-3 text-left font-medium text-gray-500">Type</th>
                    <th className="px-4 py-3 text-left font-medium text-gray-500">Status</th>
                    <th className="px-4 py-3 text-left font-medium text-gray-500">Created</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {channelItems.map(ch => (
                    <tr
                      key={ch.id}
                      onClick={() => setSelectedChannel(ch)}
                      className="cursor-pointer transition hover:bg-gray-50"
                    >
                      <td className="px-4 py-3 font-medium text-gray-900">{(ch as any).phone_number || ch.phone || '—'}</td>
                      <td className="px-4 py-3 text-gray-600">{(ch as any).display_name || '—'}</td>
                      <td className="px-4 py-3 text-gray-600">{(ch as any).country_code || ch.country || '—'}</td>
                      <td className="px-4 py-3">
                        <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${(ch as any).channel_type === 'shared' ? 'bg-blue-100 text-blue-700' : 'bg-purple-100 text-purple-700'}`}>
                          {(ch as any).channel_type || '—'}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <StatusBadge status={(ch as any).connection_status || ch.status || 'unknown'} />
                      </td>
                      <td className="px-4 py-3 text-gray-500 whitespace-nowrap">{fmtDate(ch.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <Pagination page={channelPage} totalPages={channelTotal} onPageChange={setChannelPage} />
        </>
      )}

      {/* ─── Configs Tab ─── */}
      {tab === 'configs' && (
        <>
          <div className="mt-4 overflow-x-auto rounded-xl border border-gray-200 bg-white">
            {configItems.length === 0 ? (
              <div className="py-16 text-center text-sm text-gray-500">No configurations found</div>
            ) : (
              <table className="w-full text-sm">
                <thead className="border-b border-gray-100 bg-gray-50">
                  <tr>
                    <th className="px-4 py-3 text-left font-medium text-gray-500">Business</th>
                    <th className="px-4 py-3 text-left font-medium text-gray-500">Channel / Phone</th>
                    <th className="px-4 py-3 text-left font-medium text-gray-500">Webhook URL</th>
                    <th className="px-4 py-3 text-left font-medium text-gray-500">Status</th>
                    <th className="px-4 py-3 text-left font-medium text-gray-500">Created</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {configItems.map(cfg => (
                    <tr
                      key={cfg.id}
                      onClick={() => openConfigModal(cfg)}
                      className="cursor-pointer transition hover:bg-gray-50"
                    >
                      <td className="px-4 py-3 font-medium text-gray-900">{cfg.business_name}</td>
                      <td className="px-4 py-3 text-gray-600">
                        {cfg.channel_id ? cfg.channel_id.slice(0, 8) + '...' : cfg.phone || '—'}
                      </td>
                      <td className="px-4 py-3 text-gray-600 max-w-[200px] truncate">
                        {cfg.webhook_url || '—'}
                      </td>
                      <td className="px-4 py-3">
                        <StatusBadge status={cfg.status} />
                      </td>
                      <td className="px-4 py-3 text-gray-500 whitespace-nowrap">{fmtDate(cfg.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <Pagination page={configPage} totalPages={configTotal} onPageChange={setConfigPage} />
        </>
      )}

      {/* ─── Channel Detail Modal ─── */}
      <DetailModal
        open={!!selectedChannel}
        onClose={() => setSelectedChannel(null)}
        title="Channel Details"
      >
        {selectedChannel && (
          <div className="space-y-3 text-sm">
            <DetailRow label="Channel ID" value={selectedChannel.id} />
            <DetailRow label="Phone" value={selectedChannel.phone} />
            <DetailRow label="Country" value={selectedChannel.country} />
            <DetailRow label="Provider" value={selectedChannel.provider} />
            <DetailRow label="Status" value={selectedChannel.status} />

            <div className="my-3 border-t border-gray-100" />

            <DetailRow label="Created" value={fmtDateTime(selectedChannel.created_at)} />
            <DetailRow label="Updated" value={selectedChannel.updated_at ? fmtDateTime(selectedChannel.updated_at) : null} />

            {/* Render any extra fields from the row */}
            {(() => {
              const knownKeys = new Set(['id', 'phone', 'country', 'provider', 'status', 'created_at', 'updated_at']);
              const extras = Object.entries(selectedChannel).filter(([k]) => !knownKeys.has(k));
              if (extras.length === 0) return null;
              return (
                <>
                  <div className="my-3 border-t border-gray-100" />
                  <div className="rounded-lg bg-gray-50 p-4">
                    <p className="text-xs font-semibold uppercase text-gray-500 mb-2">Additional Fields</p>
                    <div className="space-y-2">
                      {extras.map(([k, v]) => (
                        <DetailRow
                          key={k}
                          label={k.replace(/_/g, ' ')}
                          value={v != null ? String(v) : null}
                        />
                      ))}
                    </div>
                  </div>
                </>
              );
            })()}
          </div>
        )}
      </DetailModal>

      {/* ─── Config Detail Modal (with Actions) ─── */}
      <DetailModal
        open={!!selectedConfig}
        onClose={() => { setSelectedConfig(null); setEditWebhook(''); }}
        title="Configuration Details"
        wide
      >
        {selectedConfig && (
          <div className="space-y-3 text-sm">
            <DetailRow label="Config ID" value={selectedConfig.id} />
            <DetailRow label="Status" value={selectedConfig.status} />
            <DetailRow label="Created" value={fmtDateTime(selectedConfig.created_at)} />
            {selectedConfig.updated_at && (
              <DetailRow label="Updated" value={fmtDateTime(selectedConfig.updated_at)} />
            )}

            <div className="my-3 border-t border-gray-100" />

            <div className="rounded-lg bg-gray-50 p-4">
              <p className="text-xs font-semibold uppercase text-gray-500 mb-2">Business</p>
              <div className="space-y-2">
                <DetailRow label="Business" value={selectedConfig.business_name || '—'} />
                <DetailRow label="Business ID" value={selectedConfig.business_id} />
              </div>
            </div>

            <div className="rounded-lg bg-gray-50 p-4">
              <p className="text-xs font-semibold uppercase text-gray-500 mb-2">Channel Info</p>
              <div className="space-y-2">
                <DetailRow label="Channel ID" value={selectedConfig.channel_id} />
                <DetailRow label="Phone" value={selectedConfig.phone} />
              </div>
            </div>

            {/* Actions */}
            <div className="my-3 border-t border-gray-100" />

            <div className="rounded-lg border border-gray-200 bg-white p-4 space-y-4">
              <p className="text-xs font-semibold uppercase text-gray-500">Actions</p>

              {/* Toggle Status */}
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-gray-900">Status</p>
                  <p className="text-xs text-gray-500">
                    Currently <span className="font-medium">{selectedConfig.status}</span>
                  </p>
                </div>
                <button
                  onClick={handleToggleStatus}
                  disabled={togglingStatus}
                  className={`rounded-lg px-4 py-2 text-xs font-medium transition disabled:opacity-50 ${
                    selectedConfig.status === 'active'
                      ? 'bg-red-100 text-red-700 hover:bg-red-200'
                      : 'bg-green-100 text-green-700 hover:bg-green-200'
                  }`}
                >
                  {togglingStatus
                    ? 'Updating...'
                    : selectedConfig.status === 'active'
                      ? 'Deactivate'
                      : 'Activate'}
                </button>
              </div>

              {/* Update Webhook URL */}
              <div>
                <p className="text-sm font-medium text-gray-900 mb-2">Webhook URL</p>
                <div className="flex gap-2">
                  <input
                    type="url"
                    value={editWebhook}
                    onChange={e => setEditWebhook(e.target.value)}
                    placeholder="https://example.com/webhook"
                    className="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 focus:border-brand focus:outline-none"
                  />
                  <button
                    onClick={handleSaveWebhook}
                    disabled={savingWebhook}
                    className="rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white transition hover:bg-brand-600 disabled:opacity-50"
                  >
                    {savingWebhook ? 'Saving...' : 'Save'}
                  </button>
                </div>
              </div>
            </div>

            {/* Render any extra fields from the row */}
            {(() => {
              const knownKeys = new Set([
                'id', 'business_id', 'business_name', 'channel_id', 'phone',
                'webhook_url', 'status', 'created_at', 'updated_at',
              ]);
              const extras = Object.entries(selectedConfig).filter(([k]) => !knownKeys.has(k));
              if (extras.length === 0) return null;
              return (
                <div className="rounded-lg bg-gray-50 p-4">
                  <p className="text-xs font-semibold uppercase text-gray-500 mb-2">Additional Fields</p>
                  <div className="space-y-2">
                    {extras.map(([k, v]) => (
                      <DetailRow
                        key={k}
                        label={k.replace(/_/g, ' ')}
                        value={v != null ? String(v) : null}
                      />
                    ))}
                  </div>
                </div>
              );
            })()}
          </div>
        )}
      </DetailModal>
    </div>
  );
}
