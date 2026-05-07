'use client';

import { useEffect, useState, useCallback } from 'react';
import { useBusiness } from '@/components/dashboard/DashboardProvider';
import { createClient } from '@/lib/supabase/client';

// ── Types ──
interface BotKeyword {
  id: string;
  keyword: string;
  match_type: 'exact' | 'contains' | 'starts_with';
  action_type: 'reply' | 'start_flow' | 'start_capability' | 'url';
  payload: string;
  is_active: boolean;
  priority: number;
  business_id: string;
}

const MATCH_TYPE_OPTIONS: { value: BotKeyword['match_type']; label: string }[] = [
  { value: 'exact', label: 'Exact Match' },
  { value: 'contains', label: 'Contains' },
  { value: 'starts_with', label: 'Starts With' },
];

const ACTION_TYPE_OPTIONS: { value: BotKeyword['action_type']; label: string; placeholder: string }[] = [
  { value: 'reply', label: 'Reply', placeholder: 'The reply text to send back...' },
  { value: 'start_flow', label: 'Start Flow', placeholder: 'Flow name, e.g. booking_flow' },
  { value: 'start_capability', label: 'Start Capability', placeholder: 'Capability ID, e.g. faq' },
  { value: 'url', label: 'URL', placeholder: 'https://example.com/page' },
];

const EMPTY_FORM = {
  id: '',
  keyword: '',
  match_type: 'contains' as BotKeyword['match_type'],
  action_type: 'reply' as BotKeyword['action_type'],
  payload: '',
  is_active: true,
  priority: 0,
};

type ViewMode = 'list' | 'add' | 'edit';

interface SystemKeyword {
  id: string;
  keyword: string;
  match_type: string;
  action_type: string;
  description: string | null;
}

