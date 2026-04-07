'use client';

import { useEffect, useState } from 'react';
import { useBusiness } from '@/components/dashboard/DashboardProvider';
import { createClient } from '@/lib/supabase/client';

interface Report {
  id: string;
  customer_phone: string;
  customer_name: string | null;
  title: string;
  file_path: string;
  file_url: string | null;
  status: string;
  sent_at: string | null;
  created_at: string;
}

export default function ReportsPage() {
  const business = useBusiness();
  const [reports, setReports] = useState<Report[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [sending, setSending] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkSending, setBulkSending] = useState(false);

  // Upload form state
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState('');
  const [customerPhone, setCustomerPhone] = useState('');
  const [customerName, setCustomerName] = useState('');

  async function fetchReports() {
    const supabase = createClient();
    const { data } = await supabase
      .from('customer_reports')
      .select('*')
      .eq('business_id', business.id)
      .order('created_at', { ascending: false });
    setReports((data as Report[]) || []);
    setLoading(false);
  }

  useEffect(() => { fetchReports(); }, [business.id]);

  async function handleUpload() {
    if (!file || !title || !customerPhone) return;
    setUploading(true);

    try {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('title', title);
      formData.append('customerPhone', customerPhone);
      formData.append('customerName', customerName);
      formData.append('businessId', business.id);

      const res = await fetch('/api/reports/upload', {
        method: 'POST',
        body: formData,
      });

      if (res.ok) {
        setFile(null);
        setTitle('');
        setCustomerPhone('');
        setCustomerName('');
        fetchReports();
      }
    } finally {
      setUploading(false);
    }
  }

  async function handleSend(reportId: string) {
    setSending(reportId);
    try {
      const res = await fetch('/api/reports/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reportIds: [reportId] }),
      });
      if (res.ok) fetchReports();
    } finally {
      setSending(null);
    }
  }

  async function handleBulkSend() {
    if (selectedIds.size === 0) return;
    setBulkSending(true);
    try {
      const res = await fetch('/api/reports/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reportIds: Array.from(selectedIds) }),
      });
      if (res.ok) {
        setSelectedIds(new Set());
        fetchReports();
      }
    } finally {
      setBulkSending(false);
    }
  }

  function toggleSelect(id: string) {
    const next = new Set(selectedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelectedIds(next);
  }

  function toggleSelectAll() {
    const pending = reports.filter(r => r.status === 'pending');
    if (selectedIds.size === pending.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(pending.map(r => r.id)));
    }
  }

  const pendingCount = reports.filter(r => r.status === 'pending').length;

  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-900">Reports</h1>
      <p className="mt-1 text-sm text-gray-500">
        Upload PDF reports and send them to customers via WhatsApp.
      </p>

      {/* Upload Section */}
      <div className="mt-6 rounded-xl border border-gray-200 bg-white p-6">
        <h2 className="text-sm font-semibold text-gray-900">Upload New Report</h2>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div>
            <label className="block text-xs font-medium text-gray-600">Report Title *</label>
            <input
              type="text"
              value={title}
              onChange={e => setTitle(e.target.value)}
              placeholder="e.g., Lab Results - March 2026"
              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600">Customer Phone (WhatsApp) *</label>
            <input
              type="text"
              value={customerPhone}
              onChange={e => setCustomerPhone(e.target.value)}
              placeholder="e.g., +2348012345678"
              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600">Customer Name</label>
            <input
              type="text"
              value={customerName}
              onChange={e => setCustomerName(e.target.value)}
              placeholder="Optional"
              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600">PDF File *</label>
            <input
              type="file"
              accept="application/pdf"
              onChange={e => setFile(e.target.files?.[0] || null)}
              className="mt-1 w-full text-sm text-gray-500 file:mr-3 file:rounded-lg file:border-0 file:bg-brand-50 file:px-4 file:py-2 file:text-sm file:font-medium file:text-brand hover:file:bg-brand-100"
            />
          </div>
        </div>
        <button
          onClick={handleUpload}
          disabled={uploading || !file || !title || !customerPhone}
          className="mt-4 rounded-lg bg-brand px-5 py-2 text-sm font-semibold text-white hover:bg-brand-600 disabled:opacity-50"
        >
          {uploading ? 'Uploading...' : 'Upload Report'}
        </button>
      </div>

      {/* Bulk Actions */}
      {selectedIds.size > 0 && (
        <div className="mt-4 flex items-center gap-3 rounded-lg bg-brand-50 px-4 py-3">
          <span className="text-sm font-medium text-brand">{selectedIds.size} selected</span>
          <button
            onClick={handleBulkSend}
            disabled={bulkSending}
            className="rounded-lg bg-brand px-4 py-1.5 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-50"
          >
            {bulkSending ? 'Sending...' : 'Send All via WhatsApp'}
          </button>
          <button
            onClick={() => setSelectedIds(new Set())}
            className="text-sm text-gray-500 hover:text-gray-700"
          >
            Clear
          </button>
        </div>
      )}

      {/* Reports Table */}
      <div className="mt-6 overflow-x-auto rounded-xl border border-gray-200 bg-white">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-gray-100 bg-gray-50/50">
            <tr>
              <th className="px-4 py-3">
                {pendingCount > 0 && (
                  <input
                    type="checkbox"
                    checked={selectedIds.size === pendingCount && pendingCount > 0}
                    onChange={toggleSelectAll}
                    className="rounded border-gray-300"
                  />
                )}
              </th>
              <th className="px-4 py-3 text-xs font-semibold text-gray-500">Title</th>
              <th className="px-4 py-3 text-xs font-semibold text-gray-500">Customer</th>
              <th className="px-4 py-3 text-xs font-semibold text-gray-500">Phone</th>
              <th className="px-4 py-3 text-xs font-semibold text-gray-500">Status</th>
              <th className="px-4 py-3 text-xs font-semibold text-gray-500">Uploaded</th>
              <th className="px-4 py-3 text-xs font-semibold text-gray-500">Sent</th>
              <th className="px-4 py-3 text-xs font-semibold text-gray-500">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {loading ? (
              <tr><td colSpan={8} className="px-4 py-8 text-center text-gray-400">Loading...</td></tr>
            ) : reports.length === 0 ? (
              <tr><td colSpan={8} className="px-4 py-8 text-center text-gray-400">No reports yet. Upload your first report above.</td></tr>
            ) : reports.map(r => (
              <tr key={r.id} className="hover:bg-gray-50/50">
                <td className="px-4 py-3">
                  {r.status === 'pending' && (
                    <input
                      type="checkbox"
                      checked={selectedIds.has(r.id)}
                      onChange={() => toggleSelect(r.id)}
                      className="rounded border-gray-300"
                    />
                  )}
                </td>
                <td className="px-4 py-3 font-medium text-gray-900">{r.title}</td>
                <td className="px-4 py-3 text-gray-600">{r.customer_name || '-'}</td>
                <td className="px-4 py-3 text-gray-600">{r.customer_phone}</td>
                <td className="px-4 py-3">
                  <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${
                    r.status === 'sent' ? 'bg-green-50 text-green-700' :
                    r.status === 'failed' ? 'bg-red-50 text-red-700' :
                    'bg-yellow-50 text-yellow-700'
                  }`}>
                    {r.status}
                  </span>
                </td>
                <td className="px-4 py-3 text-gray-500">
                  {new Date(r.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                </td>
                <td className="px-4 py-3 text-gray-500">
                  {r.sent_at ? new Date(r.sent_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '-'}
                </td>
                <td className="px-4 py-3">
                  {r.status === 'pending' && (
                    <button
                      onClick={() => handleSend(r.id)}
                      disabled={sending === r.id}
                      className="rounded-lg bg-green-600 px-3 py-1 text-xs font-medium text-white hover:bg-green-700 disabled:opacity-50"
                    >
                      {sending === r.id ? 'Sending...' : 'Send via WhatsApp'}
                    </button>
                  )}
                  {r.status === 'failed' && (
                    <button
                      onClick={() => handleSend(r.id)}
                      disabled={sending === r.id}
                      className="rounded-lg bg-orange-500 px-3 py-1 text-xs font-medium text-white hover:bg-orange-600 disabled:opacity-50"
                    >
                      {sending === r.id ? 'Retrying...' : 'Retry'}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
