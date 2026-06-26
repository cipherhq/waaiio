import { useEffect, useRef, useState } from 'react';
import { SummaryCard } from '@/components/SummaryCard';
import { StatusBadge } from '@/components/StatusBadge';
import { Pagination } from '@/components/Pagination';
import {
  FileText,
  Plus,
  Trash2,
  X,
  Search,
  RefreshCw,
  Eye,
  CheckCircle,
  Clock,
  XCircle,
} from 'lucide-react';
import { supabase } from '@/lib/supabase';

/* ─── Types ─── */

interface TemplateComponent {
  type: 'HEADER' | 'BODY' | 'FOOTER' | 'BUTTONS';
  format?: string;
  text?: string;
  buttons?: Array<{
    type: string;
    text: string;
    url?: string;
    phone_number?: string;
  }>;
}

interface MessageTemplate {
  id: string;
  name: string;
  status: 'APPROVED' | 'PENDING' | 'REJECTED' | 'PAUSED' | 'DISABLED';
  category: 'UTILITY' | 'MARKETING' | 'AUTHENTICATION';
  language: string;
  components: TemplateComponent[];
  quality_score?: { score: string };
}

interface CreateForm {
  name: string;
  category: 'UTILITY' | 'MARKETING' | 'AUTHENTICATION';
  language: string;
  headerText: string;
  bodyText: string;
  footerText: string;
  buttons: Array<{ type: 'URL' | 'PHONE_NUMBER' | 'QUICK_REPLY'; text: string; value: string }>;
}

const EMPTY_FORM: CreateForm = {
  name: '',
  category: 'UTILITY',
  language: 'en_US',
  headerText: '',
  bodyText: '',
  footerText: '',
  buttons: [],
};

const LANGUAGES = [
  { code: 'en_US', label: 'English (US)' },
  { code: 'en_GB', label: 'English (UK)' },
  { code: 'es', label: 'Spanish' },
  { code: 'fr', label: 'French' },
  { code: 'pt_BR', label: 'Portuguese (BR)' },
  { code: 'ar', label: 'Arabic' },
  { code: 'hi', label: 'Hindi' },
];

const STATUS_COLORS: Record<string, 'green' | 'yellow' | 'red' | 'gray'> = {
  APPROVED: 'green',
  PENDING: 'yellow',
  REJECTED: 'red',
  PAUSED: 'gray',
  DISABLED: 'gray',
};

/* ─── Component ─── */

