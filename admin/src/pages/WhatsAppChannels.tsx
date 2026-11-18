import { useEffect, useRef, useState } from 'react';
import { adminDb } from '@/lib/supabase';
import { useAdminSession } from '@/components/AdminLayout';
import { hasAccess } from '@/lib/permissions';
import { Pagination } from '@/components/Pagination';
import { SortableTh } from '@/components/SortableTh';
import { sortTime, useTableSort } from '@/lib/tableSort';
import { StatusBadge } from '@/components/StatusBadge';
import { DetailModal, DetailRow } from '@/components/DetailModal';
import { SummaryCard } from '@/components/SummaryCard';
import { fmtDate, fmtDateTime, fmtRelative } from '@/lib/formatters';
import { Phone, Globe, Settings, Radio } from 'lucide-react';

/* ─── Types ─── */

interface WhatsAppChannel {
  id: string;
  phone_number: string | null;
  country_code: string | null;
  display_name: string | null;
  channel_type: string | null;
  connection_status: string | null;
  provider: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string | null;
  [key: string]: unknown;
}

// whatsapp_config is a business's bot settings (M001 and later). It has no status,
// channel_id, phone or webhook_url columns, so the tab now shows the real ones (#1108 X4).
interface WhatsAppConfig {
  id: string;
  business_id: string;
  business_name?: string;
  bot_alias: string | null;
  auto_confirm: boolean | null;
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
  const adminSession = useAdminSession();
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

  const [loading, setLoading] = useState(true);
  const perPage = 20;

  const loadingRef = useRef(false);

  async function loadData() {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);

