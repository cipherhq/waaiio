'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { useBusiness } from '@/components/dashboard/DashboardProvider';
import { createClient } from '@/lib/supabase/client';
import { PageHelp } from '@/components/dashboard/PageHelp';
import EmptyState from '@/components/dashboard/EmptyState';

interface GrowthContact {
  id: string;
  first_name: string | null;
  last_name: string | null;
  phone: string | null;
  email: string | null;
  tags: string[] | null;
  has_consent: boolean;
  opted_out: boolean;
  created_at: string;
}

type FilterType = 'all' | 'has_consent' | 'needs_consent' | 'opted_out';

const PAGE_SIZE = 25;

function maskPhone(phone: string | null): string {
  if (!phone) return '\u2014';
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 4) return '\u2022\u2022\u2022\u2022';
  return '\u2022\u2022\u2022\u2022 ' + digits.slice(-4);
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function getConsentBadge(contact: GrowthContact) {
  if (contact.opted_out) {
    return { label: 'Opted Out', className: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300' };
  }
  if (contact.has_consent) {
    return { label: 'Has Consent', className: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300' };
  }
  return { label: 'Needs Consent', className: 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300' };
}

export default function GrowthContactsPage() {
  const business = useBusiness();
  const supabase = createClient();

  const [contacts, setContacts] = useState<GrowthContact[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<FilterType>('all');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);

  const loadContacts = useCallback(async () => {
    setLoading(true);
    let query = supabase
      .from('growth_contacts')
      .select('id, first_name, last_name, phone, email, tags, has_consent, opted_out, created_at', { count: 'exact' })
      .eq('business_id', business.id)
      .order('created_at', { ascending: false })
      .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1);

    if (filter === 'has_consent') {
      query = query.eq('has_consent', true).eq('opted_out', false);
    } else if (filter === 'needs_consent') {
      query = query.eq('has_consent', false).eq('opted_out', false);
    } else if (filter === 'opted_out') {
      query = query.eq('opted_out', true);
    }

    if (search.trim()) {
      const s = search.trim().replace(/[%_]/g, '\\$&');
      query = query.or(`first_name.ilike.%${s}%,last_name.ilike.%${s}%,phone.ilike.%${s}%`);
    }

    const { data, count } = await query;
    setContacts((data as GrowthContact[]) || []);
    setTotalCount(count ?? 0);
    setLoading(false);
  }, [business.id, supabase, filter, search, page]);

  useEffect(() => {
    loadContacts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [business.id, filter, search, page]);

  // Reset page when filter or search changes
  useEffect(() => {
    setPage(0);
  }, [filter, search]);

  const totalPages = Math.ceil(totalCount / PAGE_SIZE);

  const filters: { key: FilterType; label: string }[] = [
    { key: 'all', label: 'All' },
    { key: 'has_consent', label: 'Has Consent' },
    { key: 'needs_consent', label: 'Needs Consent' },
    { key: 'opted_out', label: 'Opted Out' },
  ];

  return (
    <div className="mx-auto max-w-5xl px-4 py-6 sm:px-6">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Contacts</h1>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          Manage your imported contacts and consent status
        </p>
        <PageHelp
          pageKey="growth-contacts"
          title="Growth Contacts"
          description="View and manage contacts imported for your growth campaigns. Track consent status and filter by eligibility."
        />
      </div>

      {/* Controls */}
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <input
          type="text"
          placeholder="Search by name or phone..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white placeholder:text-gray-400 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500 w-64"
        />
        <div className="flex rounded-lg border border-gray-300 dark:border-gray-600 overflow-hidden">
          {filters.map((f) => (
            <button
              key={f.key}
              type="button"
              onClick={() => setFilter(f.key)}
              className={`px-3 py-2 text-xs font-medium transition-colors ${
                filter === f.key
                  ? 'bg-brand-600 text-white'
                  : 'bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
        <div className="ml-auto">
          <Link
            href="/dashboard/growth/import"
            className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 transition-colors"
          >
            Import Contacts
          </Link>
        </div>
      </div>

      {/* Loading */}
      {loading && (
        <div className="flex items-center justify-center py-16">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-brand-600 border-t-transparent" />
        </div>
      )}

      {/* Empty state */}
      {!loading && contacts.length === 0 && (
        <EmptyState
          icon={'\uD83D\uDCCB'}
          title="No contacts found"
          description={search || filter !== 'all' ? 'Try adjusting your search or filters' : 'Import contacts to get started'}
          actionLabel="Import Contacts"
          actionHref="/dashboard/growth/import"
        />
      )}

      {/* Contacts table */}
      {!loading && contacts.length > 0 && (
        <>
          <p className="mb-3 text-sm text-gray-500 dark:text-gray-400">
            {totalCount} contact{totalCount !== 1 ? 's' : ''}
          </p>

          {/* Desktop table */}
          <div className="hidden sm:block overflow-hidden rounded-xl border border-gray-200 dark:border-gray-700">
            <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
              <thead className="bg-gray-50 dark:bg-gray-800">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">Name</th>
                  <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">Phone</th>
                  <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">Email</th>
                  <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">Tags</th>
                  <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">Consent</th>
                  <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">Imported</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200 dark:divide-gray-700 bg-white dark:bg-gray-900">
                {contacts.map((contact) => {
                  const badge = getConsentBadge(contact);
                  return (
                    <tr key={contact.id} className="hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors">
                      <td className="whitespace-nowrap px-4 py-3 text-sm font-medium text-gray-900 dark:text-white">
                        {[contact.first_name, contact.last_name].filter(Boolean).join(' ') || '\u2014'}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-sm text-gray-500 dark:text-gray-400">
                        {maskPhone(contact.phone)}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-sm text-gray-500 dark:text-gray-400">
                        {contact.email || '\u2014'}
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-500 dark:text-gray-400">
                        {contact.tags && contact.tags.length > 0 ? (
                          <div className="flex flex-wrap gap-1">
                            {contact.tags.slice(0, 3).map((tag) => (
                              <span key={tag} className="inline-flex rounded-full bg-gray-100 dark:bg-gray-700 px-2 py-0.5 text-xs text-gray-600 dark:text-gray-300">
                                {tag}
                              </span>
                            ))}
                            {contact.tags.length > 3 && (
                              <span className="text-xs text-gray-400">+{contact.tags.length - 3}</span>
                            )}
                          </div>
                        ) : '\u2014'}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-sm">
                        <span className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium ${badge.className}`}>
                          {badge.label}
                        </span>
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-sm text-gray-500 dark:text-gray-400">
                        {formatDate(contact.created_at)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Mobile cards */}
          <div className="space-y-3 sm:hidden">
            {contacts.map((contact) => {
              const badge = getConsentBadge(contact);
              return (
                <div
                  key={contact.id}
                  className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-4"
                >
                  <div className="flex items-start justify-between">
                    <div>
                      <p className="text-sm font-medium text-gray-900 dark:text-white">
                        {[contact.first_name, contact.last_name].filter(Boolean).join(' ') || '\u2014'}
                      </p>
                      <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">{maskPhone(contact.phone)}</p>
                      {contact.email && (
                        <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">{contact.email}</p>
                      )}
                    </div>
                    <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${badge.className}`}>
                      {badge.label}
                    </span>
                  </div>
                  {contact.tags && contact.tags.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1">
                      {contact.tags.map((tag) => (
                        <span key={tag} className="inline-flex rounded-full bg-gray-100 dark:bg-gray-700 px-2 py-0.5 text-xs text-gray-600 dark:text-gray-300">
                          {tag}
                        </span>
                      ))}
                    </div>
                  )}
                  <p className="mt-2 text-xs text-gray-400">{formatDate(contact.created_at)}</p>
                </div>
              );
            })}
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="mt-4 flex items-center justify-between">
              <p className="text-sm text-gray-500 dark:text-gray-400">
                Page {page + 1} of {totalPages}
              </p>
              <div className="flex gap-2">
                <button
                  type="button"
                  disabled={page === 0}
                  onClick={() => setPage((p) => p - 1)}
                  className="rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-1.5 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50 transition-colors"
                >
                  Previous
                </button>
                <button
                  type="button"
                  disabled={page >= totalPages - 1}
                  onClick={() => setPage((p) => p + 1)}
                  className="rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-1.5 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50 transition-colors"
                >
                  Next
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
