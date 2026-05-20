'use client';

import { useEffect, useState, useCallback, useMemo } from 'react';
import { useBusiness } from '@/components/dashboard/DashboardProvider';
import { createClient } from '@/lib/supabase/client';
import { exportToCsv } from '@/lib/utils/csv-export';
import { useCategoryConfig } from '@/hooks/useCategoryConfig';
import { formatCurrency, getLocale, type CountryCode } from '@/lib/constants';
import { PageHelp } from '@/components/dashboard/PageHelp';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface CustomerProfile {
  id: string;
  business_id: string;
  name: string | null;
  phone: string | null;
  email: string | null;
  total_visits: number;
  total_spent: number;
  avg_rating: number | null;
  first_seen_at: string | null;
  last_seen_at: string | null;
  tags: string[] | null;
  notes: string | null;
  lifetime_value: number | null;
  churn_risk: number | null;
  customer_segment: string | null;
}

interface BookingRecord {
  id: string;
  date: string;
  status: string;
  deposit_amount: number | null;
  guest_name: string | null;
  service_type: string | null;
}

interface OrderRecord {
  id: string;
  created_at: string;
  status: string;
  total: number | null;
}

interface LoyaltyRecord {
  id: string;
  points_balance: number;
  total_earned: number;
  total_redeemed: number;
  visit_count: number;
}