    try {
      const [channelRes, configRes] = await Promise.all([
        adminDb.from('whatsapp_channels')
          .select('id, phone_number, country_code, display_name, channel_type, connection_status, provider, is_active, created_at, updated_at')
          .order('created_at', { ascending: false }),
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

    } catch (error) {
      console.warn('Failed to load WhatsApp data:', error);
    } finally {
      setLoading(false);
      loadingRef.current = false;
    }
  }

  useEffect(() => { loadData(); }, []);

  // Stats
  const activeChannels = channels.filter(c => c.connection_status === 'active').length;
  const totalChannels = channels.length;
  const autoConfirmConfigs = configs.filter(c => c.auto_confirm === true).length;
  const totalConfigs = configs.length;

  // Channel pagination
  const channelTotal = Math.max(1, Math.ceil(channels.length / perPage));
  const channelSort = useTableSort(channels, {
    phone: ch => ch.phone_number,
    name: ch => ch.display_name,
    country: ch => ch.country_code,
    type: ch => ch.channel_type,
    status: ch => ch.connection_status || 'unknown',
    created: ch => sortTime(ch.created_at),
  }, { onSortChange: () => setChannelPage(1) });
  const channelItems = channelSort.sorted.slice((channelPage - 1) * perPage, channelPage * perPage);

  // Config pagination
  const configTotal = Math.max(1, Math.ceil(configs.length / perPage));
  const configSort = useTableSort(configs, {
    business: cfg => cfg.business_name,
    alias: cfg => cfg.bot_alias,
    autoConfirm: cfg => (cfg.auto_confirm ? 1 : 0),
    updated: cfg => sortTime(cfg.updated_at || cfg.created_at),
  }, { onSortChange: () => setConfigPage(1) });
  const configItems = configSort.sorted.slice((configPage - 1) * perPage, configPage * perPage);

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
        {adminSession?.role && hasAccess('customer-onboarding', adminSession.role) && <a href="/whatsapp-assistance" className="rounded-xl bg-brand px-4 py-2.5 text-sm font-bold text-white transition hover:bg-brand-600">
          Help Business Connect WhatsApp
        </a>}
      </div>
      <p className="mt-3 rounded-lg border border-blue-100 bg-blue-50 p-3 text-xs text-blue-800">
        Customer-owned WABA numbers must be connected through the owner's authenticated Meta flow.
        New shared platform channels must be provisioned using a verified platform process; copying access tokens
        or manually marking an unverified number active is not supported in the admin console.
      </p>

            {/* Stats Cards */}
      <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <SummaryCard label="Total Channels" value={totalChannels} icon={Phone} color="green" />
        <SummaryCard label="Active Channels" value={activeChannels} icon={Radio} color="blue" />
        <SummaryCard label="Total Configs" value={totalConfigs} icon={Settings} color="purple" />
        <SummaryCard label="Auto-confirm on" value={autoConfirmConfigs} icon={Globe} color="yellow" />
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
                    <SortableTh {...channelSort.sortProps('phone')} className="px-4 py-3 text-left font-medium text-gray-500">Phone</SortableTh>
                    <SortableTh {...channelSort.sortProps('name')} className="px-4 py-3 text-left font-medium text-gray-500">Name</SortableTh>
                    <SortableTh {...channelSort.sortProps('country')} className="px-4 py-3 text-left font-medium text-gray-500">Country</SortableTh>
                    <SortableTh {...channelSort.sortProps('type')} className="px-4 py-3 text-left font-medium text-gray-500">Type</SortableTh>
                    <SortableTh {...channelSort.sortProps('status')} className="px-4 py-3 text-left font-medium text-gray-500">Status</SortableTh>
                    <SortableTh {...channelSort.sortProps('created')} className="px-4 py-3 text-left font-medium text-gray-500">Created</SortableTh>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {channelItems.map(ch => (
                    <tr
                      key={ch.id}
                      onClick={() => setSelectedChannel(ch)}
                      className="cursor-pointer transition hover:bg-gray-50"
                    >
                      <td className="px-4 py-3 font-medium text-gray-900">{ch.phone_number || '—'}</td>
                      <td className="px-4 py-3 text-gray-600">{ch.display_name || '—'}</td>
                      <td className="px-4 py-3 text-gray-600">{ch.country_code || '—'}</td>
                      <td className="px-4 py-3">
                        <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${ch.channel_type === 'shared' ? 'bg-blue-100 text-blue-700' : 'bg-purple-100 text-purple-700'}`}>
                          {ch.channel_type || '—'}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <StatusBadge status={ch.connection_status || 'unknown'} />
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
                    <SortableTh {...configSort.sortProps('business')} className="px-4 py-3 text-left font-medium text-gray-500">Business</SortableTh>
                    <SortableTh {...configSort.sortProps('alias')} className="px-4 py-3 text-left font-medium text-gray-500">Bot alias</SortableTh>
                    <SortableTh {...configSort.sortProps('autoConfirm')} className="px-4 py-3 text-left font-medium text-gray-500">Auto-confirm</SortableTh>
                    <SortableTh {...configSort.sortProps('updated')} className="px-4 py-3 text-left font-medium text-gray-500">Updated</SortableTh>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {configItems.map(cfg => (
                    <tr
                      key={cfg.id}
                      onClick={() => setSelectedConfig(cfg)}
                      className="cursor-pointer transition hover:bg-gray-50"
                    >
                      <td className="px-4 py-3 font-medium text-gray-900">{cfg.business_name}</td>
                      <td className="px-4 py-3 text-gray-600">{cfg.bot_alias || '—'}</td>
                      <td className="px-4 py-3 text-gray-600">{cfg.auto_confirm ? 'On' : 'Off'}</td>
                      <td className="px-4 py-3 text-gray-500 whitespace-nowrap">{fmtDate(cfg.updated_at || cfg.created_at)}</td>
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
            <DetailRow label="Phone" value={selectedChannel.phone_number} />
            <DetailRow label="Display Name" value={selectedChannel.display_name} />
            <DetailRow label="Country" value={selectedChannel.country_code} />
            <DetailRow label="Type" value={selectedChannel.channel_type} />
            <DetailRow label="Provider" value={selectedChannel.provider} />
            <DetailRow label="Status" value={selectedChannel.connection_status} />

            <div className="my-3 border-t border-gray-100" />

            <DetailRow label="Created" value={fmtDateTime(selectedChannel.created_at)} />
            <DetailRow label="Updated" value={selectedChannel.updated_at ? fmtDateTime(selectedChannel.updated_at) : null} />

            {/* Render any extra fields from the row */}
            {(() => {
              const knownKeys = new Set(['id', 'phone_number', 'country_code', 'display_name', 'channel_type', 'connection_status', 'provider', 'is_active', 'created_at', 'updated_at']);
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
        onClose={() => setSelectedConfig(null)}
        title="Configuration Details"
        wide
      >
        {selectedConfig && (
          <div className="space-y-3 text-sm">
            <DetailRow label="Config ID" value={selectedConfig.id} />
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

            {/* The old Activate/Deactivate and webhook controls wrote whatsapp_config.status and
                .webhook_url, which do not exist, so they could never save (#1108 X2). */}
            <p className="rounded-lg border border-gray-200 bg-white p-4 text-sm text-gray-500">
              Status and webhook URL can't be changed here: bot settings don't store them. Manage the
              business's number on the Channels tab.
            </p>

            {/* Render any extra fields from the row */}
            {(() => {
              const knownKeys = new Set([
                'id', 'business_id', 'business_name', 'created_at', 'updated_at',
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
