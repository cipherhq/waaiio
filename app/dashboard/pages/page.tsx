'use client';
import { getLocale, type CountryCode } from '@/lib/constants';

import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';

interface SitePage {
  id: string;
  slug: string;
  title: string;
  content: string;
  meta_description: string | null;
  is_published: boolean;
  updated_at: string;
}

export default function PagesPage() {
  const [pages, setPages] = useState<SitePage[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<SitePage | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  async function fetchPages() {
    const supabase = createClient();
    const { data } = await supabase
      .from('site_pages')
      .select('*')
      .order('slug');
    setPages((data as SitePage[]) || []);
    setLoading(false);
  }

  useEffect(() => { fetchPages(); }, []);

  async function handleSave() {
    if (!editing) return;
    setSaving(true);
    const supabase = createClient();
    await supabase
      .from('site_pages')
      .update({
        title: editing.title,
        content: editing.content,
        meta_description: editing.meta_description || null,
        is_published: editing.is_published,
      })
      .eq('id', editing.id);
    setSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
    fetchPages();
  }

  if (loading) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-brand border-t-transparent" />
      </div>
    );
  }

  if (editing) {
    return (
      <div>
        <div className="flex items-center gap-4">
          <button
            onClick={() => setEditing(null)}
            className="rounded-lg p-2 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
          >
            <svg aria-hidden="true" className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
          </button>
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Edit Page</h1>
            <p className="text-sm text-gray-500">/{editing.slug}</p>
          </div>
        </div>

        <div className="mt-6 space-y-4">
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">Title</label>
            <input
              type="text"
              value={editing.title}
              onChange={(e) => setEditing({ ...editing, title: e.target.value })}
              className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand"
            />
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">Meta Description</label>
            <input
              type="text"
              value={editing.meta_description || ''}
              onChange={(e) => setEditing({ ...editing, meta_description: e.target.value })}
              className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand"
              placeholder="SEO description"
            />
          </div>

          <div className="flex items-center gap-3">
            <label className="text-sm font-medium text-gray-700">Published</label>
            <button
              onClick={() => setEditing({ ...editing, is_published: !editing.is_published })}
              className={`relative h-6 w-11 rounded-full transition ${editing.is_published ? 'bg-brand' : 'bg-gray-200'}`}
            >
              <div
                className="absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition"
                style={{ left: editing.is_published ? '22px' : '2px' }}
              />
            </button>
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">
              Content <span className="text-xs text-gray-400">(Markdown supported)</span>
            </label>
            <textarea
              value={editing.content}
              onChange={(e) => setEditing({ ...editing, content: e.target.value })}
              rows={24}
              className="w-full rounded-lg border border-gray-200 px-3 py-2 font-mono text-sm outline-none focus:border-brand"
            />
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={handleSave}
              disabled={saving}
              className="rounded-lg bg-brand px-6 py-2.5 text-sm font-semibold text-white hover:bg-brand-600 disabled:opacity-50"
            >
              {saving ? 'Saving...' : saved ? 'Saved!' : 'Save Changes'}
            </button>
            <button
              onClick={() => setEditing(null)}
              className="rounded-lg border border-gray-200 px-4 py-2.5 text-sm font-medium text-gray-600 hover:bg-gray-50"
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-900">Site Pages</h1>
      <p className="mt-1 text-sm text-gray-500">Manage your Terms, Privacy, and other public pages</p>

      <div className="mt-6 overflow-x-auto rounded-xl border border-gray-100 bg-white">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-50 bg-gray-50/50">
              <th scope="col" className="px-4 py-3 text-left font-medium text-gray-500">Page</th>
              <th scope="col" className="px-4 py-3 text-left font-medium text-gray-500">Slug</th>
              <th scope="col" className="px-4 py-3 text-left font-medium text-gray-500">Status</th>
              <th scope="col" className="px-4 py-3 text-left font-medium text-gray-500">Last Updated</th>
              <th scope="col" className="px-4 py-3 text-left font-medium text-gray-500">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {pages.map((page) => (
              <tr key={page.id} className="hover:bg-gray-50/50">
                <td className="px-4 py-3 font-medium text-gray-900">{page.title}</td>
                <td className="px-4 py-3 font-mono text-xs text-gray-500">/{page.slug}</td>
                <td className="px-4 py-3">
                  <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                    page.is_published ? 'bg-green-100 text-green-700' : 'bg-yellow-100 text-yellow-700'
                  }`}>
                    {page.is_published ? 'Published' : 'Draft'}
                  </span>
                </td>
                <td className="px-4 py-3 text-gray-500">
                  {new Date(page.updated_at).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}
                </td>
                <td className="px-4 py-3">
                  <button
                    onClick={() => setEditing(page)}
                    className="rounded px-2 py-1 text-xs font-medium text-brand hover:bg-brand-50"
                  >
                    Edit
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
