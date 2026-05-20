'use client';

import { useEffect, useState } from 'react';
import { getLocale, type CountryCode } from '@/lib/constants';
import { useBusiness } from '@/components/dashboard/DashboardProvider';
import { createClient } from '@/lib/supabase/client';
import { useCategoryConfig } from '@/hooks/useCategoryConfig';

interface Guest {
  guest_phone: string;
  guest_name: string | null;
  guest_email: string | null;
  booking_count: number;
  total_spent: number;
  last_visit: string;
  first_visit: string;
  statuses: string[];
}

type SortKey = 'booking_count' | 'total_spent' | 'last_visit' | 'guest_name';

export default function GuestsPage() {
  const business = useBusiness();
  const { labels } = useCategoryConfig(business.category);
  const [guests, setGuests] = useState<Guest[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [sortBy, setSortBy] = useState<SortKey>('booking_count');
  const [selectedGuest, setSelectedGuest] = useState<Guest | null>(null);

  // WhatsApp message compose
  const [waMessage, setWaMessage] = useState('');
  const [waSending, setWaSending] = useState(false);
  const [waSent, setWaSent] = useState(false);

  const isSharedNumber = !business.wa_method || business.wa_method === 'shared';

  useEffect(() => {
    async function load() {
      const supabase = createClient();
      const { data } = await supabase
        .from('bookings')
        .select('guest_phone, guest_name, guest_email, date, status, deposit_amount')
        .eq('business_id', business.id)
        .not('guest_phone', 'is', null)
        .order('date', { ascending: false });

      const map = new Map<string, Guest>();
      for (const row of data || []) {
        if (!row.guest_phone) continue;
        const existing = map.get(row.guest_phone);
        if (existing) {
          existing.booking_count++;
          existing.total_spent += row.deposit_amount || 0;
          if (!existing.guest_name && row.guest_name) existing.guest_name = row.guest_name;
          if (!existing.guest_email && row.guest_email) existing.guest_email = row.guest_email;
          if (row.date < existing.first_visit) existing.first_visit = row.date;
          if (!existing.statuses.includes(row.status)) existing.statuses.push(row.status);
        } else {
          map.set(row.guest_phone, {
            guest_phone: row.guest_phone,
            guest_name: row.guest_name,
            guest_email: row.guest_email,
            booking_count: 1,
            total_spent: row.deposit_amount || 0,
            last_visit: row.date,
            first_visit: row.date,
            statuses: [row.status],
          });
        }
      }

      setGuests(Array.from(map.values()));
      setLoading(false);
    }
    load();
  }, [business.id]);

  const filtered = search
    ? guests.filter(
        (g) =>
          g.guest_name?.toLowerCase().includes(search.toLowerCase()) ||
          g.guest_phone.includes(search) ||
          g.guest_email?.toLowerCase().includes(search.toLowerCase()),
      )
    : guests;

  const sorted = [...filtered].sort((a, b) => {
    if (sortBy === 'booking_count') return b.booking_count - a.booking_count;
    if (sortBy === 'total_spent') return b.total_spent - a.total_spent;
    if (sortBy === 'last_visit') return b.last_visit.localeCompare(a.last_visit);
    if (sortBy === 'guest_name') return (a.guest_name || 'zzz').localeCompare(b.guest_name || 'zzz');
    return 0;
  });

  const totalSpent = guests.reduce((s, g) => s + g.total_spent, 0);
  const repeatGuests = guests.filter((g) => g.booking_count > 1).length;
  const avgBookings = guests.length > 0 ? (guests.reduce((s, g) => s + g.booking_count, 0) / guests.length).toFixed(1) : '0';

  function exportCSV() {
    const rows = [
      ['Name', 'Phone', 'Email', labels.entityNamePlural.charAt(0).toUpperCase() + labels.entityNamePlural.slice(1), 'Total Spent', 'First Visit', 'Last Visit'],
      ...sorted.map((g) => [
        g.guest_name || '',
        g.guest_phone,
        g.guest_email || '',
        g.booking_count.toString(),
        g.total_spent.toString(),
        g.first_visit,
        g.last_visit,
      ]),
    ];
    const csv = rows.map((r) => r.map((c) => `"${c}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${business.name}-${labels.personLabelPlural.toLowerCase()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function formatDate(d: string) {
    return new Date(d + 'T00:00').toLocaleDateString(getLocale((business.country_code || 'NG') as CountryCode), { day: 'numeric', month: 'short', year: 'numeric' });
  }

  return (
    <div>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">{labels.personLabelPlural}</h1>
          <p className="mt-1 text-sm text-gray-500">
            {guests.length} unique {labels.personLabelPlural.toLowerCase()} from WhatsApp {labels.entityNamePlural}
          </p>
        </div>
        {guests.length > 0 && (
          <button
            onClick={exportCSV}
            className="rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-50"
          >
            Export CSV
          </button>
        )}
      </div>

      {/* Stats Cards */}
      <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-xl border border-gray-100 bg-white p-5">
          <p className="text-xs font-medium text-gray-500">Total {labels.personLabelPlural}</p>
          <p className="mt-2 text-2xl font-bold text-gray-900">{guests.length}</p>
        </div>
        <div className="rounded-xl border border-gray-100 bg-white p-5">
          <p className="text-xs font-medium text-gray-500">Repeat {labels.personLabelPlural}</p>
          <p className="mt-2 text-2xl font-bold text-gray-900">{repeatGuests}</p>
          <p className="mt-1 text-xs text-gray-400">
            {guests.length > 0 ? Math.round((repeatGuests / guests.length) * 100) : 0}% return rate
          </p>
        </div>
        <div className="rounded-xl border border-gray-100 bg-white p-5">
          <p className="text-xs font-medium text-gray-500">Avg {labels.entityNamePlural}/{labels.personLabel}</p>
          <p className="mt-2 text-2xl font-bold text-gray-900">{avgBookings}</p>
        </div>
        <div className="rounded-xl border border-gray-100 bg-white p-5">
          <p className="text-xs font-medium text-gray-500">Total Revenue</p>
          <p className="mt-2 text-2xl font-bold text-gray-900">
            {new Intl.NumberFormat(getLocale((business.country_code || 'NG') as CountryCode), { style: 'currency', currency: 'NGN', minimumFractionDigits: 0 }).format(totalSpent)}
          </p>
        </div>
      </div>

      {/* Search + Sort */}
      <div className="mt-6 flex flex-wrap items-center gap-3">
        <input
          type="text"
          placeholder="Search name, phone, or email..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full max-w-sm rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand"
        />
        <select
          value={sortBy}
          onChange={(e) => setSortBy(e.target.value as SortKey)}
          className="rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand"
        >
          <option value="booking_count">Most {labels.entityNamePlural}</option>
          <option value="total_spent">Highest spend</option>
          <option value="last_visit">Most recent</option>
          <option value="guest_name">Name A-Z</option>
        </select>
      </div>

      {loading ? (
        <div className="mt-8 flex justify-center">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-brand border-t-transparent" />
        </div>
      ) : sorted.length === 0 ? (
        <div className="mt-8 rounded-xl border border-dashed border-gray-200 p-12 text-center">
          <svg aria-hidden="true" className="mx-auto h-12 w-12 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" />
          </svg>
          <p className="mt-3 text-sm text-gray-400">
            {search ? `No ${labels.personLabelPlural.toLowerCase()} match your search` : `No ${labels.personLabelPlural.toLowerCase()} yet. They'll appear here after their first WhatsApp ${labels.entityName}.`}
          </p>
        </div>
      ) : (
        <div className="mt-4 overflow-x-auto rounded-xl border border-gray-100 bg-white">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-50 bg-gray-50/50">
                <th scope="col" className="px-4 py-3 text-left font-medium text-gray-500">{labels.personLabel}</th>
                <th scope="col" className="px-4 py-3 text-left font-medium text-gray-500">Phone</th>
                <th scope="col" className="px-4 py-3 text-left font-medium text-gray-500">{labels.entityNamePlural}</th>
                <th scope="col" className="px-4 py-3 text-left font-medium text-gray-500">Spent</th>
                <th scope="col" className="px-4 py-3 text-left font-medium text-gray-500">First Visit</th>
                <th scope="col" className="px-4 py-3 text-left font-medium text-gray-500">Last Visit</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {sorted.map((g) => (
                <tr
                  key={g.guest_phone}
                  className="cursor-pointer hover:bg-gray-50/50"
                  onClick={() => { setSelectedGuest(selectedGuest?.guest_phone === g.guest_phone ? null : g); setWaMessage(''); setWaSent(false); }}
                >
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      <div className="flex h-8 w-8 items-center justify-center rounded-full bg-brand-50 text-xs font-bold text-brand">
                        {(g.guest_name || g.guest_phone).charAt(0).toUpperCase()}
                      </div>
                      <div>
                        <p className="font-medium text-gray-900">{g.guest_name || 'Unknown'}</p>
                        {g.guest_email && <p className="text-xs text-gray-400">{g.guest_email}</p>}
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-gray-600">{g.guest_phone}</td>
                  <td className="px-4 py-3">
                    <span className="inline-flex items-center rounded-full bg-brand-50 px-2 py-0.5 text-xs font-medium text-brand">
                      {g.booking_count}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-gray-600">
                    {g.total_spent > 0
                      ? new Intl.NumberFormat(getLocale((business.country_code || 'NG') as CountryCode), { style: 'currency', currency: 'NGN', minimumFractionDigits: 0 }).format(g.total_spent)
                      : '\u2014'}
                  </td>
                  <td className="px-4 py-3 text-gray-600">{formatDate(g.first_visit)}</td>
                  <td className="px-4 py-3 text-gray-600">{formatDate(g.last_visit)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Guest Detail Drawer */}
      {selectedGuest && (
        <div className="fixed inset-y-0 right-0 z-50 flex">
          <div className="fixed inset-0 bg-black/20" onClick={() => setSelectedGuest(null)} />
          <div className="relative ml-auto w-full max-w-md bg-white shadow-xl">
            <div className="flex items-center justify-between border-b border-gray-100 px-6 py-4">
              <h2 className="text-lg font-bold text-gray-900">{labels.personLabel} Details</h2>
              <button onClick={() => setSelectedGuest(null)} className="text-gray-400 hover:text-gray-600">
                <svg aria-hidden="true" className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="p-6">
              <div className="flex items-center gap-4">
                <div className="flex h-14 w-14 items-center justify-center rounded-full bg-brand-50 text-xl font-bold text-brand">
                  {(selectedGuest.guest_name || selectedGuest.guest_phone).charAt(0).toUpperCase()}
                </div>
                <div>
                  <p className="text-lg font-semibold text-gray-900">{selectedGuest.guest_name || 'Unknown'}</p>
                  <p className="text-sm text-gray-500">{selectedGuest.guest_phone}</p>
                  {selectedGuest.guest_email && (
                    <p className="text-sm text-gray-500">{selectedGuest.guest_email}</p>
                  )}
                </div>
              </div>

              <div className="mt-6 grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="rounded-lg bg-gray-50 p-4">
                  <p className="text-xs text-gray-500">Total {labels.entityNamePlural}</p>
                  <p className="mt-1 text-xl font-bold text-gray-900">{selectedGuest.booking_count}</p>
                </div>
                <div className="rounded-lg bg-gray-50 p-4">
                  <p className="text-xs text-gray-500">Total Spent</p>
                  <p className="mt-1 text-xl font-bold text-gray-900">
                    {selectedGuest.total_spent > 0
                      ? new Intl.NumberFormat(getLocale((business.country_code || 'NG') as CountryCode), { style: 'currency', currency: 'NGN', minimumFractionDigits: 0 }).format(selectedGuest.total_spent)
                      : '\u2014'}
                  </p>
                </div>
                <div className="rounded-lg bg-gray-50 p-4">
                  <p className="text-xs text-gray-500">First Visit</p>
                  <p className="mt-1 text-sm font-medium text-gray-900">{formatDate(selectedGuest.first_visit)}</p>
                </div>
                <div className="rounded-lg bg-gray-50 p-4">
                  <p className="text-xs text-gray-500">Last Visit</p>
                  <p className="mt-1 text-sm font-medium text-gray-900">{formatDate(selectedGuest.last_visit)}</p>
                </div>
              </div>

              <div className="mt-6">
                {isSharedNumber ? (
                  <>
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
                              customerPhone: selectedGuest.guest_phone,
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
                  </>
                ) : (
                  <a
                    href={`https://wa.me/${selectedGuest.guest_phone.replace(/\D/g, '')}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex w-full items-center justify-center gap-2 rounded-lg bg-green-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-green-700"
                  >
                    <svg aria-hidden="true" className="h-4 w-4" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z" />
                    </svg>
                    Message on WhatsApp
                  </a>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
