import { useEffect, useRef, useState } from 'react';
import { supabase, adminDb } from '@/lib/supabase';
import { logAudit } from '@/lib/auditLog';
import { Pagination } from '@/components/Pagination';
import { StatusBadge } from '@/components/StatusBadge';
import { DetailModal } from '@/components/DetailModal';
import { SummaryCard } from '@/components/SummaryCard';
import { fmtDate } from '@/lib/formatters';
import {
  Hash,
  Plus,
  Pencil,
  Trash2,
  ToggleLeft,
  ToggleRight,
  Search,
  Globe,
  Layers,
  Building2,
} from 'lucide-react';

interface BotKeywordRow {
  id: string;
  keyword: string;
  match_type: string;
  action_type: string;
  payload: string;
  is_active: boolean;
  priority: number;
  scope: 'system' | 'category' | 'business';
  category: string | null;
  description: string | null;
  business_id: string | null;
  created_at: string;
}

const SCOPES = ['system', 'category', 'business'] as const;
const MATCH_TYPES = ['exact', 'contains', 'starts_with', 'regex'] as const;
const ACTION_TYPES = ['reply', 'start_flow', 'start_capability', 'url', 'navigate_step', 'acknowledge', 'show_menu'] as const;

const SCOPE_COLORS: Record<string, string> = {
  system: 'bg-blue-100 text-blue-700',
  category: 'bg-purple-100 text-purple-700',
  business: 'bg-green-100 text-green-700',
};

const ACTION_COLORS: Record<string, string> = {
  reply: 'bg-green-50 text-green-700',
  start_flow: 'bg-indigo-50 text-indigo-700',
  start_capability: 'bg-cyan-50 text-cyan-700',
  url: 'bg-orange-50 text-orange-700',
  navigate_step: 'bg-yellow-50 text-yellow-700',
  acknowledge: 'bg-pink-50 text-pink-700',
  show_menu: 'bg-violet-50 text-violet-700',
};

const MATCH_COLORS: Record<string, string> = {
  exact: 'bg-purple-50 text-purple-700',
  contains: 'bg-blue-50 text-blue-700',
  starts_with: 'bg-amber-50 text-amber-700',
  regex: 'bg-rose-50 text-rose-700',
};