export default function KeywordsPage() {
  const business = useBusiness();
  const [keywords, setKeywords] = useState<BotKeyword[]>([]);
  const [systemKeywords, setSystemKeywords] = useState<SystemKeyword[]>([]);
  const [showSystemDefaults, setShowSystemDefaults] = useState(false);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<ViewMode>('list');
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [conflictWarning, setConflictWarning] = useState<string | null>(null);

  const supabase = createClient();

  const fetchKeywords = useCallback(async () => {
    try {
      const [bizRes, sysRes] = await Promise.all([
        supabase
          .from('bot_keywords')
          .select('*')
          .eq('business_id', business.id)
          .order('priority', { ascending: false }),
        supabase
          .from('bot_keywords')
          .select('id, keyword, match_type, action_type, description')
          .eq('scope', 'system')
          .eq('is_active', true)
          .order('priority', { ascending: false }),
      ]);

      if (bizRes.error) throw bizRes.error;
      setKeywords((bizRes.data || []) as BotKeyword[]);
      setSystemKeywords((sysRes.data || []) as SystemKeyword[]);
    } catch {
      setKeywords([]);
    } finally {
      setLoading(false);
    }
  }, [business.id]);

  useEffect(() => {
    fetchKeywords();
  }, [fetchKeywords]);

  // Check for conflicts when keyword text changes
  function checkConflict(keyword: string) {
    if (!keyword.trim()) {
      setConflictWarning(null);
      return;
    }
    const lower = keyword.toLowerCase().trim();
    // Use the same match_type logic as the actual bot keyword matching engine
    const match = systemKeywords.find(sk => {
      const skLower = sk.keyword.toLowerCase();
      switch (sk.match_type) {
        case 'exact': return lower === skLower;
        case 'starts_with': return lower.startsWith(skLower) || skLower.startsWith(lower);
        case 'contains': return lower.includes(skLower) || skLower.includes(lower);
        default: return lower === skLower;
      }
    });
    if (match) {
      setConflictWarning(`This may override the system keyword: "${match.keyword}" (${match.match_type} match — ${match.description || match.action_type})`);
    } else {
      setConflictWarning(null);
    }
  }

  function openAdd() {
    setForm({ ...EMPTY_FORM });
    setFormError(null);
    setView('add');
  }

  function openEdit(kw: BotKeyword) {
    setForm({
      id: kw.id,
      keyword: kw.keyword,
      match_type: kw.match_type,
      action_type: kw.action_type,
      payload: kw.payload,
      is_active: kw.is_active,
      priority: kw.priority,
    });
    setFormError(null);
    setView('edit');
  }

  async function handleSave() {
    if (!form.keyword.trim()) {
      setFormError('Keyword is required.');
      return;
    }
    if (!form.payload.trim()) {
      setFormError('Payload is required.');
      return;
    }

    setSaving(true);
    setFormError(null);

    try {
      if (view === 'edit' && form.id) {
        const { error } = await supabase
          .from('bot_keywords')
          .update({
            keyword: form.keyword.trim(),
            match_type: form.match_type,
            action_type: form.action_type,
            payload: form.payload.trim(),
            is_active: form.is_active,
            priority: form.priority,
          })
          .eq('id', form.id)
          .eq('business_id', business.id);

        if (error) throw error;
      } else {
        const { error } = await supabase
          .from('bot_keywords')
          .insert({
            keyword: form.keyword.trim(),
            match_type: form.match_type,
            action_type: form.action_type,
            payload: form.payload.trim(),
            is_active: form.is_active,
            priority: form.priority,
            business_id: business.id,
          });

        if (error) throw error;
      }

      setView('list');
      fetchKeywords();
    } catch {
      setFormError('Something went wrong. Please try again.');
    } finally {
      setSaving(false);
    }
  }

  async function handleToggle(kw: BotKeyword) {
    await supabase
      .from('bot_keywords')
      .update({ is_active: !kw.is_active })
      .eq('id', kw.id)
      .eq('business_id', business.id);

    fetchKeywords();
  }

  async function handleDelete(id: string) {
    if (!confirm('Delete this keyword? This action cannot be undone.')) return;

    await supabase
      .from('bot_keywords')
      .delete()
      .eq('id', id)
      .eq('business_id', business.id);

    if (view !== 'list') setView('list');
    fetchKeywords();
  }

  function matchTypeLabel(type: BotKeyword['match_type']) {
    return MATCH_TYPE_OPTIONS.find((o) => o.value === type)?.label || type;
  }

  function actionTypeLabel(type: BotKeyword['action_type']) {
    return ACTION_TYPE_OPTIONS.find((o) => o.value === type)?.label || type;
  }

  function actionPayloadPlaceholder(type: BotKeyword['action_type']) {
    return ACTION_TYPE_OPTIONS.find((o) => o.value === type)?.placeholder || '';
  }

  function matchTypeBadgeColor(type: BotKeyword['match_type']) {
    switch (type) {
      case 'exact': return 'bg-purple-50 text-purple-700';
      case 'contains': return 'bg-blue-50 text-blue-700';
      case 'starts_with': return 'bg-amber-50 text-amber-700';
      default: return 'bg-gray-100 text-gray-600';
    }
  }

  function actionTypeBadgeColor(type: BotKeyword['action_type']) {
    switch (type) {
      case 'reply': return 'bg-green-50 text-green-700';
      case 'start_flow': return 'bg-indigo-50 text-indigo-700';
      case 'start_capability': return 'bg-cyan-50 text-cyan-700';
      case 'url': return 'bg-orange-50 text-orange-700';
      default: return 'bg-gray-100 text-gray-600';
    }
  }

  const activeCount = keywords.filter((k) => k.is_active).length;

  if (loading) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-brand border-t-transparent" />
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
            className="rounded-lg p-2 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
          >
            <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
          </button>
          <h1 className="text-xl font-bold text-gray-900">
            {view === 'add' ? 'Add Keyword' : 'Edit Keyword'}
          </h1>
        </div>

        {formError && (
          <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {formError}
          </div>
        )}

        <div className="mt-5 grid gap-6 lg:grid-cols-[1fr_280px]">
          {/* Left column: Main fields */}
          <div className="space-y-4">
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">
                Keyword <span className="text-red-400">*</span>
              </label>
              <input
                type="text"
                value={form.keyword}
                onChange={(e) => { setForm({ ...form, keyword: e.target.value }); checkConflict(e.target.value); }}
                placeholder="e.g. hello, pricing, book"
                className="w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm outline-none focus:border-brand"
                autoFocus
              />
              <p className="mt-1 text-xs text-gray-400">
                The word or phrase to match in incoming messages.
              </p>
              {conflictWarning && (
                <div className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
                  {conflictWarning}
                </div>
              )}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">Match Type</label>
                <select
                  value={form.match_type}
                  onChange={(e) => setForm({ ...form, match_type: e.target.value as BotKeyword['match_type'] })}
                  className="w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm outline-none focus:border-brand"
                >
                  {MATCH_TYPE_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">Action Type</label>
                <select
                  value={form.action_type}
                  onChange={(e) => setForm({ ...form, action_type: e.target.value as BotKeyword['action_type'] })}
                  className="w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm outline-none focus:border-brand"
                >
                  {ACTION_TYPE_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
              </div>
            </div>

            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">
                Payload <span className="text-red-400">*</span>
              </label>
              <textarea
                value={form.payload}
                onChange={(e) => setForm({ ...form, payload: e.target.value })}
                rows={4}
                placeholder={actionPayloadPlaceholder(form.action_type)}
                className="w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm outline-none focus:border-brand"
              />
              <p className="mt-1 text-xs text-gray-400">
                {form.action_type === 'reply' && 'The reply text that will be sent to the customer.'}
                {form.action_type === 'start_flow' && 'The name of the flow to start.'}
                {form.action_type === 'start_capability' && 'The ID of the capability to trigger.'}
                {form.action_type === 'url' && 'The URL to send to the customer.'}
              </p>
            </div>
          </div>

          {/* Right column: Settings */}
          <div className="space-y-3">
            <p className="text-xs font-medium uppercase tracking-wide text-gray-400">Settings</p>

            <div className="flex items-center justify-between rounded-lg border border-gray-100 bg-white p-3">
              <div className="mr-3">
                <p className="text-sm font-medium text-gray-800">Active</p>
                <p className="text-xs text-gray-400">Respond when keyword is detected</p>
              </div>
              <button
                type="button"
                onClick={() => setForm({ ...form, is_active: !form.is_active })}
                className={`relative h-6 w-11 shrink-0 rounded-full transition ${form.is_active ? 'bg-brand' : 'bg-gray-200'}`}
              >
                <div
                  className="absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition"
                  style={{ left: form.is_active ? '22px' : '2px' }}
                />
              </button>
            </div>

            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">Priority</label>
              <input
                type="number"
                min={0}
                value={form.priority}
                onChange={(e) => setForm({ ...form, priority: parseInt(e.target.value) || 0 })}
                className="w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm outline-none focus:border-brand"
              />
              <p className="mt-1 text-xs text-gray-400">
                Higher priority keywords are matched first when multiple keywords match.
              </p>
            </div>

            {view === 'edit' && (
              <div className="rounded-lg border border-gray-100 bg-gray-50 p-4">
                <p className="text-xs font-medium uppercase tracking-wide text-gray-400">Preview</p>
                <p className="mt-2 text-sm text-gray-700">
                  When a message <span className="font-medium text-gray-900">{matchTypeLabel(form.match_type).toLowerCase()}</span>{' '}
                  &ldquo;<span className="font-semibold text-brand">{form.keyword || '...'}</span>&rdquo;,{' '}
                  {form.action_type === 'reply' ? 'reply with the payload text' :
                    form.action_type === 'start_flow' ? 'start the specified flow' :
                    form.action_type === 'start_capability' ? 'trigger the capability' :
                    'send the URL'}.
                </p>
              </div>
            )}
          </div>
        </div>

        {/* Save / Cancel / Delete footer */}
        <div className="mt-6 flex gap-3 border-t border-gray-100 pt-4">
          <button
            onClick={handleSave}
            disabled={saving || !form.keyword.trim() || !form.payload.trim()}
            className="rounded-lg bg-brand px-6 py-2.5 text-sm font-semibold text-white hover:bg-brand-600 disabled:opacity-50"
          >
            {saving ? 'Saving...' : view === 'add' ? 'Add Keyword' : 'Save Changes'}
          </button>
          <button
            onClick={() => setView('list')}
            className="rounded-lg border border-gray-200 px-4 py-2.5 text-sm font-medium text-gray-600 hover:bg-gray-50"
          >
            Cancel
          </button>
          {view === 'edit' && form.id && (
            <button
              onClick={() => handleDelete(form.id)}
              className="ml-auto rounded-lg px-4 py-2.5 text-sm font-medium text-red-500 hover:bg-red-50"
            >
              Delete Keyword
            </button>
          )}
        </div>
      </div>
    );
  }

  // ═══════════════════════════════════════════
  // KEYWORD LIST
  // ═══════════════════════════════════════════
  return (
    <div>
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div className="pr-4">
          <h1 className="text-2xl font-bold text-gray-900">Bot Keywords</h1>
          <p className="mt-1 text-sm text-gray-500">
            Configure keyword triggers for your WhatsApp bot to auto-respond, start flows, or redirect users.
          </p>
        </div>
        <button
          onClick={openAdd}
          className="shrink-0 rounded-lg bg-brand px-5 py-2.5 text-sm font-semibold text-white hover:bg-brand-600"
        >
          + Add Keyword
        </button>
      </div>

      {/* Metrics */}
      <div className="mt-6 grid grid-cols-3 gap-4">
        <div className="rounded-xl border border-gray-100 bg-white p-5">
          <p className="text-xs font-medium text-gray-500">Total Keywords</p>
          <p className="mt-2 text-2xl font-bold text-gray-900">{keywords.length}</p>
        </div>
        <div className="rounded-xl border border-gray-100 bg-white p-5">
          <p className="text-xs font-medium text-gray-500">Active</p>
          <p className="mt-2 text-2xl font-bold text-green-600">{activeCount}</p>
        </div>
        <div className="rounded-xl border border-gray-100 bg-white p-5">
          <p className="text-xs font-medium text-gray-500">Inactive</p>
          <p className="mt-2 text-2xl font-bold text-gray-400">{keywords.length - activeCount}</p>
        </div>
      </div>

      {/* System Defaults Panel (collapsible) */}
      {systemKeywords.length > 0 && (
        <div className="mt-6">
          <button
            onClick={() => setShowSystemDefaults(!showSystemDefaults)}
            className="flex w-full items-center justify-between rounded-xl border border-gray-100 bg-white px-5 py-3 text-left transition hover:bg-gray-50"
          >
            <div>
              <p className="text-sm font-medium text-gray-900">System Defaults</p>
              <p className="text-xs text-gray-400">{systemKeywords.length} system keywords active. Your keywords override these when matching.</p>
            </div>
            <svg className={`h-4 w-4 shrink-0 text-gray-400 transition ${showSystemDefaults ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </button>
          {showSystemDefaults && (
            <div className="mt-2 rounded-xl border border-gray-100 bg-gray-50 p-4">
              <div className="space-y-2">
                {systemKeywords.map((sk) => (
                  <div key={sk.id} className="flex items-center gap-3 text-xs">
                    <code className="rounded bg-white px-2 py-1 font-mono text-gray-700 border border-gray-200 max-w-[200px] truncate">{sk.keyword}</code>
                    <span className="rounded-full bg-blue-50 px-2 py-0.5 text-blue-600 font-medium">{sk.match_type}</span>
                    <span className="rounded-full bg-green-50 px-2 py-0.5 text-green-600 font-medium">{sk.action_type.replace(/_/g, ' ')}</span>
                    {sk.description && <span className="text-gray-400 truncate">{sk.description}</span>}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Keyword List */}
      {keywords.length === 0 ? (
        <div className="mt-8 rounded-xl border border-dashed border-gray-200 p-12 text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-brand-50">
            <svg className="h-6 w-6 text-brand" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 20l4-16m2 16l4-16M6 9h14M4 15h14" />
            </svg>
          </div>
          <p className="text-sm text-gray-500">
            No keywords configured yet. Add your first keyword to start automating responses.
          </p>
          <button
            onClick={openAdd}
            className="mt-4 rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white hover:bg-brand-600"
          >
            + Add Keyword
          </button>
        </div>
      ) : (
        <>
          {/* Desktop table */}
          <div className="mt-6 hidden overflow-hidden rounded-xl border border-gray-100 bg-white md:block">
            <table className="w-full">
              <thead>
                <tr className="border-b border-gray-100 bg-gray-50/50">
                  <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-gray-500">Keyword</th>
                  <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-gray-500">Match</th>
                  <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-gray-500">Action</th>
                  <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-gray-500">Payload</th>
                  <th className="px-4 py-3 text-center text-xs font-medium uppercase tracking-wide text-gray-500">Priority</th>
                  <th className="px-4 py-3 text-center text-xs font-medium uppercase tracking-wide text-gray-500">Active</th>
                  <th className="px-4 py-3 text-right text-xs font-medium uppercase tracking-wide text-gray-500">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {keywords.map((kw) => (
                  <tr
                    key={kw.id}
                    className={`transition hover:bg-gray-50 ${!kw.is_active ? 'opacity-60' : ''}`}
                  >
                    <td className="px-4 py-3">
                      <span className="text-sm font-semibold text-gray-900">{kw.keyword}</span>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${matchTypeBadgeColor(kw.match_type)}`}>
                        {matchTypeLabel(kw.match_type)}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${actionTypeBadgeColor(kw.action_type)}`}>
                        {actionTypeLabel(kw.action_type)}
                      </span>
                    </td>
                    <td className="max-w-[200px] px-4 py-3">
                      <p className="truncate text-sm text-gray-600">{kw.payload}</p>
                    </td>
                    <td className="px-4 py-3 text-center">
                      <span className="text-sm text-gray-600">{kw.priority}</span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex justify-center">
                        <button
                          onClick={() => handleToggle(kw)}
                          className={`relative h-6 w-11 rounded-full transition ${kw.is_active ? 'bg-brand' : 'bg-gray-200'}`}
                        >
                          <div
                            className="absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition"
                            style={{ left: kw.is_active ? '22px' : '2px' }}
                          />
                        </button>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-1">
                        <button
                          onClick={() => openEdit(kw)}
                          className="rounded-lg p-2 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
                          title="Edit"
                        >
                          <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                          </svg>
                        </button>
                        <button
                          onClick={() => handleDelete(kw.id)}
                          className="rounded-lg p-2 text-gray-400 hover:bg-red-50 hover:text-red-500"
                          title="Delete"
                        >
                          <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                          </svg>
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Mobile card layout */}
          <div className="mt-6 space-y-3 md:hidden">
            {keywords.map((kw) => (
              <div
                key={kw.id}
                onClick={() => openEdit(kw)}
                className={`cursor-pointer rounded-xl border bg-white p-4 transition hover:shadow-sm ${
                  kw.is_active ? 'border-gray-100 hover:border-gray-200' : 'border-gray-100 opacity-60'
                }`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <h3 className="text-sm font-bold text-gray-900">{kw.keyword}</h3>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${matchTypeBadgeColor(kw.match_type)}`}>
                        {matchTypeLabel(kw.match_type)}
                      </span>
                      <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${actionTypeBadgeColor(kw.action_type)}`}>
                        {actionTypeLabel(kw.action_type)}
                      </span>
                      {kw.priority > 0 && (
                        <span className="inline-flex rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-600">
                          Priority {kw.priority}
                        </span>
                      )}
                    </div>
                    <p className="mt-2 line-clamp-2 text-xs text-gray-500">{kw.payload}</p>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-2">
                    <button
                      onClick={(e) => { e.stopPropagation(); handleToggle(kw); }}
                      className={`relative h-6 w-11 rounded-full transition ${kw.is_active ? 'bg-brand' : 'bg-gray-200'}`}
                    >
                      <div
                        className="absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition"
                        style={{ left: kw.is_active ? '22px' : '2px' }}
                      />
                    </button>
                    <button
                      onClick={(e) => { e.stopPropagation(); handleDelete(kw.id); }}
                      className="rounded-lg p-1.5 text-gray-400 hover:bg-red-50 hover:text-red-500"
                    >
                      <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                      </svg>
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