interface FeedbackRecord {
  id: string;
  rating: number;
  comment: string | null;
  created_at: string;
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function relativeTime(dateStr: string | null): string {
  if (!dateStr) return '--';
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

// formatCurrency is imported from @/lib/constants — uses business country_code

function StarRating({ rating }: { rating: number }) {
  return (
    <div className="flex gap-0.5">
      {[1, 2, 3, 4, 5].map((star) => (
        <svg
          key={star}
          className={`h-3.5 w-3.5 ${star <= rating ? 'text-yellow-400' : 'text-gray-200'}`}
          fill="currentColor"
          viewBox="0 0 20 20"
        >
          <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
        </svg>
      ))}
    </div>
  );
}

const TAG_COLORS: Record<string, string> = {
  vip: 'bg-amber-100 text-amber-700',
  loyal: 'bg-green-100 text-green-700',
  new: 'bg-blue-100 text-blue-700',
  inactive: 'bg-gray-100 text-gray-600',
  flagged: 'bg-red-100 text-red-700',
};

function tagColor(tag: string): string {
  return TAG_COLORS[tag.toLowerCase()] || 'bg-purple-100 text-purple-700';
}

/* ------------------------------------------------------------------ */
/*  Page Component                                                     */
/* ------------------------------------------------------------------ */

export default function CustomersPage() {
  const business = useBusiness();
  const supabase = useMemo(() => createClient(), []);
  const { labels } = useCategoryConfig(business.category);
  const isGiving = labels.quantityLabel === 'amount';
  const cc = (business.country_code || 'NG') as CountryCode;

  const [customers, setCustomers] = useState<CustomerProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');

  // Detail panel
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [bookings, setBookings] = useState<BookingRecord[]>([]);
  const [orders, setOrders] = useState<OrderRecord[]>([]);
  const [loyalty, setLoyalty] = useState<LoyaltyRecord | null>(null);
  const [feedback, setFeedback] = useState<FeedbackRecord[]>([]);

  // Editable fields
  const [editNotes, setEditNotes] = useState('');
  const [editTags, setEditTags] = useState('');
  const [saving, setSaving] = useState(false);

  // WhatsApp message compose
  const [waMessage, setWaMessage] = useState('');
  const [waSending, setWaSending] = useState(false);
  const [waSent, setWaSent] = useState(false);

  // Bulk selection
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const toggleSelect = (id: string) => setSelectedIds(prev => { const next = new Set(prev); next.has(id) ? next.delete(id) : next.add(id); return next; });
  const toggleAll = () => setSelectedIds(prev => prev.size === pageItems.length ? new Set() : new Set(pageItems.map(c => c.id)));
  const [bulkTag, setBulkTag] = useState('');
  const [bulkMessage, setBulkMessage] = useState('');
  const [bulkProcessing, setBulkProcessing] = useState(false);

  const isSharedNumber = !business.wa_method || business.wa_method === 'shared';

  /* ---- Fetch customers ---- */

  const fetchCustomers = useCallback(async () => {
    const { data } = await supabase
      .from('customer_profiles')
      .select('*')
      .eq('business_id', business.id)
      .order('last_seen_at', { ascending: false });
    setCustomers((data as CustomerProfile[]) || []);
    setLoading(false);
  }, [business.id]);

  useEffect(() => {
    fetchCustomers();
  }, [fetchCustomers]);

  /* ---- Search / filter ---- */

  const filtered = search
    ? customers.filter(
        (c) =>
          c.name?.toLowerCase().includes(search.toLowerCase()) ||
          c.phone?.includes(search) ||
          c.email?.toLowerCase().includes(search.toLowerCase()),
      )
    : customers;

  /* ---- Pagination ---- */
  const [page, setPage] = useState(1);
  const perPage = 20;
  const totalPages = Math.max(1, Math.ceil(filtered.length / perPage));
  const pageItems = filtered.slice((page - 1) * perPage, page * perPage);

  // Reset page on search change
  useEffect(() => { setPage(1); }, [search]);

  /* ---- Metrics ---- */

  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const totalCustomers = customers.length;
  const activeCustomers = customers.filter(
    (c) => c.last_seen_at && c.last_seen_at >= thirtyDaysAgo,
  ).length;
  const totalRevenue = customers.reduce((s, c) => s + (c.total_spent || 0), 0);
  const avgSpend = totalCustomers > 0 ? totalRevenue / totalCustomers : 0;

  /* ---- Select customer & load details ---- */

  async function selectCustomer(customer: CustomerProfile) {
    if (selectedId === customer.id) {
      setSelectedId(null);
      return;
    }

    setSelectedId(customer.id);
    setDetailLoading(true);
    setEditNotes(customer.notes || '');
    setEditTags((customer.tags || []).join(', '));
    setWaMessage('');
    setWaSent(false);

    const phone = customer.phone;

    // Fetch related data in parallel
    const [bookingsRes, ordersRes, loyaltyRes, feedbackRes] = await Promise.all([
      phone
        ? supabase
            .from('bookings')
            .select('id, date, status, deposit_amount, guest_name, service_type')
            .eq('business_id', business.id)
            .eq('guest_phone', phone)
            .order('date', { ascending: false })
            .limit(10)
        : Promise.resolve({ data: [] }),
      phone
        ? supabase
            .from('orders')
            .select('id, created_at, status, total')
            .eq('business_id', business.id)
            .eq('customer_phone', phone)
            .order('created_at', { ascending: false })
            .limit(10)
        : Promise.resolve({ data: [] }),
      phone
        ? supabase
            .from('loyalty_points')
            .select('id, points_balance, total_earned, total_redeemed, visit_count')
            .eq('business_id', business.id)
            .eq('customer_phone', phone)
            .maybeSingle()
        : Promise.resolve({ data: null }),
      phone
        ? supabase
            .from('customer_feedback')
            .select('id, rating, comment, created_at')
            .eq('business_id', business.id)
            .eq('customer_phone', phone)
            .order('created_at', { ascending: false })
            .limit(10)
        : Promise.resolve({ data: [] }),
    ]);

    setBookings((bookingsRes.data as BookingRecord[]) || []);
    setOrders((ordersRes.data as OrderRecord[]) || []);
    setLoyalty((loyaltyRes.data as LoyaltyRecord | null) || null);
    setFeedback((feedbackRes.data as FeedbackRecord[]) || []);
    setDetailLoading(false);
  }

  /* ---- Save notes & tags ---- */

  async function handleSave() {
    if (!selectedId) return;
    setSaving(true);
    const tagsArray = editTags
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);

    await supabase
      .from('customer_profiles')
      .update({ notes: editNotes || null, tags: tagsArray.length > 0 ? tagsArray : null })
      .eq('id', selectedId);

    // Update local state
    setCustomers((prev) =>
      prev.map((c) =>
        c.id === selectedId
          ? { ...c, notes: editNotes || null, tags: tagsArray.length > 0 ? tagsArray : null }
          : c,
      ),
    );
    setSaving(false);
  }

  /* ---- CSV export ---- */

  function handleExport() {
    if (filtered.length === 0) return;
    exportToCsv(
      filtered.map((c) => ({
        name: c.name || '',
        phone: c.phone || '',
        email: c.email || '',
        total_visits: c.total_visits,
        total_spent: c.total_spent,
        avg_rating: c.avg_rating ?? '',
        first_seen: c.first_seen_at || '',
        last_seen: c.last_seen_at || '',
        tags: (c.tags || []).join('; '),
      })),
      `${business.name}-customers`,
      [
        { key: 'name', label: 'Name' },
        { key: 'phone', label: 'Phone' },
        { key: 'email', label: 'Email' },
        { key: 'total_visits', label: isGiving ? 'Total Givings' : 'Total Visits' },
        { key: 'total_spent', label: isGiving ? 'Total Given' : 'Total Spent' },
        { key: 'avg_rating', label: 'Avg Rating' },
        { key: 'first_seen', label: 'First Seen' },
        { key: 'last_seen', label: 'Last Seen' },
        { key: 'tags', label: 'Tags' },
      ],
    );
  }

  /* ---- Selected customer object ---- */

  const selected = customers.find((c) => c.id === selectedId) || null;

  /* ---------------------------------------------------------------- */
  /*  Render                                                           */
  /* ---------------------------------------------------------------- */

  return (
    <div>
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">{labels.personLabelPlural}</h1>
          <p className="mt-1 text-sm text-gray-500">
            {totalCustomers} {labels.personLabel.toLowerCase()} profile{totalCustomers !== 1 ? 's' : ''} across all channels.
          </p>
        </div>
        {filtered.length > 0 && (
          <button
            onClick={handleExport}
            className="rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-50"
          >
            Export CSV
          </button>
        )}
      </div>

      <PageHelp
        pageKey="customers"
        title="Your Customers"
        description="Everyone who has interacted with your WhatsApp bot. See their booking history, total spending, and loyalty status. You can tag customers and send them broadcasts."
      />

      {/* Metrics Row */}
      <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-xl border border-gray-100 bg-white p-5">
          <p className="text-xs font-medium text-gray-500">Total {labels.personLabelPlural}</p>
          <p className="mt-2 text-2xl font-bold text-gray-900">{totalCustomers}</p>
        </div>
        <div className="rounded-xl border border-gray-100 bg-white p-5">
          <p className="text-xs font-medium text-gray-500">Active (30 days)</p>
          <p className="mt-2 text-2xl font-bold text-green-600">{activeCustomers}</p>
          <p className="mt-1 text-xs text-gray-400">
            {totalCustomers > 0 ? Math.round((activeCustomers / totalCustomers) * 100) : 0}% of
            total
          </p>
        </div>
        <div className="rounded-xl border border-gray-100 bg-white p-5">
          <p className="text-xs font-medium text-gray-500">{isGiving ? 'Total Received' : 'Total Revenue'}</p>
          <p className="mt-2 text-2xl font-bold text-gray-900">{formatCurrency(totalRevenue, cc)}</p>
        </div>
        <div className="rounded-xl border border-gray-100 bg-white p-5">
          <p className="text-xs font-medium text-gray-500">{isGiving ? `Avg Giving / ${labels.personLabel}` : `Avg Spend / ${labels.personLabel}`}</p>
          <p className="mt-2 text-2xl font-bold text-gray-900">{formatCurrency(Math.round(avgSpend), cc)}</p>
        </div>
      </div>

      {/* Search */}
      <div className="mt-6">
        <input
          type="text"
          placeholder="Search by name or phone..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full max-w-sm rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand"
        />
      </div>

      {/* Customer Table */}
      {loading ? (
        <div className="mt-8 flex justify-center">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-brand border-t-transparent" />
        </div>
      ) : filtered.length === 0 ? (
        <div className="mt-8 rounded-xl border border-dashed border-gray-200 p-12 text-center">
          <svg
            className="mx-auto h-12 w-12 text-gray-300"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.5}
              d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z"
            />
          </svg>
          <p className="mt-3 text-sm text-gray-400">
            {search
              ? `No ${labels.personLabelPlural.toLowerCase()} match your search.`
              : `No ${labels.personLabel.toLowerCase()} profiles yet. They will appear after their first interaction.`}
          </p>
        </div>
      ) : (
        <div className="mt-4 overflow-x-auto rounded-xl border border-gray-100 bg-white">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-50 bg-gray-50/50">
                <th scope="col" className="px-4 py-3"><input type="checkbox" checked={selectedIds.size === pageItems.length && pageItems.length > 0} onChange={toggleAll} className="h-4 w-4 rounded border-gray-300" /></th>
                <th scope="col" className="px-4 py-3 text-left font-medium text-gray-500">{labels.personLabel}</th>
                <th scope="col" className="px-4 py-3 text-left font-medium text-gray-500">{isGiving ? 'Total Givings' : 'Total Visits'}</th>
                <th scope="col" className="px-4 py-3 text-left font-medium text-gray-500">{isGiving ? 'Total Given' : 'Total Spent'}</th>
                <th scope="col" className="px-4 py-3 text-left font-medium text-gray-500">Avg Rating</th>
                <th scope="col" className="px-4 py-3 text-left font-medium text-gray-500">Last Seen</th>
                <th scope="col" className="px-4 py-3 text-left font-medium text-gray-500">Segment</th>
                <th scope="col" className="px-4 py-3 text-left font-medium text-gray-500">Tags</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {pageItems.map((c) => (
                <tr
                  key={c.id}
                  className={`cursor-pointer hover:bg-gray-50/50 ${
                    selectedIds.has(c.id) ? 'bg-brand-50/30' : selectedId === c.id ? 'bg-brand-50/20' : ''
                  }`}
                  onClick={() => selectCustomer(c)}
                >
                  <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}><input type="checkbox" checked={selectedIds.has(c.id)} onChange={() => toggleSelect(c.id)} className="h-4 w-4 rounded border-gray-300" /></td>
                  {/* Customer name + avatar + phone */}
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-50 text-xs font-bold text-brand">
                        {(c.name || c.phone || '?').charAt(0).toUpperCase()}
                      </div>
                      <div className="min-w-0">
                        <p className="truncate font-medium text-gray-900">
                          {c.name || 'Unknown'}
                        </p>
                        {c.phone && (
                          <p className="truncate text-xs text-gray-400">{c.phone}</p>
                        )}
                      </div>
                    </div>
                  </td>

                  {/* Total Visits */}
                  <td className="px-4 py-3">
                    <span className="inline-flex items-center rounded-full bg-brand-50 px-2 py-0.5 text-xs font-medium text-brand">
                      {c.total_visits}
                    </span>
                  </td>

                  {/* Total Spent */}
                  <td className="px-4 py-3 text-gray-600">
                    {c.total_spent > 0 ? formatCurrency(c.total_spent, cc) : '\u2014'}
                  </td>

                  {/* Avg Rating */}
                  <td className="px-4 py-3">
                    {c.avg_rating != null && c.avg_rating > 0 ? (
                      <div className="flex items-center gap-1.5">
                        <StarRating rating={Math.round(c.avg_rating)} />
                        <span className="text-xs text-gray-500">
                          {c.avg_rating.toFixed(1)}
                        </span>
                      </div>
                    ) : (
                      <span className="text-xs text-gray-300">&mdash;</span>
                    )}
                  </td>

                  {/* Last Seen */}
                  <td className="px-4 py-3 text-gray-500">
                    {relativeTime(c.last_seen_at)}
                  </td>

                  {/* Segment */}
                  <td className="px-4 py-3">
                    {c.customer_segment ? (
                      <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${
                        c.customer_segment === 'loyal' ? 'bg-green-50 text-green-700' :
                        c.customer_segment === 'returning' ? 'bg-blue-50 text-blue-700' :
                        c.customer_segment === 'at_risk' ? 'bg-yellow-50 text-yellow-700' :
                        c.customer_segment === 'churned' ? 'bg-red-50 text-red-700' :
                        'bg-gray-50 text-gray-600'
                      }`}>
                        {c.customer_segment === 'at_risk' ? 'At Risk' : c.customer_segment.charAt(0).toUpperCase() + c.customer_segment.slice(1)}
                      </span>
                    ) : (
                      <span className="text-xs text-gray-300">&mdash;</span>
                    )}
                  </td>

                  {/* Tags */}
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-1">
                      {(c.tags || []).map((tag) => (
                        <span
                          key={tag}
                          className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${tagColor(tag)}`}
                        >
                          {tag}
                        </span>
                      ))}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Bulk Action Bar */}
      {selectedIds.size > 0 && (
        <div className="mt-4 flex flex-wrap items-center gap-3 rounded-xl border border-brand/20 bg-brand-50 p-3">
          <span className="text-sm font-medium text-gray-700">{selectedIds.size} selected</span>
          <div className="flex items-center gap-2">
            <input
              type="text"
              placeholder="Tag name..."
              value={bulkTag}
              onChange={(e) => setBulkTag(e.target.value)}
              className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs outline-none focus:border-brand"
            />
            <button
              disabled={!bulkTag || bulkProcessing}
              onClick={async () => {
                setBulkProcessing(true);
                for (const id of selectedIds) {
                  const customer = customers.find(c => c.id === id);
                  if (customer) {
                    const tags = [...(customer.tags || [])];
                    if (!tags.includes(bulkTag)) tags.push(bulkTag);
                    await supabase.from('customer_profiles').update({ tags }).eq('id', id);
                  }
                }
                setBulkProcessing(false);
                setBulkTag('');
                setSelectedIds(new Set());
                fetchCustomers();
              }}
              className="rounded-lg bg-brand px-3 py-1.5 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50"
            >
              Add Tag
            </button>
          </div>
          <div className="flex items-center gap-2">
            <input
              type="text"
              placeholder="Message..."
              value={bulkMessage}
              onChange={(e) => setBulkMessage(e.target.value)}
              className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs outline-none focus:border-brand sm:w-48"
            />
            <button
              disabled={!bulkMessage || bulkProcessing}
              onClick={async () => {
                setBulkProcessing(true);
                for (const id of selectedIds) {
                  const customer = customers.find(c => c.id === id);
                  if (customer?.phone) {
                    await fetch('/api/chat/send', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ businessId: business.id, to: customer.phone, message: bulkMessage }),
                    });
                  }
                }
                setBulkProcessing(false);
                setBulkMessage('');
                setSelectedIds(new Set());
              }}
              className="rounded-lg bg-whatsapp px-3 py-1.5 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50"
            >
              Send WhatsApp
            </button>
          </div>
          <button onClick={() => setSelectedIds(new Set())} className="text-xs text-gray-500 hover:text-gray-700">Clear</button>
        </div>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="mt-4 flex items-center justify-between text-sm">
          <button
            onClick={() => setPage(p => Math.max(1, p - 1))}
            disabled={page === 1}
            className="rounded-lg border border-gray-300 px-3 py-1.5 text-gray-600 transition hover:bg-gray-50 disabled:opacity-50"
          >
            Previous
          </button>
          <span className="text-gray-500">Page {page} of {totalPages}</span>
          <button
            onClick={() => setPage(p => Math.min(totalPages, p + 1))}
            disabled={page === totalPages}
            className="rounded-lg border border-gray-300 px-3 py-1.5 text-gray-600 transition hover:bg-gray-50 disabled:opacity-50"
          >
            Next
          </button>
        </div>
      )}

      {/* Detail Drawer */}
      {selected && (
        <div className="fixed inset-y-0 right-0 z-50 flex">
          <div className="fixed inset-0 bg-black/20" onClick={() => setSelectedId(null)} />
          <div className="relative ml-auto flex w-full max-w-lg flex-col bg-white shadow-xl">
            {/* Drawer header */}
            <div className="flex items-center justify-between border-b border-gray-100 px-6 py-4">
              <h2 className="text-lg font-bold text-gray-900">{labels.personLabel} Details</h2>
              <button
                onClick={() => setSelectedId(null)}
                className="text-gray-400 hover:text-gray-600"
              >
                <svg aria-hidden="true" className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M6 18L18 6M6 6l12 12"
                  />
                </svg>
              </button>
            </div>

            {/* Drawer body */}
            <div className="flex-1 overflow-y-auto p-6">
              {detailLoading ? (
                <div className="flex justify-center py-12">
                  <div className="h-8 w-8 animate-spin rounded-full border-2 border-brand border-t-transparent" />
                </div>
              ) : (
                <>
                  {/* Profile header */}
                  <div className="flex items-center gap-4">
                    <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-brand-50 text-xl font-bold text-brand">
                      {(selected.name || selected.phone || '?').charAt(0).toUpperCase()}
                    </div>
                    <div className="min-w-0">
                      <p className="text-lg font-semibold text-gray-900">
                        {selected.name || 'Unknown'}
                      </p>
                      {selected.phone && (
                        <p className="text-sm text-gray-500">{selected.phone}</p>
                      )}
                      {selected.email && (
                        <p className="text-sm text-gray-500">{selected.email}</p>
                      )}
                    </div>
                  </div>

                  {/* Quick stats */}
                  <div className="mt-6 grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div className="rounded-lg bg-gray-50 p-3">
                      <p className="text-xs text-gray-500">First Seen</p>
                      <p className="mt-1 text-sm font-medium text-gray-900">
                        {selected.first_seen_at
                          ? new Date(selected.first_seen_at).toLocaleDateString(getLocale((business.country_code || 'NG') as CountryCode), {
                              day: 'numeric',
                              month: 'short',
                              year: 'numeric',
                            })
                          : '--'}
                      </p>
                    </div>
                    <div className="rounded-lg bg-gray-50 p-3">
                      <p className="text-xs text-gray-500">Last Seen</p>
                      <p className="mt-1 text-sm font-medium text-gray-900">
                        {selected.last_seen_at
                          ? new Date(selected.last_seen_at).toLocaleDateString(getLocale((business.country_code || 'NG') as CountryCode), {
                              day: 'numeric',
                              month: 'short',
                              year: 'numeric',
                            })
                          : '--'}
                      </p>
                    </div>
                    <div className="rounded-lg bg-gray-50 p-3">
                      <p className="text-xs text-gray-500">{isGiving ? 'Total Givings' : 'Total Visits'}</p>
                      <p className="mt-1 text-xl font-bold text-gray-900">
                        {selected.total_visits}
                      </p>
                    </div>
                    <div className="rounded-lg bg-gray-50 p-3">
                      <p className="text-xs text-gray-500">{isGiving ? 'Total Given' : 'Total Spent'}</p>
                      <p className="mt-1 text-xl font-bold text-gray-900">
                        {selected.total_spent > 0 ? formatCurrency(selected.total_spent, cc) : '\u2014'}
                      </p>
                    </div>
                  </div>

                  {/* Customer Intelligence */}
                  {(selected.lifetime_value || selected.churn_risk != null || selected.customer_segment) && (
                    <div className="mt-4 grid grid-cols-1 sm:grid-cols-3 gap-3">
                      <div className="rounded-lg bg-brand-50 p-3">
                        <p className="text-xs text-brand">Lifetime Value</p>
                        <p className="mt-1 text-lg font-bold text-brand">
                          {selected.lifetime_value ? formatCurrency(selected.lifetime_value, cc) : '\u2014'}
                        </p>
                      </div>
                      <div className={`rounded-lg p-3 ${
                        (selected.churn_risk || 0) >= 50 ? 'bg-red-50' :
                        (selected.churn_risk || 0) >= 20 ? 'bg-yellow-50' : 'bg-green-50'
                      }`}>
                        <p className={`text-xs ${
                          (selected.churn_risk || 0) >= 50 ? 'text-red-600' :
                          (selected.churn_risk || 0) >= 20 ? 'text-yellow-600' : 'text-green-600'
                        }`}>Churn Risk</p>
                        <p className={`mt-1 text-lg font-bold ${
                          (selected.churn_risk || 0) >= 50 ? 'text-red-700' :
                          (selected.churn_risk || 0) >= 20 ? 'text-yellow-700' : 'text-green-700'
                        }`}>
                          {selected.churn_risk != null ? `${selected.churn_risk}%` : '\u2014'}
                        </p>
                      </div>
                      <div className="rounded-lg bg-gray-50 p-3">
                        <p className="text-xs text-gray-500">Segment</p>
                        <p className="mt-1 text-sm font-bold text-gray-900">
                          {selected.customer_segment
                            ? selected.customer_segment === 'at_risk' ? 'At Risk' : selected.customer_segment.charAt(0).toUpperCase() + selected.customer_segment.slice(1)
                            : '\u2014'}
                        </p>
                      </div>
                    </div>
                  )}

                  {/* Loyalty Points */}
                  {loyalty && (
                    <div className="mt-6">
                      <h3 className="text-sm font-semibold text-gray-900">Loyalty Points</h3>
                      <div className="mt-2 grid grid-cols-1 sm:grid-cols-3 gap-3">
                        <div className="rounded-lg bg-green-50 p-3">
                          <p className="text-xs text-green-600">Balance</p>
                          <p className="mt-1 text-lg font-bold text-green-700">
                            {loyalty.points_balance}
                          </p>
                        </div>
                        <div className="rounded-lg bg-blue-50 p-3">
                          <p className="text-xs text-blue-600">Earned</p>
                          <p className="mt-1 text-lg font-bold text-blue-700">
                            {loyalty.total_earned}
                          </p>
                        </div>
                        <div className="rounded-lg bg-purple-50 p-3">
                          <p className="text-xs text-purple-600">Redeemed</p>
                          <p className="mt-1 text-lg font-bold text-purple-700">
                            {loyalty.total_redeemed}
                          </p>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Booking / Giving History */}
                  <div className="mt-6">
                    <h3 className="text-sm font-semibold text-gray-900">History</h3>
                    {bookings.length === 0 ? (
                      <p className="mt-2 text-xs text-gray-400">No records found.</p>
                    ) : (
                      <div className="mt-2 space-y-2">
                        {bookings.map((b) => (
                          <div
                            key={b.id}
                            className="flex items-center justify-between rounded-lg border border-gray-100 px-3 py-2"
                          >
                            <div className="min-w-0">
                              <p className="truncate text-sm font-medium text-gray-900">
                                {b.service_type || 'Booking'}
                              </p>
                              <p className="text-xs text-gray-400">{b.date}</p>
                            </div>
                            <div className="ml-3 flex shrink-0 items-center gap-2">
                              {b.deposit_amount != null && b.deposit_amount > 0 && (
                                <span className="text-xs font-medium text-gray-600">
                                  {formatCurrency(b.deposit_amount, cc)}
                                </span>
                              )}
                              <span
                                className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${
                                  b.status === 'completed'
                                    ? 'bg-green-50 text-green-700'
                                    : b.status === 'cancelled'
                                      ? 'bg-red-50 text-red-700'
                                      : 'bg-yellow-50 text-yellow-700'
                                }`}
                              >
                                {b.status}
                              </span>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Order History */}
                  <div className="mt-6">
                    <h3 className="text-sm font-semibold text-gray-900">Order History</h3>
                    {orders.length === 0 ? (
                      <p className="mt-2 text-xs text-gray-400">No orders found.</p>
                    ) : (
                      <div className="mt-2 space-y-2">
                        {orders.map((o) => (
                          <div
                            key={o.id}
                            className="flex items-center justify-between rounded-lg border border-gray-100 px-3 py-2"
                          >
                            <div className="min-w-0">
                              <p className="truncate text-sm font-medium text-gray-900">
                                Order
                              </p>
                              <p className="text-xs text-gray-400">
                                {new Date(o.created_at).toLocaleDateString(getLocale((business.country_code || 'NG') as CountryCode), {
                                  day: 'numeric',
                                  month: 'short',
                                  year: 'numeric',
                                })}
                              </p>
                            </div>
                            <div className="ml-3 flex shrink-0 items-center gap-2">
                              {o.total != null && o.total > 0 && (
                                <span className="text-xs font-medium text-gray-600">
                                  {formatCurrency(o.total, cc)}
                                </span>
                              )}
                              <span
                                className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${
                                  o.status === 'completed' || o.status === 'delivered'
                                    ? 'bg-green-50 text-green-700'
                                    : o.status === 'cancelled'
                                      ? 'bg-red-50 text-red-700'
                                      : 'bg-yellow-50 text-yellow-700'
                                }`}
                              >
                                {o.status}
                              </span>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Feedback */}
                  <div className="mt-6">
                    <h3 className="text-sm font-semibold text-gray-900">Feedback</h3>
                    {feedback.length === 0 ? (
                      <p className="mt-2 text-xs text-gray-400">No feedback yet.</p>
                    ) : (
                      <div className="mt-2 space-y-2">
                        {feedback.map((f) => (
                          <div
                            key={f.id}
                            className="rounded-lg border border-gray-100 px-3 py-2"
                          >
                            <div className="flex items-center justify-between">
                              <StarRating rating={f.rating} />
                              <span className="text-xs text-gray-400">
                                {new Date(f.created_at).toLocaleDateString(getLocale((business.country_code || 'NG') as CountryCode), {
                                  day: 'numeric',
                                  month: 'short',
                                })}
                              </span>
                            </div>
                            {f.comment && (
                              <p className="mt-1 text-xs text-gray-600">{f.comment}</p>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Editable Tags */}
                  <div className="mt-6">
                    <label className="block text-sm font-semibold text-gray-900">Tags</label>
                    <input
                      type="text"
                      value={editTags}
                      onChange={(e) => setEditTags(e.target.value)}
                      placeholder="vip, loyal, new (comma-separated)"
                      className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand"
                    />
                  </div>

                  {/* Editable Notes */}
                  <div className="mt-4">
                    <label className="block text-sm font-semibold text-gray-900">Notes</label>
                    <textarea
                      value={editNotes}
                      onChange={(e) => setEditNotes(e.target.value)}
                      rows={3}
                      placeholder="Add internal notes about this customer..."
                      className="mt-1 w-full resize-none rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand"
                    />
                  </div>

                  {/* Save button */}
                  <button
                    onClick={handleSave}
                    disabled={saving}
                    className="mt-4 w-full rounded-lg bg-brand px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-600 disabled:opacity-50"
                  >
                    {saving ? 'Saving...' : 'Save Changes'}
                  </button>

                  {/* WhatsApp messaging */}
                  {selected.phone && (
                    isSharedNumber ? (
                      <div className="mt-3">
                        <textarea
                          value={waMessage}
                          onChange={(e) => { setWaMessage(e.target.value); setWaSent(false); }}
                          rows={2}
                          placeholder="Type a message to send via WhatsApp..."
                          className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-green-500"
                        />
                        {waSent && <p className="mt-1 text-xs text-green-600">Message sent!</p>}
                        <button
                          onClick={async () => {
                            if (!waMessage.trim()) return;
                            setWaSending(true);
                            setWaSent(false);
                            try {
                              const res = await fetch('/api/chat/send', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({
                                  businessId: business.id,
                                  customerPhone: selected.phone,
                                  messageText: waMessage.trim(),
                                }),
                              });
                              if (res.ok) {
                                setWaSent(true);
                                setWaMessage('');
                              }
                            } catch {
                              // ignore
                            }
                            setWaSending(false);
                          }}
                          disabled={waSending || !waMessage.trim()}
                          className="mt-2 flex w-full items-center justify-center gap-2 rounded-lg bg-green-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-green-700 disabled:opacity-50"
                        >
                          <svg aria-hidden="true" className="h-4 w-4" viewBox="0 0 24 24" fill="currentColor">
                            <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z" />
                          </svg>
                          {waSending ? 'Sending...' : 'Send via WhatsApp'}
                        </button>
                      </div>
                    ) : (
                      <a
                        href={`https://wa.me/${selected.phone.replace(/\D/g, '')}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="mt-3 flex w-full items-center justify-center gap-2 rounded-lg bg-green-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-green-700"
                      >
                        <svg aria-hidden="true" className="h-4 w-4" viewBox="0 0 24 24" fill="currentColor">
                          <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z" />
                        </svg>
                        Message on WhatsApp
                      </a>
                    )
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
