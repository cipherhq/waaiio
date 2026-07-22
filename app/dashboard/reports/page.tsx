'use client';
import { getLocale, getPhonePlaceholder, type CountryCode } from '@/lib/constants';

import { useEffect, useState } from 'react';
import { useBusiness, useRequireCapability } from '@/components/dashboard/DashboardProvider';
import { createClient } from '@/lib/supabase/client';
import { PhoneInput } from '@/components/auth/PhoneInput';

interface Document {
  id: string;
  customer_phone: string;
  customer_name: string | null;
  title: string;
  file_path: string;
  file_url: string | null;
  file_size: number;
  status: string;
  sent_at: string | null;
  created_at: string;
}

const STORAGE_QUOTAS: Record<string, number> = {
  free: 50 * 1024 * 1024,
  growth: 500 * 1024 * 1024,
  business: 2 * 1024 * 1024 * 1024,
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export default function DocumentSharePage() {
  const allowed = useRequireCapability('reports');
  const business = useBusiness();
  const tier = business.subscription_tier || 'free';
  const quota = STORAGE_QUOTAS[tier] || STORAGE_QUOTAS.free;
  const [documents, setDocuments] = useState<Document[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [sending, setSending] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkSending, setBulkSending] = useState(false);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [page, setPage] = useState(1);
  const [uploadError, setUploadError] = useState('');
  const perPage = 20;

  // Upload form state
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState('');
  const [customerPhone, setCustomerPhone] = useState('');
  const [customerName, setCustomerName] = useState('');

  async function fetchDocuments() {
    const supabase = createClient();
    const { data } = await supabase
      .from('customer_reports')
      .select('*')
      .eq('business_id', business.id)
      .order('created_at', { ascending: false });
    setDocuments((data as Document[]) || []);
    setLoading(false);
  }

  useEffect(() => { fetchDocuments(); }, [business.id]);

  const storageUsed = documents.reduce((sum, d) => sum + (d.file_size || 0), 0);
  const storagePercent = Math.min(100, Math.round((storageUsed / quota) * 100));

  // Filter + search
  const filtered = documents.filter(d => {
    if (statusFilter !== 'all' && d.status !== statusFilter) return false;
    if (search) {
      const q = search.toLowerCase();
      if (!d.title.toLowerCase().includes(q) && !(d.customer_name || '').toLowerCase().includes(q) && !d.customer_phone.includes(q)) return false;
    }
    return true;
  });

  const totalPages = Math.max(1, Math.ceil(filtered.length / perPage));
  const pageItems = filtered.slice((page - 1) * perPage, page * perPage);

  async function handleUpload() {
    if (!file || !title || !customerPhone) return;
    setUploading(true);
    setUploadError('');

    try {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('title', title);
      formData.append('customerPhone', customerPhone);
      formData.append('customerName', customerName);
      formData.append('businessId', business.id);

      const res = await fetch('/api/reports/upload', { method: 'POST', body: formData });
      const data = await res.json();

      if (!res.ok) {
        setUploadError(data.error || 'Upload failed');
        setUploading(false);
        return;
      }

      setFile(null);
      setTitle('');
      setCustomerPhone('');
      setCustomerName('');
      fetchDocuments();
    } catch {
      setUploadError('Network error. Please try again.');
    } finally {
      setUploading(false);
    }
  }

  async function handleSend(reportId: string) {
    setSending(reportId);
    try {
      await fetch('/api/reports/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reportIds: [reportId] }),
      });
      fetchDocuments();
    } finally {
      setSending(null);
    }
  }

  async function handleDelete(reportId: string) {
    if (!confirm('Delete this document? This cannot be undone.')) return;
    setDeleting(reportId);
    try {
      await fetch('/api/reports/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reportId, businessId: business.id }),
      });
      setSelectedIds(prev => { const next = new Set(prev); next.delete(reportId); return next; });
      fetchDocuments();
    } finally {
      setDeleting(null);
    }
  }

  async function handleBulkSend() {
    if (selectedIds.size === 0) return;
    setBulkSending(true);
    try {
      await fetch('/api/reports/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reportIds: Array.from(selectedIds) }),
      });
      setSelectedIds(new Set());
      fetchDocuments();
    } finally {
      setBulkSending(false);
    }
  }

  function toggleSelect(id: string) {
    const next = new Set(selectedIds);
    if (next.has(id)) next.delete(id); else next.add(id);
    setSelectedIds(next);
  }

  const pendingDocs = filtered.filter(r => r.status === 'pending');

  if (!allowed) return null;

  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-900">Document Share</h1>
      <p className="mt-1 text-sm text-gray-500">
        Upload documents and share them with customers via WhatsApp.
      </p>

      {/* Storage Usage */}
      <div className="mt-4 flex items-center gap-3">
        <div className="flex-1 h-2 rounded-full bg-gray-100 overflow-hidden">
          <div
            className={`h-full rounded-full transition-all ${storagePercent > 90 ? 'bg-red-500' : storagePercent > 70 ? 'bg-yellow-500' : 'bg-brand'}`}
            style={{ width: `${storagePercent}%` }}
          />
        </div>
        <span className="text-xs text-gray-500 whitespace-nowrap">
          {formatBytes(storageUsed)} / {formatBytes(quota)}
        </span>
      </div>

      {/* Upload Section */}
      <div className="mt-5 rounded-xl border border-gray-200 bg-white p-6">
        <h2 className="text-sm font-semibold text-gray-900">Upload Document</h2>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div>
            <label className="block text-xs font-medium text-gray-600">Title *</label>
            <input type="text" value={title} onChange={e => setTitle(e.target.value)}
              placeholder="e.g., Lab Results - March 2026"
              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand focus:outline-none" />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600">Customer Phone (WhatsApp) *</label>
            <PhoneInput
              value={customerPhone}
              onChange={setCustomerPhone}
              countryCode={(business.country_code || 'NG') as CountryCode}
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600">Customer Name</label>
            <input type="text" value={customerName} onChange={e => setCustomerName(e.target.value)}
              placeholder="Optional"
              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand focus:outline-none" />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600">File * (PDF, PNG, JPG — max 10MB)</label>
            <input type="file" accept=".pdf,.png,.jpg,.jpeg" onChange={e => { setFile(e.target.files?.[0] || null); setUploadError(''); }}
              className="mt-1 w-full text-sm text-gray-500 file:mr-3 file:rounded-lg file:border-0 file:bg-brand-50 file:px-4 file:py-2 file:text-sm file:font-medium file:text-brand hover:file:bg-brand-100" />
          </div>
        </div>
        {uploadError && <p className="mt-2 text-xs text-red-600">{uploadError}</p>}
        <button onClick={handleUpload} disabled={uploading || !file || !title || !customerPhone}
          className="mt-4 rounded-lg bg-brand px-5 py-2 text-sm font-semibold text-white hover:bg-brand-600 disabled:opacity-50">
          {uploading ? 'Uploading...' : 'Upload Document'}
        </button>
      </div>

      {/* Filters */}
      <div className="mt-6 flex flex-wrap items-center gap-3">
        <input type="text" value={search} onChange={e => { setSearch(e.target.value); setPage(1); }}
          placeholder="Search by title, name, or phone..."
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand focus:outline-none sm:w-64" />
        <select value={statusFilter} onChange={e => { setStatusFilter(e.target.value); setPage(1); }}
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand focus:outline-none">
          <option value="all">All Statuses</option>
          <option value="pending">Pending</option>
          <option value="sent">Sent</option>
          <option value="failed">Failed</option>
        </select>
        {(search || statusFilter !== 'all') && (
          <button onClick={() => { setSearch(''); setStatusFilter('all'); setPage(1); }}
            className="text-sm text-brand hover:underline">Clear</button>
        )}
        <span className="text-xs text-gray-400">{filtered.length} document{filtered.length !== 1 ? 's' : ''}</span>
      </div>

      {/* Bulk Actions */}
      {selectedIds.size > 0 && (
        <div className="mt-3 flex items-center gap-3 rounded-lg bg-brand-50 px-4 py-3">
          <span className="text-sm font-medium text-brand">{selectedIds.size} selected</span>
          <button onClick={handleBulkSend} disabled={bulkSending}
            className="rounded-lg bg-brand px-4 py-1.5 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-50">
            {bulkSending ? 'Sending...' : 'Send All via WhatsApp'}
          </button>
          <button onClick={() => setSelectedIds(new Set())} className="text-sm text-gray-500 hover:text-gray-700">Clear</button>
        </div>
      )}

      {/* Documents Table */}
      <div className="mt-4 overflow-x-auto rounded-xl border border-gray-200 bg-white">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-gray-100 bg-gray-50/50">
            <tr>
              <th scope="col" className="px-4 py-3">
                {pendingDocs.length > 0 && (
                  <input type="checkbox"
                    checked={selectedIds.size === pendingDocs.length && pendingDocs.length > 0}
                    onChange={() => {
                      if (selectedIds.size === pendingDocs.length) setSelectedIds(new Set());
                      else setSelectedIds(new Set(pendingDocs.map(r => r.id)));
                    }}
                    className="rounded border-gray-300" />
                )}
              </th>
              <th scope="col" className="px-4 py-3 text-xs font-semibold text-gray-500">Title</th>
              <th scope="col" className="px-4 py-3 text-xs font-semibold text-gray-500">Customer</th>
              <th scope="col" className="px-4 py-3 text-xs font-semibold text-gray-500">Size</th>
              <th scope="col" className="px-4 py-3 text-xs font-semibold text-gray-500">Status</th>
              <th scope="col" className="px-4 py-3 text-xs font-semibold text-gray-500">Date</th>
              <th scope="col" className="px-4 py-3 text-xs font-semibold text-gray-500">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {loading ? (
              <tr><td colSpan={7} className="px-4 py-8 text-center text-gray-400">Loading...</td></tr>
            ) : pageItems.length === 0 ? (
              <tr><td colSpan={7} className="px-4 py-8 text-center text-gray-400">No documents found.</td></tr>
            ) : pageItems.map(d => (
              <tr key={d.id} className="hover:bg-gray-50/50">
                <td className="px-4 py-3">
                  {d.status === 'pending' && (
                    <input type="checkbox" checked={selectedIds.has(d.id)} onChange={() => toggleSelect(d.id)} className="rounded border-gray-300" />
                  )}
                </td>
                <td className="px-4 py-3">
                  <p className="font-medium text-gray-900">{d.title}</p>
                </td>
                <td className="px-4 py-3">
                  <p className="text-gray-800">{d.customer_name || '-'}</p>
                  <p className="text-xs text-gray-400">{d.customer_phone}</p>
                </td>
                <td className="px-4 py-3 text-gray-500 text-xs">{d.file_size ? formatBytes(d.file_size) : '-'}</td>
                <td className="px-4 py-3">
                  <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${
                    d.status === 'sent' ? 'bg-green-50 text-green-700' :
                    d.status === 'failed' ? 'bg-red-50 text-red-700' :
                    'bg-yellow-50 text-yellow-700'
                  }`}>{d.status}</span>
                </td>
                <td className="px-4 py-3 text-xs text-gray-500 whitespace-nowrap">
                  {new Date(d.created_at).toLocaleDateString(getLocale((business.country_code || 'NG') as CountryCode), { month: 'short', day: 'numeric' })}
                  {d.sent_at && <span className="block text-gray-400">Sent {new Date(d.sent_at).toLocaleDateString(getLocale((business.country_code || 'NG') as CountryCode), { month: 'short', day: 'numeric' })}</span>}
                </td>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-1">
                    {(d.status === 'pending' || d.status === 'failed') && (
                      <button onClick={() => handleSend(d.id)} disabled={sending === d.id}
                        className="rounded-lg bg-green-600 px-3 py-1 text-xs font-medium text-white hover:bg-green-700 disabled:opacity-50">
                        {sending === d.id ? 'Sending...' : d.status === 'failed' ? 'Retry' : 'Send'}
                      </button>
                    )}
                    <button onClick={() => handleDelete(d.id)} disabled={deleting === d.id}
                      className="rounded-lg p-1.5 text-gray-400 hover:bg-red-50 hover:text-red-500 disabled:opacity-50"
                      title="Delete">
                      <svg aria-hidden="true" className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
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

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="mt-4 flex items-center justify-between">
          <p className="text-xs text-gray-500">Page {page} of {totalPages}</p>
          <div className="flex gap-1">
            <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1}
              className="rounded-lg border border-gray-200 px-3 py-1.5 text-sm disabled:opacity-50">Prev</button>
            <button onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page === totalPages}
              className="rounded-lg border border-gray-200 px-3 py-1.5 text-sm disabled:opacity-50">Next</button>
          </div>
        </div>
      )}
    </div>
  );
}