export default function BotKeywords() {
  const [keywords, setKeywords] = useState<BotKeywordRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [scopeFilter, setScopeFilter] = useState('all');
  const [categoryFilter, setCategoryFilter] = useState('all');
  const perPage = 20;

  // Modal state
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<BotKeywordRow | null>(null);
  const [saving, setSaving] = useState(false);

  // Form state
  const [formKeyword, setFormKeyword] = useState('');
  const [formMatchType, setFormMatchType] = useState<string>('contains');
  const [formScope, setFormScope] = useState<string>('system');
  const [formCategory, setFormCategory] = useState('');
  const [formActionType, setFormActionType] = useState<string>('reply');
  const [formPayload, setFormPayload] = useState('');
  const [formDescription, setFormDescription] = useState('');
  const [formActive, setFormActive] = useState(true);
  const [formPriority, setFormPriority] = useState(50);

  const loadingRef = useRef(false);

  async function loadData() {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    try {
      const { data } = await adminDb
        .from('bot_keywords')
        .select('*')
        .order('scope', { ascending: true })
        .order('priority', { ascending: false });
      setKeywords((data as BotKeywordRow[]) || []);
    } catch (error) {
      console.warn('Failed to load bot keywords:', error);
    } finally {
      setLoading(false);
      loadingRef.current = false;
    }
  }

  useEffect(() => { loadData(); }, []);

  // Get unique categories from data
  const categories = [...new Set(keywords.filter(k => k.category).map(k => k.category!))].sort();

  // Filters
  const filtered = keywords.filter(k => {
    if (search) {
      const q = search.toLowerCase();
      if (!k.keyword.toLowerCase().includes(q) && !(k.description || '').toLowerCase().includes(q)) return false;
    }
    if (scopeFilter !== 'all' && k.scope !== scopeFilter) return false;
    if (categoryFilter !== 'all' && k.category !== categoryFilter) return false;
    return true;
  });

  const totalPages = Math.max(1, Math.ceil(filtered.length / perPage));
  const pageItems = filtered.slice((page - 1) * perPage, page * perPage);

  // Stats
  const totalCount = keywords.length;
  const systemCount = keywords.filter(k => k.scope === 'system' && k.is_active).length;
  const categoryCount = keywords.filter(k => k.scope === 'category' && k.is_active).length;
  const businessCount = keywords.filter(k => k.scope === 'business' && k.is_active).length;

  function handleCreate() {
    setEditing(null);
    setFormKeyword('');
    setFormMatchType('contains');
    setFormScope('system');
    setFormCategory('');
    setFormActionType('reply');
    setFormPayload('');
    setFormDescription('');
    setFormActive(true);
    setFormPriority(50);
    setModalOpen(true);
  }

  function handleEdit(kw: BotKeywordRow) {
    setEditing(kw);
    setFormKeyword(kw.keyword);
    setFormMatchType(kw.match_type);
    setFormScope(kw.scope);
    setFormCategory(kw.category || '');
    setFormActionType(kw.action_type);
    setFormPayload(kw.payload);
    setFormDescription(kw.description || '');
    setFormActive(kw.is_active);
    setFormPriority(kw.priority);
    setModalOpen(true);
  }

  async function handleSave() {
    if (!formKeyword.trim()) {
      alert('Keyword is required');
      return;
    }
    if (!formPayload.trim()) {
      alert('Payload is required');
      return;
    }
    if (formScope === 'category' && !formCategory.trim()) {
      alert('Category is required for category-scoped keywords');
      return;
    }

    setSaving(true);
    try {
      const payload = {
        keyword: formKeyword.trim(),
        match_type: formMatchType,
        scope: formScope,
        category: formScope === 'category' ? formCategory.trim() : null,
        action_type: formActionType,
        payload: formPayload.trim(),
        description: formDescription.trim() || null,
        is_active: formActive,
        priority: formPriority,
        business_id: null, // system/category keywords have no business
      };

      if (editing) {
        const { error } = await adminDb
          .from('bot_keywords')
          .update(payload)
          .eq('id', editing.id);
        if (error) throw error;

        await logAudit({
          action: 'update_bot_keyword',
          entity_type: 'bot_keyword',
          entity_id: editing.id,
          details: { keyword: payload.keyword, scope: payload.scope },
        });
      } else {
        const { data, error } = await adminDb
          .from('bot_keywords')
          .insert(payload)
          .select('id')
          .single();
        if (error) throw error;

        await logAudit({
          action: 'create_bot_keyword',
          entity_type: 'bot_keyword',
          entity_id: data.id,
          details: { keyword: payload.keyword, scope: payload.scope },
        });
      }

      setModalOpen(false);
      await loadData();
    } catch (error) {
      console.error('Save bot keyword error:', error);
      alert('Failed to save keyword');
    } finally {
      setSaving(false);
    }
  }

  async function handleToggle(kw: BotKeywordRow) {
    try {
      const { error } = await adminDb
        .from('bot_keywords')
        .update({ is_active: !kw.is_active })
        .eq('id', kw.id);
      if (error) throw error;

      await logAudit({
        action: kw.is_active ? 'deactivate_bot_keyword' : 'activate_bot_keyword',
        entity_type: 'bot_keyword',
        entity_id: kw.id,
        details: { keyword: kw.keyword, is_active: !kw.is_active },
      });
      await loadData();
    } catch (error) {
      console.error('Toggle keyword error:', error);
    }
  }

  async function handleDelete(kw: BotKeywordRow) {
    if (!confirm(`Delete keyword "${kw.keyword}"? This cannot be undone.`)) return;
    try {
      const { error } = await adminDb
        .from('bot_keywords')
        .delete()
        .eq('id', kw.id);
      if (error) throw error;

      await logAudit({
        action: 'delete_bot_keyword',
        entity_type: 'bot_keyword',
        entity_id: kw.id,
        details: { keyword: kw.keyword, scope: kw.scope },
      });
      await loadData();
    } catch (error) {
      console.error('Delete keyword error:', error);
      alert('Failed to delete keyword');
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
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Bot Keywords</h1>
          <p className="mt-1 text-sm text-gray-500">
            Manage system, category, and business keyword triggers for the WhatsApp bot
          </p>
        </div>
        <button
          onClick={handleCreate}
          className="rounded-xl bg-brand px-4 py-2.5 text-sm font-bold text-white transition hover:bg-brand-600"
        >
          <span className="flex items-center gap-2">
            <Plus className="h-4 w-4" />
            Add Keyword
          </span>
        </button>
      </div>

      {/* Stats */}
      <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <SummaryCard label="Total Keywords" value={totalCount} icon={Hash} color="blue" />
        <SummaryCard label="System" value={systemCount} icon={Globe} color="purple" />
        <SummaryCard label="Category" value={categoryCount} icon={Layers} color="green" />
        <SummaryCard label="Business" value={businessCount} icon={Building2} color="gray" />
      </div>

      {/* Filters */}
      <div className="mt-6 flex flex-wrap items-center gap-3">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
          <input
            type="text"
            value={search}
            onChange={e => { setSearch(e.target.value); setPage(1); }}
            placeholder="Search keywords..."
            className="rounded-lg border border-gray-300 py-2 pl-10 pr-3 text-sm text-gray-700 focus:border-brand focus:outline-none"
          />
        </div>

        <select
          value={scopeFilter}
          onChange={e => { setScopeFilter(e.target.value); setPage(1); }}
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 focus:border-brand focus:outline-none"
        >
          <option value="all">All Scopes</option>
          {SCOPES.map(s => (
            <option key={s} value={s}>{s.charAt(0).toUpperCase() + s.slice(1)}</option>
          ))}
        </select>

        {categories.length > 0 && (
          <select
            value={categoryFilter}
            onChange={e => { setCategoryFilter(e.target.value); setPage(1); }}
            className="rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 focus:border-brand focus:outline-none"
          >
            <option value="all">All Categories</option>
            {categories.map(c => (
              <option key={c} value={c}>{c.charAt(0).toUpperCase() + c.slice(1)}</option>
            ))}
          </select>
        )}

        {(search || scopeFilter !== 'all' || categoryFilter !== 'all') && (
          <button
            onClick={() => { setSearch(''); setScopeFilter('all'); setCategoryFilter('all'); setPage(1); }}
            className="text-sm text-brand hover:underline"
          >
            Clear filters
          </button>
        )}
      </div>

      {/* Table */}
      <div className="mt-4 overflow-x-auto rounded-xl border border-gray-200 bg-white">
        {pageItems.length === 0 ? (
          <div className="py-16 text-center text-sm text-gray-500">No keywords found</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="border-b border-gray-100 bg-gray-50">
              <tr>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Keyword</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Match</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Scope</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Category</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Action</th>
                <th className="px-4 py-3 text-center font-medium text-gray-500">Priority</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Status</th>
                <th className="px-4 py-3 text-right font-medium text-gray-500">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {pageItems.map(kw => (
                <tr key={kw.id} className={`transition hover:bg-gray-50 ${!kw.is_active ? 'opacity-50' : ''}`}>
                  <td className="px-4 py-3">
                    <div>
                      <p className="font-mono text-xs font-medium text-gray-900 max-w-[200px] truncate">{kw.keyword}</p>
                      {kw.description && (
                        <p className="mt-0.5 text-xs text-gray-400 max-w-[200px] truncate">{kw.description}</p>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${MATCH_COLORS[kw.match_type] || 'bg-gray-100 text-gray-600'}`}>
                      {kw.match_type}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium capitalize ${SCOPE_COLORS[kw.scope] || 'bg-gray-100 text-gray-600'}`}>
                      {kw.scope}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-gray-500 text-xs">
                    {kw.category || '-'}
                  </td>
                  <td className="px-4 py-3">
                    <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${ACTION_COLORS[kw.action_type] || 'bg-gray-100 text-gray-600'}`}>
                      {kw.action_type.replace(/_/g, ' ')}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-center text-gray-600">{kw.priority}</td>
                  <td className="px-4 py-3">
                    <StatusBadge status={kw.is_active ? 'active' : 'inactive'} />
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-1">
                      <button
                        onClick={() => handleToggle(kw)}
                        className="rounded-lg p-1.5 text-gray-400 transition hover:bg-gray-100 hover:text-gray-600"
                        title={kw.is_active ? 'Deactivate' : 'Activate'}
                      >
                        {kw.is_active ? <ToggleRight className="h-4 w-4 text-green-500" /> : <ToggleLeft className="h-4 w-4" />}
                      </button>
                      {kw.scope !== 'business' && (
                        <>
                          <button
                            onClick={() => handleEdit(kw)}
                            className="rounded-lg p-1.5 text-gray-400 transition hover:bg-gray-100 hover:text-gray-600"
                            title="Edit"
                          >
                            <Pencil className="h-4 w-4" />
                          </button>
                          <button
                            onClick={() => handleDelete(kw)}
                            className="rounded-lg p-1.5 text-gray-400 transition hover:bg-red-50 hover:text-red-500"
                            title="Delete"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <Pagination page={page} totalPages={totalPages} onPageChange={setPage} />

      {/* Create / Edit Modal */}
      <DetailModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title={editing ? `Edit Keyword: ${editing.keyword.slice(0, 30)}` : 'Create Keyword'}
        wide
      >
        <div className="space-y-5">
          {/* Keyword */}
          <div>
            <label className="block text-sm font-medium text-gray-700">
              Keyword / Pattern <span className="text-red-400">*</span>
            </label>
            <input
              type="text"
              value={formKeyword}
              onChange={e => setFormKeyword(e.target.value)}
              placeholder="e.g. help, ^(book|reserve)$"
              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 focus:border-brand focus:outline-none"
            />
            <p className="mt-1 text-xs text-gray-400">
              For regex match type, use regular expression syntax (e.g. ^(help|support)$)
            </p>
          </div>

          {/* Row: Match Type, Scope */}
          <div className="grid gap-4 sm:grid-cols-3">
            <div>
              <label className="block text-sm font-medium text-gray-700">Match Type</label>
              <select
                value={formMatchType}
                onChange={e => setFormMatchType(e.target.value)}
                className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 focus:border-brand focus:outline-none"
              >
                {MATCH_TYPES.map(m => (
                  <option key={m} value={m}>{m.replace(/_/g, ' ')}</option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700">Scope</label>
              <select
                value={formScope}
                onChange={e => setFormScope(e.target.value)}
                className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 focus:border-brand focus:outline-none"
              >
                <option value="system">System (global)</option>
                <option value="category">Category</option>
              </select>
              <p className="mt-1 text-xs text-gray-400">
                Account-scoped keywords are managed by account owners
              </p>
            </div>

            {formScope === 'category' && (
              <div>
                <label className="block text-sm font-medium text-gray-700">Category</label>
                <input
                  type="text"
                  value={formCategory}
                  onChange={e => setFormCategory(e.target.value.toLowerCase())}
                  placeholder="e.g. church, restaurant, salon"
                  className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 focus:border-brand focus:outline-none"
                />
              </div>
            )}
          </div>

          {/* Action Type */}
          <div>
            <label className="block text-sm font-medium text-gray-700">Action Type</label>
            <select
              value={formActionType}
              onChange={e => setFormActionType(e.target.value)}
              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 focus:border-brand focus:outline-none"
            >
              {ACTION_TYPES.map(a => (
                <option key={a} value={a}>{a.replace(/_/g, ' ')}</option>
              ))}
            </select>
          </div>

          {/* Payload */}
          <div>
            <label className="block text-sm font-medium text-gray-700">
              Payload (JSON) <span className="text-red-400">*</span>
            </label>
            <textarea
              value={formPayload}
              onChange={e => setFormPayload(e.target.value)}
              rows={4}
              placeholder='{"message":"Your response here"}'
              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 font-mono text-sm text-gray-700 focus:border-brand focus:outline-none"
            />
            <p className="mt-1 text-xs text-gray-400">
              JSON payload. For replies: {`{"message":"..."}`}. For capabilities: {`{"capability":"scheduling"}`}. For navigation: {`{"action":"show_status"}`}.
            </p>
          </div>

          {/* Description */}
          <div>
            <label className="block text-sm font-medium text-gray-700">Description</label>
            <input
              type="text"
              value={formDescription}
              onChange={e => setFormDescription(e.target.value)}
              placeholder="Admin-facing description of what this keyword does"
              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 focus:border-brand focus:outline-none"
            />
          </div>

          {/* Row: Priority, Active */}
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="block text-sm font-medium text-gray-700">Priority</label>
              <input
                type="number"
                value={formPriority}
                onChange={e => setFormPriority(Number(e.target.value))}
                className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 focus:border-brand focus:outline-none"
              />
              <p className="mt-1 text-xs text-gray-400">Higher priority keywords match first (100 = highest)</p>
            </div>
            <div className="flex items-end gap-3 pb-1">
              <label className="flex items-center gap-2 text-sm font-medium text-gray-700 cursor-pointer">
                <input
                  type="checkbox"
                  checked={formActive}
                  onChange={e => setFormActive(e.target.checked)}
                  className="h-4 w-4 rounded border-gray-300 text-brand focus:ring-brand"
                />
                Active
              </label>
            </div>
          </div>

          {/* Save button */}
          <div className="flex gap-3 pt-2">
            <button
              onClick={handleSave}
              disabled={saving || !formKeyword.trim() || !formPayload.trim()}
              className="rounded-xl bg-brand px-6 py-2.5 text-sm font-bold text-white transition hover:bg-brand-600 disabled:opacity-50"
            >
              {saving ? 'Saving...' : editing ? 'Save Changes' : 'Create Keyword'}
            </button>
            <button
              onClick={() => setModalOpen(false)}
              className="rounded-xl border border-gray-300 px-4 py-2.5 text-sm font-medium text-gray-700 transition hover:bg-gray-50"
            >
              Cancel
            </button>
          </div>
        </div>
      </DetailModal>
    </div>
  );
}