export default function WhatsAppTemplates() {
  const [templates, setTemplates] = useState<MessageTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [selectedTemplate, setSelectedTemplate] = useState<MessageTemplate | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState<CreateForm>({ ...EMPTY_FORM });
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [error, setError] = useState('');
  const loadingRef = useRef(false);
  const perPage = 20;

  const apiUrl = import.meta.env.VITE_API_URL || '';

  async function getAuthHeaders(): Promise<Record<string, string>> {
    const { data } = await supabase.auth.getSession();
    const token = data?.session?.access_token;
    return token ? { Authorization: `Bearer ${token}` } : {};
  }

  async function loadTemplates() {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    setError('');

    try {
      const headers = await getAuthHeaders();
      const res = await fetch(`${apiUrl}/api/whatsapp/templates`, { headers });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.message || `Failed to load: ${res.status}`);
      }
      const data = await res.json();
      setTemplates(data.data || []);
    } catch (err) {
      console.warn('Failed to load templates:', err);
      setError(err instanceof Error ? err.message : 'Failed to load templates');
    } finally {
      setLoading(false);
      loadingRef.current = false;
    }
  }

  useEffect(() => { loadTemplates(); }, []);

  // Stats
  const approved = templates.filter(t => t.status === 'APPROVED').length;
  const pending = templates.filter(t => t.status === 'PENDING').length;
  const rejected = templates.filter(t => t.status === 'REJECTED').length;

  // Filter & paginate
  const filtered = search
    ? templates.filter(t =>
      t.name.toLowerCase().includes(search.toLowerCase()) ||
      t.category.toLowerCase().includes(search.toLowerCase())
    )
    : templates;
  const totalPages = Math.max(1, Math.ceil(filtered.length / perPage));
  const items = filtered.slice((page - 1) * perPage, page * perPage);

  async function handleCreate() {
    if (!form.name || !form.bodyText) {
      setError('Template name and body text are required');
      return;
    }

    setCreating(true);
    setError('');

    try {
      const components: TemplateComponent[] = [];

      if (form.headerText) {
        components.push({ type: 'HEADER', format: 'TEXT', text: form.headerText });
      }

      // Body with variable extraction
      components.push({ type: 'BODY', text: form.bodyText });

      if (form.footerText) {
        components.push({ type: 'FOOTER', text: form.footerText });
      }

      if (form.buttons.length > 0) {
        components.push({
          type: 'BUTTONS',
          buttons: form.buttons.map(b => {
            if (b.type === 'URL') return { type: 'URL', text: b.text, url: b.value };
            if (b.type === 'PHONE_NUMBER') return { type: 'PHONE_NUMBER', text: b.text, phone_number: b.value };
            return { type: 'QUICK_REPLY', text: b.text };
          }),
        });
      }

      const authHeaders = await getAuthHeaders();
      const res = await fetch(`${apiUrl}/api/whatsapp/templates`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders },
        body: JSON.stringify({
          template: {
            name: form.name,
            language: form.language,
            category: form.category,
            components,
            allow_category_change: true,
          },
        }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.message || `Failed to create: ${res.status}`);
      }

      setForm({ ...EMPTY_FORM });
      setShowCreate(false);
      await loadTemplates();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create template');
    } finally {
      setCreating(false);
    }
  }

  async function handleDelete(name: string) {
    if (!confirm(`Delete template "${name}"? This cannot be undone.`)) return;
    setDeleting(name);
    setError('');

    try {
      const delHeaders = await getAuthHeaders();
      const res = await fetch(`${apiUrl}/api/whatsapp/templates?name=${encodeURIComponent(name)}`, {
        method: 'DELETE',
        headers: delHeaders,
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.message || `Failed to delete: ${res.status}`);
      }

      setSelectedTemplate(null);
      await loadTemplates();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete template');
    } finally {
      setDeleting(null);
    }
  }

  function addButton() {
    if (form.buttons.length >= 3) return;
    setForm({ ...form, buttons: [...form.buttons, { type: 'QUICK_REPLY', text: '', value: '' }] });
  }

  function removeButton(idx: number) {
    setForm({ ...form, buttons: form.buttons.filter((_, i) => i !== idx) });
  }

  function updateButton(idx: number, field: string, value: string) {
    const buttons = [...form.buttons];
    buttons[idx] = { ...buttons[idx], [field]: value };
    setForm({ ...form, buttons });
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">WhatsApp Templates</h1>
          <p className="text-sm text-gray-500 mt-1">
            Manage message templates on the shared WABA
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => loadTemplates()}
            className="inline-flex items-center gap-1.5 px-3 py-2 bg-white border border-gray-300 rounded-lg text-sm hover:bg-gray-50"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
          <button
            onClick={() => { setShowCreate(true); setError(''); }}
            className="inline-flex items-center gap-1.5 px-4 py-2 bg-emerald-600 text-white rounded-lg text-sm hover:bg-emerald-700"
          >
            <Plus className="w-4 h-4" />
            Create Template
          </button>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-4 gap-4">
        <SummaryCard label="Total Templates" value={templates.length} icon={FileText} />
        <SummaryCard label="Approved" value={approved} icon={CheckCircle} color="green" />
        <SummaryCard label="Pending" value={pending} icon={Clock} color="yellow" />
        <SummaryCard label="Rejected" value={rejected} icon={XCircle} color="red" />
      </div>

      {/* Error */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-sm text-red-700 flex items-center justify-between">
          {error}
          <button onClick={() => setError('')}><X className="w-4 h-4" /></button>
        </div>
      )}

      {/* Search */}
      <div className="relative max-w-sm">
        <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
        <input
          type="text"
          placeholder="Search templates..."
          value={search}
          onChange={e => { setSearch(e.target.value); setPage(1); }}
          className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500"
        />
      </div>

      {/* Table */}
      <div className="bg-white rounded-lg border border-gray-200 overflow-hidden overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b border-gray-200">
            <tr>
              <th className="text-left px-4 py-3 font-medium text-gray-600">Name</th>
              <th className="text-left px-4 py-3 font-medium text-gray-600">Category</th>
              <th className="text-left px-4 py-3 font-medium text-gray-600">Language</th>
              <th className="text-left px-4 py-3 font-medium text-gray-600">Status</th>
              <th className="text-right px-4 py-3 font-medium text-gray-600">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {loading ? (
              <tr><td colSpan={5} className="px-4 py-12 text-center text-gray-400">Loading...</td></tr>
            ) : items.length === 0 ? (
              <tr><td colSpan={5} className="px-4 py-12 text-center text-gray-400">No templates found</td></tr>
            ) : items.map(t => (
              <tr key={t.id} className="hover:bg-gray-50">
                <td className="px-4 py-3 font-mono text-xs">{t.name}</td>
                <td className="px-4 py-3">
                  <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${
                    t.category === 'UTILITY' ? 'bg-blue-100 text-blue-700' :
                    t.category === 'MARKETING' ? 'bg-purple-100 text-purple-700' :
                    'bg-orange-100 text-orange-700'
                  }`}>
                    {t.category}
                  </span>
                </td>
                <td className="px-4 py-3 text-gray-600">{t.language}</td>
                <td className="px-4 py-3">
                  <StatusBadge status={t.status} color={STATUS_COLORS[t.status] || 'gray'} />
                </td>
                <td className="px-4 py-3 text-right space-x-1">
                  <button
                    onClick={() => setSelectedTemplate(t)}
                    className="inline-flex items-center gap-1 px-2 py-1 text-xs text-gray-600 hover:text-gray-900 hover:bg-gray-100 rounded"
                  >
                    <Eye className="w-3.5 h-3.5" /> View
                  </button>
                  <button
                    onClick={() => handleDelete(t.name)}
                    disabled={deleting === t.name}
                    className="inline-flex items-center gap-1 px-2 py-1 text-xs text-red-600 hover:text-red-700 hover:bg-red-50 rounded disabled:opacity-50"
                  >
                    <Trash2 className="w-3.5 h-3.5" /> {deleting === t.name ? 'Deleting...' : 'Delete'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Pagination page={page} totalPages={totalPages} onPageChange={setPage} />

      {/* View Template Modal */}
      {selectedTemplate && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl shadow-xl max-w-lg w-full max-h-[80vh] overflow-y-auto">
            <div className="flex items-center justify-between px-6 py-4 border-b">
              <h2 className="text-lg font-semibold">{selectedTemplate.name}</h2>
              <button onClick={() => setSelectedTemplate(null)}>
                <X className="w-5 h-5 text-gray-400 hover:text-gray-600" />
              </button>
            </div>
            <div className="px-6 py-4 space-y-4">
              <div className="grid grid-cols-3 gap-4 text-sm">
                <div>
                  <span className="text-gray-500 block">Category</span>
                  <span className="font-medium">{selectedTemplate.category}</span>
                </div>
                <div>
                  <span className="text-gray-500 block">Language</span>
                  <span className="font-medium">{selectedTemplate.language}</span>
                </div>
                <div>
                  <span className="text-gray-500 block">Status</span>
                  <StatusBadge status={selectedTemplate.status} color={STATUS_COLORS[selectedTemplate.status] || 'gray'} />
                </div>
              </div>

              <div className="border-t pt-4">
                <h3 className="text-sm font-medium text-gray-700 mb-2">Components</h3>
                {selectedTemplate.components.map((c, i) => (
                  <div key={i} className="mb-3 p-3 bg-gray-50 rounded-lg">
                    <span className="text-xs font-semibold text-gray-500 uppercase">{c.type}</span>
                    {c.text && <p className="mt-1 text-sm whitespace-pre-wrap">{c.text}</p>}
                    {c.buttons?.map((b, j) => (
                      <div key={j} className="mt-1 text-xs text-gray-600">
                        [{b.type}] {b.text} {b.url || b.phone_number || ''}
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Create Template Modal */}
      {showCreate && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl shadow-xl max-w-2xl w-full max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between px-6 py-4 border-b">
              <h2 className="text-lg font-semibold">Create Message Template</h2>
              <button onClick={() => { setShowCreate(false); setForm({ ...EMPTY_FORM }); }}>
                <X className="w-5 h-5 text-gray-400 hover:text-gray-600" />
              </button>
            </div>
            <div className="px-6 py-4 space-y-4">
              {/* Name */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Template Name</label>
                <input
                  type="text"
                  value={form.name}
                  onChange={e => setForm({ ...form, name: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_') })}
                  placeholder="e.g. document_signature_request"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500"
                />
                <p className="mt-1 text-xs text-gray-400">Lowercase letters, numbers, and underscores only</p>
              </div>

              {/* Category + Language */}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Category</label>
                  <select
                    value={form.category}
                    onChange={e => setForm({ ...form, category: e.target.value as CreateForm['category'] })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500"
                  >
                    <option value="UTILITY">Utility</option>
                    <option value="MARKETING">Marketing</option>
                    <option value="AUTHENTICATION">Authentication</option>
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Language</label>
                  <select
                    value={form.language}
                    onChange={e => setForm({ ...form, language: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500"
                  >
                    {LANGUAGES.map(l => (
                      <option key={l.code} value={l.code}>{l.label}</option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Header */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Header <span className="text-gray-400 font-normal">(optional)</span>
                </label>
                <input
                  type="text"
                  value={form.headerText}
                  onChange={e => setForm({ ...form, headerText: e.target.value })}
                  placeholder="e.g. Document Signing Request"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500"
                />
              </div>

              {/* Body */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Body Text</label>
                <textarea
                  value={form.bodyText}
                  onChange={e => setForm({ ...form, bodyText: e.target.value })}
                  placeholder={"Hi {{1}}, {{2}} has sent you a document to sign.\n\nPlease review and sign here: {{3}}"}
                  rows={5}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500"
                />
                <p className="mt-1 text-xs text-gray-400">
                  Use {'{{1}}'}, {'{{2}}'}, {'{{3}}'} for variable placeholders
                </p>
              </div>

              {/* Footer */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Footer <span className="text-gray-400 font-normal">(optional)</span>
                </label>
                <input
                  type="text"
                  value={form.footerText}
                  onChange={e => setForm({ ...form, footerText: e.target.value })}
                  placeholder="e.g. Powered by Waaiio"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500"
                />
              </div>

              {/* Buttons */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <label className="text-sm font-medium text-gray-700">
                    Buttons <span className="text-gray-400 font-normal">(optional, max 3)</span>
                  </label>
                  {form.buttons.length < 3 && (
                    <button
                      onClick={addButton}
                      className="text-xs text-emerald-600 hover:text-emerald-700 font-medium"
                    >
                      + Add Button
                    </button>
                  )}
                </div>
                {form.buttons.map((b, i) => (
                  <div key={i} className="flex gap-2 mb-2 items-start">
                    <select
                      value={b.type}
                      onChange={e => updateButton(i, 'type', e.target.value)}
                      className="px-2 py-2 border border-gray-300 rounded-lg text-sm min-w-[120px]"
                    >
                      <option value="QUICK_REPLY">Quick Reply</option>
                      <option value="URL">URL</option>
                      <option value="PHONE_NUMBER">Phone</option>
                    </select>
                    <input
                      type="text"
                      value={b.text}
                      onChange={e => updateButton(i, 'text', e.target.value)}
                      placeholder="Button text"
                      className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm"
                    />
                    {b.type !== 'QUICK_REPLY' && (
                      <input
                        type="text"
                        value={b.value}
                        onChange={e => updateButton(i, 'value', e.target.value)}
                        placeholder={b.type === 'URL' ? 'https://...' : '+1234567890'}
                        className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm"
                      />
                    )}
                    <button
                      onClick={() => removeButton(i)}
                      className="p-2 text-red-400 hover:text-red-600"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                ))}
              </div>

              {/* Preview */}
              <div className="border-t pt-4">
                <h3 className="text-sm font-medium text-gray-700 mb-2">Preview</h3>
                <div className="bg-emerald-50 rounded-xl p-4 max-w-xs space-y-1">
                  {form.headerText && (
                    <p className="font-semibold text-sm">{form.headerText}</p>
                  )}
                  <p className="text-sm whitespace-pre-wrap">{form.bodyText || 'Body text...'}</p>
                  {form.footerText && (
                    <p className="text-xs text-gray-500 mt-2">{form.footerText}</p>
                  )}
                  {form.buttons.length > 0 && (
                    <div className="border-t border-emerald-200 pt-2 mt-2 space-y-1">
                      {form.buttons.map((b, i) => (
                        <div key={i} className="text-center text-sm text-emerald-700 font-medium py-1 bg-white rounded-lg">
                          {b.text || `Button ${i + 1}`}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* Actions */}
            <div className="px-6 py-4 border-t flex justify-end gap-2">
              <button
                onClick={() => { setShowCreate(false); setForm({ ...EMPTY_FORM }); }}
                className="px-4 py-2 text-sm text-gray-600 hover:text-gray-800 border border-gray-300 rounded-lg hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                onClick={handleCreate}
                disabled={creating || !form.name || !form.bodyText}
                className="px-4 py-2 text-sm bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {creating ? 'Creating...' : 'Submit for Approval'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
