'use client';

import { useEffect, useState } from 'react';
import { useBusiness } from '@/components/dashboard/DashboardProvider';
import { createClient } from '@/lib/supabase/client';
import { CATEGORY_LABELS, type BusinessCategoryKey, formatCurrency, type CountryCode } from '@/lib/constants';

interface Stats {
  totalBookings: number;
  todayBookings: number;
  pendingBookings: number;
  totalRevenue: number;
}

interface RecentBooking {
  id: string;
  reference_code: string;
  guest_name: string | null;
  guest_phone: string | null;
  date: string;
  time: string;
  party_size: number;
  status: string;
  created_at: string;
}

export default function DashboardOverview() {
  const business = useBusiness();
  const [stats, setStats] = useState<Stats>({ totalBookings: 0, todayBookings: 0, pendingBookings: 0, totalRevenue: 0 });
  const [recent, setRecent] = useState<RecentBooking[]>([]);
  const [loading, setLoading] = useState(true);

  const labels = CATEGORY_LABELS[business.category as BusinessCategoryKey] || CATEGORY_LABELS.other;
  const country = (business.country_code || 'NG') as CountryCode;

  useEffect(() => {
    async function load() {
      const supabase = createClient();
      const today = new Date().toISOString().split('T')[0];

      const [totalRes, todayRes, pendingRes, revenueRes, recentRes] = await Promise.all([
        supabase.from('bookings').select('id', { count: 'exact', head: true }).eq('business_id', business.id),
        supabase.from('bookings').select('id', { count: 'exact', head: true }).eq('business_id', business.id).eq('date', today),
        supabase.from('bookings').select('id', { count: 'exact', head: true }).eq('business_id', business.id).eq('status', 'pending'),
        supabase.from('payments').select('amount').eq('status', 'success').in('booking_id',
          (await supabase.from('bookings').select('id').eq('business_id', business.id)).data?.map(b => b.id) || []
        ),
        supabase.from('bookings')
          .select('id, reference_code, guest_name, guest_phone, date, time, party_size, status, created_at')
          .eq('business_id', business.id)
          .order('created_at', { ascending: false })
          .limit(5),
      ]);

      const revenue = (revenueRes.data || []).reduce((sum, p) => sum + (p.amount || 0), 0);

      setStats({
        totalBookings: totalRes.count || 0,
        todayBookings: todayRes.count || 0,
        pendingBookings: pendingRes.count || 0,
        totalRevenue: revenue,
      });
      setRecent((recentRes.data || []) as RecentBooking[]);
      setLoading(false);
    }
    load();
  }, [business.id]);

  const statusColors: Record<string, string> = {
    confirmed: 'bg-green-100 text-green-800',
    pending: 'bg-yellow-100 text-yellow-800',
    seated: 'bg-blue-100 text-blue-800',
    in_progress: 'bg-blue-100 text-blue-800',
    completed: 'bg-gray-100 text-gray-700',
    cancelled: 'bg-red-100 text-red-700',
    no_show: 'bg-red-100 text-red-700',
  };

  if (loading) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-brand border-t-transparent" />
      </div>
    );
  }

  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-900">Dashboard</h1>
      <p className="mt-1 text-sm text-gray-500">Welcome back, {business.name}</p>

      {/* Stats */}
      <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label={`Total ${labels.entityNamePlural}`} value={stats.totalBookings} />
        <StatCard label={`Today's ${labels.entityNamePlural}`} value={stats.todayBookings} />
        <StatCard label="Pending" value={stats.pendingBookings} accent />
        <StatCard label="Revenue" value={formatCurrency(stats.totalRevenue, country)} />
      </div>

      {/* Recent Bookings */}
      <div className="mt-8">
        <h2 className="text-lg font-semibold text-gray-900">
          Recent {labels.entityNamePlural}
        </h2>

        {recent.length === 0 ? (
          <div className="mt-4 rounded-xl border border-dashed border-gray-200 p-8 text-center">
            <p className="text-sm text-gray-400">No {labels.entityNamePlural} yet</p>
            <p className="mt-1 text-xs text-gray-400">
              Share your WhatsApp link to start receiving {labels.entityNamePlural}
            </p>
          </div>
        ) : (
          <div className="mt-4 overflow-x-auto rounded-xl border border-gray-100 bg-white">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-50 bg-gray-50/50">
                  <th className="px-4 py-3 text-left font-medium text-gray-500">Guest</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-500">Date</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-500">{labels.quantityLabel}</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-500">Status</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-500">Ref</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {recent.map((r) => (
                  <tr key={r.id} className="hover:bg-gray-50/50">
                    <td className="px-4 py-3">
                      <p className="font-medium text-gray-900">{r.guest_name || '\u2014'}</p>
                      <p className="text-xs text-gray-400">{r.guest_phone}</p>
                    </td>
                    <td className="px-4 py-3 text-gray-600">
                      {new Date(r.date + 'T00:00').toLocaleDateString('en-NG', {
                        weekday: 'short',
                        day: 'numeric',
                        month: 'short',
                      })}
                    </td>
                    <td className="px-4 py-3 text-gray-600">{r.party_size}</td>
                    <td className="px-4 py-3">
                      <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${statusColors[r.status] || 'bg-gray-100 text-gray-600'}`}>
                        {r.status.replace('_', ' ')}
                      </span>
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-gray-400">{r.reference_code}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function StatCard({
  label,
  value,
  accent,
}: {
  label: string;
  value: number | string;
  accent?: boolean;
}) {
  return (
    <div className="rounded-xl border border-gray-100 bg-white p-5">
      <p className="text-xs font-medium text-gray-500">{label}</p>
      <p className={`mt-2 text-2xl font-bold ${accent ? 'text-brand' : 'text-gray-900'}`}>
        {value}
      </p>
    </div>
  );
}
