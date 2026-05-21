import { useEffect, useState } from 'react';
import { supabase, adminDb } from '@/lib/supabase';
import { useAdminSession } from '@/components/AdminLayout';
import { logAudit } from '@/lib/auditLog';
import { fmtDateTime } from '@/lib/formatters';
import { Settings, Plus, Pencil, Trash2, Save, X } from 'lucide-react';

interface PlatformSetting {
  key: string;
  value: unknown;
  description: string | null;
  updated_by: string | null;
  updated_at: string | null;
  created_at: string;
}

interface GroupDef {
  label: string;
  keys: string[];
}

const GROUPS: GroupDef[] = [
  {
    label: 'Website Content',
    keys: ['hero_content', 'contact_emails', 'social_links', 'default_greetings'],
  },
  {
    label: 'Pricing & Fees',
    keys: ['pricing_tiers', 'conversation_limits', 'broadcast_limits', 'trial_days', 'platform_fee_percentage'],
  },
  {
    label: 'WhatsApp',
    keys: ['whatsapp_shared_numbers'],
  },
  {
    label: 'Directory',
    keys: ['directory_featured', 'directory_hidden'],
  },
  {
    label: 'Booking Defaults',
    keys: ['booking_defaults', 'max_bot_sessions_per_business'],
  },
  {
    label: 'Countries & Currencies',
    keys: ['supported_countries', 'supported_currencies'],
  },
  {
    label: 'App Versions',
    keys: ['min_app_version', 'terms_version', 'privacy_version'],
  },
  {
    label: 'System',
    keys: ['maintenance_mode', 'support_email'],
  },
];

function getGroupLabel(key: string): string {
  for (const g of GROUPS) {
    if (g.keys.includes(key)) return g.label;
  }
  return 'Other';
}

function formatValue(val: unknown): string {
  if (val === null || val === undefined) return '';
  if (typeof val === 'string') return val;
  return JSON.stringify(val, null, 2);
}

