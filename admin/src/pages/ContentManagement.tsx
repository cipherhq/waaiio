import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { Pagination } from '@/components/Pagination';
import { StatusBadge } from '@/components/StatusBadge';
import { DetailModal, DetailRow } from '@/components/DetailModal';
import { fmtDate, fmtDateTime, fmtCurrency } from '@/lib/formatters';
import { logAudit } from '@/lib/auditLog';

interface SitePage {
  id: string;
  title: string;
  slug: string;
  type: string | null;
  content: string | null;
  status: string;
  created_at: string;
  updated_at: string | null;
}

interface EditorState {
  id: string | null;
  title: string;
  slug: string;
  content: string;
  status: string;
}

const EMPTY_EDITOR: EditorState = {
  id: null,
  title: '',
  slug: '',
  content: '',
  status: 'draft',
};

export default function ContentManagement() {
  const [pages, setPages] = useState<SitePage[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [typeFilter, setTypeFilter] = useState('all');
  const perPage = 20;

  // Editor modal
  const [editorOpen, setEditorOpen] = useState(false);
  const [editor, setEditor] = useState<EditorState>(EMPTY_EDITOR);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  async function loadData() {
    setLoading(true);
    try {
      const { data } = await supabase
        .from('site_pages')
        .select('*')
        .order('updated_at', { ascending: false });

      setPages(data || []);
    } catch (error) {
      console.warn('Failed to load site pages:', error);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { loadData(); }, []);

  // Open editor with existing page
  function handleRowClick(p: SitePage) {
    setEditor({
      id: p.id,
      title: p.title,
      slug: p.slug,
      content: p.content || '',
      status: p.status,
    });
    setEditorOpen(true);
  }

  // Open editor for new page
  function handleNewPage() {
    setEditor({ ...EMPTY_EDITOR });
    setEditorOpen(true);
  }

  function handleCloseEditor() {
    setEditorOpen(false);
    setEditor({ ...EMPTY_EDITOR });
  }

  // Save (upsert)
  async function handleSave() {
    if (!editor.title.trim() || !editor.slug.trim()) {
      alert('Title and slug are required');
      return;
    }

    setSaving(true);
    try {
      const now = new Date().toISOString();

      if (editor.id) {
        // Update existing
        const { error } = await supabase
          .from('site_pages')
          .update({
            title: editor.title.trim(),
            slug: editor.slug.trim(),
            content: editor.content,
            status: editor.status,
            updated_at: now,
          })
          .eq('id', editor.id);

        if (error) throw error;

        await logAudit({
          action: 'update_site_page',
          entity_type: 'site_page',
          entity_id: editor.id,
          details: {
            title: editor.title,
            slug: editor.slug,
            status: editor.status,
          },
        });
      } else {
        // Insert new
        const { data, error } = await supabase
          .from('site_pages')
          .insert({
            title: editor.title.trim(),
            slug: editor.slug.trim(),
            content: editor.content,
            status: editor.status,
            created_at: now,
            updated_at: now,
          })
          .select('id')
          .single();

        if (error) throw error;

        await logAudit({
          action: 'create_site_page',
          entity_type: 'site_page',
          entity_id: data.id,
          details: {
            title: editor.title,
            slug: editor.slug,
            status: editor.status,
          },
        });
      }

      handleCloseEditor();
      await loadData();
    } catch (error) {
      console.error('Save error:', error);
      alert('Failed to save page');
    } finally {
      setSaving(false);
    }
  }

  // Delete
  async function handleDelete() {
    if (!editor.id) return;
    if (!window.confirm('Are you sure you want to delete this page? This action cannot be undone.')) return;

    setDeleting(true);
    try {
      const { error } = await supabase
        .from('site_pages')
        .delete()
        .eq('id', editor.id);

      if (error) throw error;

      await logAudit({
        action: 'delete_site_page',
        entity_type: 'site_page',
        entity_id: editor.id,
        details: {
          title: editor.title,
          slug: editor.slug,
        },
      });

      handleCloseEditor();
      await loadData();
    } catch (error) {
      console.error('Delete error:', error);
      alert('Failed to delete page');
    } finally {
      setDeleting(false);
    }
  }

  // Derived data
  const types = [...new Set(pages.map(p => p.type).filter(Boolean))].sort() as string[];

  const filtered = pages.filter(p => {
    if (statusFilter !== 'all' && p.status !== statusFilter) return false;
    if (typeFilter !== 'all' && p.type !== typeFilter) return false;
    if (search) {
      const q = search.toLowerCase();
      if (!p.title.toLowerCase().includes(q) && !p.slug.toLowerCase().includes(q)) return false;
    }
    return true;
  });

  const totalPages = Math.max(1, Math.ceil(filtered.length / perPage));
  const pageItems = filtered.slice((page - 1) * perPage, page * perPage);

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
          <h1 className="text-2xl font-bold text-gray-900">Content Management</h1>
          <p className="mt-1 text-sm text-gray-500">Manage site pages and legal content</p>
        </div>
        <button
          onClick={handleNewPage}
          className="rounded-xl bg-brand px-4 py-2.5 text-sm font-bold text-white transition hover:bg-brand-600 disabled:opacity-50"
        >
          New Page
        </button>
      </div>

      {/* Filters */}
      <div className="mt-6 flex flex-wrap items-center gap-3">
        <input
          type="text"
          value={search}
          onChange={e => { setSearch(e.target.value); setPage(1); }}
          placeholder="Search by title or slug..."
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 focus:border-brand focus:outline-none sm:w-64"
        />
        <select
          value={typeFilter}
          onChange={e => { setTypeFilter(e.target.value); setPage(1); }}
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 focus:border-brand focus:outline-none"
        >
          <option value="all">All Types</option>
          {types.map(t => (
            <option key={t} value={t}>{t}</option>
          ))}
        </select>
        <select
          value={statusFilter}
          onChange={e => { setStatusFilter(e.target.value); setPage(1); }}
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 focus:border-brand focus:outline-none"
        >
          <option value="all">All Statuses</option>
          <option value="draft">Draft</option>
          <option value="published">Published</option>
        </select>
        {(statusFilter !== 'all' || typeFilter !== 'all' || search) && (
          <button
            onClick={() => { setStatusFilter('all'); setTypeFilter('all'); setSearch(''); setPage(1); }}
            className="text-sm text-brand hover:underline"
          >
            Clear filters
          </button>
        )}
      </div>

      {/* Table */}
      <div className="mt-4 overflow-x-auto rounded-xl border border-gray-200 bg-white">
        {pageItems.length === 0 ? (
          <div className="py-16 text-center text-sm text-gray-500">No pages found</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="border-b border-gray-100 bg-gray-50">
              <tr>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Title</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Slug</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Type</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Status</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Updated</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {pageItems.map(p => (
                <tr
                  key={p.id}
                  onClick={() => handleRowClick(p)}
                  className="cursor-pointer transition hover:bg-gray-50"
                >
                  <td className="px-4 py-3 font-medium text-gray-900">{p.title}</td>
                  <td className="px-4 py-3 text-gray-600 font-mono text-xs">{p.slug}</td>
                  <td className="px-4 py-3 text-gray-600 capitalize">{p.type || '—'}</td>
                  <td className="px-4 py-3">
                    <StatusBadge status={p.status} />
                  </td>
                  <td className="px-4 py-3 text-gray-500 whitespace-nowrap">
                    {p.updated_at ? fmtDate(p.updated_at) : fmtDate(p.created_at)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <Pagination page={page} totalPages={totalPages} onPageChange={setPage} />

      {/* Editor Modal */}
      <DetailModal
        open={editorOpen}
        onClose={handleCloseEditor}
        title={editor.id ? 'Edit Page' : 'New Page'}
        wide
      >
        <div className="space-y-4">
          {/* Title */}
          <div>
            <label className="block text-sm font-medium text-gray-700">Title</label>
            <input
              type="text"
              value={editor.title}
              onChange={e => setEditor(prev => ({ ...prev, title: e.target.value }))}
              placeholder="Page title"
              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm text-gray-900 focus:border-brand focus:outline-none"
            />
          </div>

          {/* Slug */}
          <div>
            <label className="block text-sm font-medium text-gray-700">Slug</label>
            <input
              type="text"
              value={editor.slug}
              onChange={e => setEditor(prev => ({ ...prev, slug: e.target.value }))}
              placeholder="page-slug"
              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm text-gray-900 focus:border-brand focus:outline-none"
            />
          </div>

          {/* Content */}
          <div>
            <label className="block text-sm font-medium text-gray-700">Content</label>
            <textarea
              value={editor.content}
              onChange={e => setEditor(prev => ({ ...prev, content: e.target.value }))}
              rows={12}
              placeholder="Page content..."
              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm text-gray-900 focus:border-brand focus:outline-none"
            />
          </div>

          {/* Status */}
          <div>
            <label className="block text-sm font-medium text-gray-700">Status</label>
            <select
              value={editor.status}
              onChange={e => setEditor(prev => ({ ...prev, status: e.target.value }))}
              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm text-gray-900 focus:border-brand focus:outline-none"
            >
              <option value="draft">Draft</option>
              <option value="published">Published</option>
            </select>
          </div>

          {/* Actions */}
          <div className="flex items-center gap-3 pt-2">
            <button
              onClick={handleSave}
              disabled={saving || deleting}
              className="rounded-xl bg-brand px-4 py-2.5 text-sm font-bold text-white transition hover:bg-brand-600 disabled:opacity-50"
            >
              {saving ? 'Saving...' : editor.id ? 'Save Changes' : 'Create Page'}
            </button>
            {editor.id && (
              <button
                onClick={handleDelete}
                disabled={saving || deleting}
                className="rounded-xl bg-red-600 px-4 py-2.5 text-sm font-bold text-white transition hover:bg-red-700 disabled:opacity-50"
              >
                {deleting ? 'Deleting...' : 'Delete Page'}
              </button>
            )}
          </div>
        </div>
      </DetailModal>
    </div>
  );
}
