import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
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
  const [settings, setSettings] = useState<PlatformSetting[]>([]);
  const [loading, setLoading] = useState(true);
  const [userId, setUserId] = useState<string | null>(null);

  // Edit state
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [saving, setSaving] = useState(false);

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

      const { data } = await supabase
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

  // Start editing
  function handleEdit(setting: PlatformSetting) {
    setEditingKey(setting.key);
    setEditValue(formatValue(setting.value));
  }

  // Cancel editing
  function handleCancelEdit() {
    setEditingKey(null);
    setEditValue('');
  }

  // Save edit
  async function handleSave(key: string) {
    setSaving(true);
    try {
      // Parse the value — try JSON first, fall back to string
      let parsedValue: unknown;
      try {
        parsedValue = JSON.parse(editValue);
      } catch {
        parsedValue = editValue;
      }

      const { error } = await supabase
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
        details: {
          key,
          new_value: parsedValue,
        },
      });

      setEditingKey(null);
      setEditValue('');
      await loadData();
    } catch (error) {
      console.error('Save setting error:', error);
      alert('Failed to save setting');
    } finally {
      setSaving(false);
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

      const { error } = await supabase
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
      const { error } = await supabase
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
                {items.map(setting => (
                  <div key={setting.key} className="px-5 py-4">
                    {editingKey === setting.key ? (
                      /* Editing mode */
                      <div>
                        <div className="flex items-center justify-between">
                          <div>
                            <span className="font-mono text-sm font-medium text-gray-900">{setting.key}</span>
                            {setting.description && (
                              <p className="mt-0.5 text-xs text-gray-500">{setting.description}</p>
                            )}
                          </div>
                        </div>
                        <textarea
                          value={editValue}
                          onChange={e => setEditValue(e.target.value)}
                          rows={Math.max(2, editValue.split('\n').length)}
                          className="mt-3 w-full rounded-lg border border-gray-300 px-3 py-2 font-mono text-sm text-gray-700 focus:border-brand focus:outline-none"
                        />
                        <div className="mt-2 flex gap-2">
                          <button
                            onClick={() => handleSave(setting.key)}
                            disabled={saving}
                            className="rounded-xl bg-brand px-4 py-2.5 text-sm font-bold text-white transition hover:bg-brand-600 disabled:opacity-50"
                          >
                            <span className="flex items-center gap-1.5">
                              <Save className="h-3.5 w-3.5" />
                              {saving ? 'Saving...' : 'Save'}
                            </span>
                          </button>
                          <button
                            onClick={handleCancelEdit}
                            className="rounded-xl border border-gray-300 px-4 py-2.5 text-sm font-medium text-gray-700 transition hover:bg-gray-50"
                          >
                            <span className="flex items-center gap-1.5">
                              <X className="h-3.5 w-3.5" />
                              Cancel
                            </span>
                          </button>
                        </div>
                      </div>
                    ) : (
                      /* Display mode */
                      <div className="flex items-start justify-between gap-4">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-3">
                            <span className="font-mono text-sm font-medium text-gray-900">{setting.key}</span>
                            {setting.description && (
                              <span className="text-xs text-gray-400">-- {setting.description}</span>
                            )}
                          </div>
                          <pre className="mt-1.5 whitespace-pre-wrap break-words rounded-lg bg-gray-50 px-3 py-2 font-mono text-sm text-gray-700">
                            {formatValue(setting.value)}
                          </pre>
                          {setting.updated_at && (
                            <p className="mt-1 text-xs text-gray-400">
                              Last updated {fmtDateTime(setting.updated_at)}
                            </p>
                          )}
                        </div>
                        <div className="flex shrink-0 items-center gap-1.5 pt-0.5">
                          <button
                            onClick={() => handleEdit(setting)}
                            className="rounded-lg p-2 text-gray-400 transition hover:bg-gray-100 hover:text-gray-600"
                            title="Edit"
                          >
                            <Pencil className="h-4 w-4" />
                          </button>
                          <button
                            onClick={() => handleDelete(setting.key)}
                            disabled={deleting === setting.key}
                            className="rounded-lg p-2 text-gray-400 transition hover:bg-red-50 hover:text-red-500 disabled:opacity-50"
                            title="Delete"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                ))}
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