export default function PlatformSettings() {
  const session = useAdminSession();
  const isFullAdmin = session?.role === 'admin';
  const [settings, setSettings] = useState<PlatformSetting[]>([]);
  const [loading, setLoading] = useState(true);
  const [userId, setUserId] = useState<string | null>(null);

  if (!isFullAdmin) {
    return (
      <div className="flex min-h-[50vh] flex-col items-center justify-center text-center">
        <p className="text-lg font-semibold text-gray-900">Access Restricted</p>
        <p className="mt-1 text-sm text-gray-500">Only full admins can manage platform settings.</p>
      </div>
    );
  }

  // Edit state — track all changes inline
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [savingKey, setSavingKey] = useState<string | null>(null);

  // Add state
  const [showAdd, setShowAdd] = useState(false);
  const [newKey, setNewKey] = useState('');
  const [newValue, setNewValue] = useState('');
  const [newDescription, setNewDescription] = useState('');
  const [adding, setAdding] = useState(false);

  // Delete state
  const [deleting, setDeleting] = useState<string | null>(null);

  async function loadData() {
    setLoading(true);
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      setUserId(sessionData?.session?.user?.id ?? null);

      const { data } = await adminDb
        .from('platform_settings')
        .select('*')
        .order('key', { ascending: true });

      setSettings(data || []);
    } catch (error) {
      console.warn('Failed to load platform settings:', error);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { loadData(); }, []);

  // Group settings
  const grouped: Record<string, PlatformSetting[]> = {};
  const groupOrder = [...GROUPS.map(g => g.label), 'Other'];

  for (const s of settings) {
    const label = getGroupLabel(s.key);
    if (!grouped[label]) grouped[label] = [];
    grouped[label].push(s);
  }

  // Get current value for a setting (edited or original)
  function getCurrentValue(setting: PlatformSetting): string {
    if (edits[setting.key] !== undefined) return edits[setting.key];
    return formatValue(setting.value);
  }

  function hasChanges(key: string): boolean {
    return edits[key] !== undefined;
  }

  // Save a single setting
  async function handleSave(key: string) {
    setSavingKey(key);
    try {
      const raw = edits[key];
      if (raw === undefined) return;

      let parsedValue: unknown;
      try {
        parsedValue = JSON.parse(raw);
      } catch {
        parsedValue = raw;
      }

      const { error } = await adminDb
        .from('platform_settings')
        .update({
          value: parsedValue,
          updated_by: userId,
          updated_at: new Date().toISOString(),
        })
        .eq('key', key);

      if (error) throw error;

      await logAudit({
        action: 'update_platform_setting',
        entity_type: 'platform_setting',
        entity_id: key,
        details: { key, new_value: parsedValue },
      });

      // Clear edit and reload
      setEdits(prev => { const next = { ...prev }; delete next[key]; return next; });
      await loadData();
    } catch (error) {
      console.error('Save setting error:', error);
      alert('Failed to save setting');
    } finally {
      setSavingKey(null);
    }
  }

  // Add new setting
  async function handleAdd() {
    if (!newKey.trim()) {
      alert('Key is required');
      return;
    }

    setAdding(true);
    try {
      let parsedValue: unknown;
      try {
        parsedValue = JSON.parse(newValue);
      } catch {
        parsedValue = newValue;
      }

      const { error } = await adminDb
        .from('platform_settings')
        .insert({
          key: newKey.trim(),
          value: parsedValue,
          description: newDescription.trim() || null,
          updated_by: userId,
          updated_at: new Date().toISOString(),
        });

      if (error) throw error;

      await logAudit({
        action: 'create_platform_setting',
        entity_type: 'platform_setting',
        entity_id: newKey.trim(),
        details: {
          key: newKey.trim(),
          value: parsedValue,
          description: newDescription.trim() || null,
        },
      });

      setShowAdd(false);
      setNewKey('');
      setNewValue('');
      setNewDescription('');
      await loadData();
    } catch (error) {
      console.error('Add setting error:', error);
      alert('Failed to add setting');
    } finally {
      setAdding(false);
    }
  }

  // Delete setting
  async function handleDelete(key: string) {
    if (!confirm(`Are you sure you want to delete the setting "${key}"? This action cannot be undone.`)) return;

    setDeleting(key);
    try {
      const { error } = await adminDb
        .from('platform_settings')
        .delete()
        .eq('key', key);

      if (error) throw error;

      await logAudit({
        action: 'delete_platform_setting',
        entity_type: 'platform_setting',
        entity_id: key,
        details: { key },
      });

      await loadData();
    } catch (error) {
      console.error('Delete setting error:', error);
      alert('Failed to delete setting');
    } finally {
      setDeleting(null);
    }
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
          <h1 className="text-2xl font-bold text-gray-900">Platform Settings</h1>
          <p className="mt-1 text-sm text-gray-500">Manage database-backed platform configuration</p>
        </div>
        <button
          onClick={() => setShowAdd(true)}
          className="rounded-xl bg-brand px-4 py-2.5 text-sm font-bold text-white transition hover:bg-brand-600 disabled:opacity-50"
        >
          <span className="flex items-center gap-2">
            <Plus className="h-4 w-4" />
            Add Setting
          </span>
        </button>
      </div>

      {/* Add Setting Form */}
      {showAdd && (
        <div className="mt-6 rounded-xl border border-brand/30 bg-brand/5 p-6">
          <h3 className="text-sm font-semibold text-gray-900">New Setting</h3>
          <div className="mt-4 grid gap-4 sm:grid-cols-3">
            <div>
              <label className="block text-sm font-medium text-gray-700">Key</label>
              <input
                type="text"
                value={newKey}
                onChange={e => setNewKey(e.target.value)}
                placeholder="e.g. max_upload_size"
                className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 focus:border-brand focus:outline-none"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700">Value</label>
              <input
                type="text"
                value={newValue}
                onChange={e => setNewValue(e.target.value)}
                placeholder='e.g. 10 or {"key": "val"}'
                className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 focus:border-brand focus:outline-none"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700">Description</label>
              <input
                type="text"
                value={newDescription}
                onChange={e => setNewDescription(e.target.value)}
                placeholder="Human-readable description"
                className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 focus:border-brand focus:outline-none"
              />
            </div>
          </div>
          <div className="mt-4 flex gap-3">
            <button
              onClick={handleAdd}
              disabled={adding || !newKey.trim()}
              className="rounded-xl bg-brand px-4 py-2.5 text-sm font-bold text-white transition hover:bg-brand-600 disabled:opacity-50"
            >
              {adding ? 'Adding...' : 'Add Setting'}
            </button>
            <button
              onClick={() => { setShowAdd(false); setNewKey(''); setNewValue(''); setNewDescription(''); }}
              className="rounded-xl border border-gray-300 px-4 py-2.5 text-sm font-medium text-gray-700 transition hover:bg-gray-50"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Grouped Settings Cards */}
      <div className="mt-6 space-y-6">
        {groupOrder.map(groupLabel => {
          const items = grouped[groupLabel];
          if (!items || items.length === 0) return null;

          return (
            <div key={groupLabel} className="rounded-xl border border-gray-200 bg-white">
              <div className="flex items-center gap-2 border-b border-gray-100 bg-gray-50 px-5 py-3 rounded-t-xl">
                <Settings className="h-4 w-4 text-gray-400" />
                <h2 className="text-sm font-semibold text-gray-700">{groupLabel}</h2>
                <span className="ml-auto text-xs text-gray-400">{items.length} setting{items.length !== 1 ? 's' : ''}</span>
              </div>

              <div className="divide-y divide-gray-50">
                {items.map(setting => {
                  const val = getCurrentValue(setting);
                  const changed = hasChanges(setting.key);
                  const isSaving = savingKey === setting.key;
                  const lines = val.split('\n').length;
                  const isSimple = typeof setting.value !== 'object' || setting.value === null;

                  return (
                    <div key={setting.key} className="px-5 py-4">
                      <div className="flex items-baseline justify-between gap-3 mb-1.5">
                        <div>
                          <span className="text-sm font-semibold text-gray-900">
                            {setting.key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}
                          </span>
                          <span className="ml-2 font-mono text-xs text-gray-400">{setting.key}</span>
                        </div>
                        <div className="flex items-center gap-1.5">
                          {changed && (
                            <>
                              <button
                                onClick={() => handleSave(setting.key)}
                                disabled={isSaving}
                                className="rounded-lg bg-brand px-3 py-1 text-xs font-semibold text-white hover:bg-brand-600 disabled:opacity-50"
                              >
                                {isSaving ? 'Saving...' : 'Save'}
                              </button>
                              <button
                                onClick={() => setEdits(prev => { const next = { ...prev }; delete next[setting.key]; return next; })}
                                className="rounded-lg border border-gray-200 px-2 py-1 text-xs text-gray-500 hover:bg-gray-50"
                              >
                                Undo
                              </button>
                            </>
                          )}
                          <button
                            onClick={() => handleDelete(setting.key)}
                            disabled={deleting === setting.key}
                            className="rounded-lg p-1.5 text-gray-300 transition hover:bg-red-50 hover:text-red-500"
                            title="Delete"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </div>
                      {setting.description && (
                        <p className="mb-2 text-xs text-gray-500">{setting.description}</p>
                      )}
                      {isSimple ? (
                        <input
                          type="text"
                          value={val}
                          onChange={e => setEdits(prev => ({ ...prev, [setting.key]: e.target.value }))}
                          className={`w-full rounded-lg border px-3 py-2 text-sm outline-none transition ${changed ? 'border-brand bg-brand/5' : 'border-gray-200 bg-gray-50'} focus:border-brand`}
                        />
                      ) : (
                        <textarea
                          value={val}
                          onChange={e => setEdits(prev => ({ ...prev, [setting.key]: e.target.value }))}
                          rows={Math.min(Math.max(3, lines), 12)}
                          className={`w-full rounded-lg border px-3 py-2 font-mono text-xs outline-none transition ${changed ? 'border-brand bg-brand/5' : 'border-gray-200 bg-gray-50'} focus:border-brand`}
                        />
                      )}
                      {setting.updated_at && (
                        <p className="mt-1 text-xs text-gray-400">Updated {fmtDateTime(setting.updated_at)}</p>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}

        {settings.length === 0 && (
          <div className="rounded-xl border border-gray-200 bg-white py-16 text-center text-sm text-gray-500">
            No platform settings found. Click "Add Setting" to create one.
          </div>
        )}
      </div>
    </div>
  );
}

/** Smart value display — renders based on type */
function SettingValueDisplay({ value }: { value: unknown }) {
  if (value === null || value === undefined) {
    return <span className="text-sm italic text-gray-400">null</span>;
  }

  if (typeof value === 'boolean') {
    return (
      <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${value ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
        {value ? 'Enabled' : 'Disabled'}
      </span>
    );
  }

  if (typeof value === 'number') {
    return <span className="text-sm font-semibold text-gray-900">{value.toLocaleString()}</span>;
  }

  if (typeof value === 'string') {
    if (value.includes('@') || value.startsWith('http')) {
      return <span className="text-sm text-brand">{value}</span>;
    }
    return <span className="text-sm text-gray-700">{value}</span>;
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="text-xs italic text-gray-400">Empty list</span>;
    // Simple array of strings/numbers
    if (value.every(v => typeof v === 'string' || typeof v === 'number')) {
      return (
        <div className="flex flex-wrap gap-1.5">
          {value.map((v, i) => (
            <span key={i} className="rounded-md bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-700">{String(v)}</span>
          ))}
        </div>
      );
    }
    // Array of objects — show as mini table
    return (
      <div className="space-y-1">
        {value.map((item, i) => (
          <div key={i} className="rounded-lg bg-gray-50 px-3 py-1.5 text-xs">
            {typeof item === 'object' && item !== null
              ? Object.entries(item as Record<string, unknown>).map(([k, v]) => (
                  <span key={k} className="mr-3">
                    <span className="text-gray-500">{k}:</span>{' '}
                    <span className="font-medium text-gray-800">{typeof v === 'object' ? JSON.stringify(v) : String(v)}</span>
                  </span>
                ))
              : String(item)
            }
          </div>
        ))}
      </div>
    );
  }

  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return <span className="text-xs italic text-gray-400">Empty object</span>;

    // Check if values are simple (flat key-value)
    const isFlat = entries.every(([, v]) => typeof v !== 'object' || v === null);
    if (isFlat) {
      return (
        <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
          {entries.map(([k, v]) => (
            <div key={k} className="contents">
              <span className="text-xs font-medium text-gray-500">{k}</span>
              <span className="text-xs text-gray-800">{v === null ? '—' : String(v)}</span>
            </div>
          ))}
        </div>
      );
    }

    // Nested object — show each key as a sub-section
    return (
      <div className="space-y-2">
        {entries.map(([k, v]) => (
          <div key={k} className="rounded-lg border border-gray-100 bg-gray-50 px-3 py-2">
            <span className="text-xs font-semibold text-gray-600">{k}</span>
            <div className="mt-1">
              {typeof v === 'object' && v !== null ? (
                <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
                  {Object.entries(v as Record<string, unknown>).map(([sk, sv]) => (
                    <div key={sk} className="contents">
                      <span className="text-xs text-gray-400">{sk}</span>
                      <span className="text-xs text-gray-700">{sv === null ? '—' : typeof sv === 'object' ? JSON.stringify(sv) : String(sv)}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <span className="text-xs text-gray-700">{String(v)}</span>
              )}
            </div>
          </div>
        ))}
      </div>
    );
  }

  // Fallback
  return <pre className="whitespace-pre-wrap text-xs text-gray-600">{JSON.stringify(value, null, 2)}</pre>;
}
