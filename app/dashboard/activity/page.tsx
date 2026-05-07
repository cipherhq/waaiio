'use client';

import { useEffect, useState } from 'react';
import { useBusiness } from '@/components/dashboard/DashboardProvider';
import { createClient } from '@/lib/supabase/client';
import { formatCurrency, type CountryCode } from '@/lib/constants';
import { PageHeader } from '@/components/dashboard/PageHeader';

interface ActivityItem {
  id: string;
  type: 'booking' | 'payment' | 'order' | 'setting' | 'capability';
  title: string;
  description: string;
  amount: number | null;
  status: string;
  timestamp: string;
}

export default function ActivityPage() {
  const business = useBusiness();
  const cc = (business.country_code || 'NG') as CountryCode;
  const [activities, setActivities] = useState<ActivityItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      const supabase = createClient();

      // Fetch recent bookings, payments, and orders in parallel
      const [bookingsRes, paymentsRes, ordersRes] = await Promise.all([
        supabase
          .from('bookings')
          .select('id, reference_code, guest_name, status, total_amount, flow_type, created_at')
          .eq('business_id', business.id)
          .order('created_at', { ascending: false })
          .limit(20),
        supabase
          .from('payments')
          .select('id, amount, status, gateway, created_at, booking_id')
          .eq('business_id', business.id)
          .order('created_at', { ascending: false })
          .limit(20),
        supabase
          .from('orders')
          .select('id, reference_code, status, total_amount, created_at')
          .eq('business_id', business.id)
          .order('created_at', { ascending: false })
          .limit(20),
      ]);

      const items: ActivityItem[] = [];

      // Bookings
      for (const b of bookingsRes.data || []) {
        const flowLabel = b.flow_type === 'payment' ? 'Payment' : 'Booking';
        items.push({
          id: `bk-${b.id}`,
          type: 'booking',
          title: `New ${flowLabel}`,
          description: `${b.guest_name || 'Customer'} — ${b.reference_code}`,
          amount: b.total_amount,
          status: b.status,
          timestamp: b.created_at,
        });
      }

      // Payments
      for (const p of paymentsRes.data || []) {
        items.push({
          id: `py-${p.id}`,
          type: 'payment',
          title: `Payment ${p.status === 'success' ? 'received' : p.status}`,
          description: `via ${p.gateway || 'gateway'}`,
          amount: p.amount,
          status: p.status,
          timestamp: p.created_at,
        });
      }

      // Orders
      for (const o of ordersRes.data || []) {
        items.push({
          id: `or-${o.id}`,
          type: 'order',
          title: 'New Order',
          description: o.reference_code,
          amount: o.total_amount,
          status: o.status,
          timestamp: o.created_at,
        });
      }

      // Sort by timestamp descending, deduplicate by removing payment items that match a booking
      const bookingIds = new Set((bookingsRes.data || []).map(b => b.id));
      const deduped = items.filter(i => {
        if (i.type === 'payment') {
          const p = (paymentsRes.data || []).find(p => `py-${p.id}` === i.id);
          if (p?.booking_id && bookingIds.has(p.booking_id)) return false;
        }
        return true;
      });

      deduped.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
      setActivities(deduped.slice(0, 50));
      setLoading(false);
    }
    load();
  }, [business.id]);

  const statusColor = (status: string) => {
    switch (status) {
      case 'success': case 'confirmed': case 'completed': return 'bg-green-100 text-green-700';
      case 'pending': return 'bg-yellow-100 text-yellow-700';
      case 'failed': case 'cancelled': return 'bg-red-100 text-red-700';
      default: return 'bg-gray-100 text-gray-600';
    }
  };

  const typeIcon = (type: string) => {
    switch (type) {
      case 'booking': return '📅';
      case 'payment': return '💳';
      case 'order': return '📦';
      default: return '📋';
    }
  };

  function timeAgo(timestamp: string): string {
    const diff = Date.now() - new Date(timestamp).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    if (days < 7) return `${days}d ago`;
    return new Date(timestamp).toLocaleDateString();
  }

  return (
    <div className="space-y-6">
      <PageHeader title="Activity" description="Recent activity across your business" />

      {loading ? (
        <div className="flex min-h-[30vh] items-center justify-center">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-brand border-t-transparent" />
        </div>
      ) : activities.length === 0 ? (
        <div className="rounded-lg border border-gray-200 bg-white p-12 text-center dark:border-gray-700 dark:bg-gray-800">
          <p className="text-sm text-gray-500">No activity yet. Activity will appear here as customers interact with your business.</p>
        </div>
      ) : (
        <div className="rounded-xl border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800">
          <div className="divide-y divide-gray-100 dark:divide-gray-700">
            {activities.map(item => (
              <div key={item.id} className="flex items-center gap-4 px-5 py-3.5">
                <span className="text-xl">{typeIcon(item.type)}</span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-gray-900 dark:text-gray-100">{item.title}</p>
                  <p className="text-xs text-gray-500 dark:text-gray-400">{item.description}</p>
                </div>
                {item.amount != null && item.amount > 0 && (
                  <span className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                    {formatCurrency(item.amount, cc)}
                  </span>
                )}
                <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${statusColor(item.status)}`}>
                  {item.status}
                </span>
                <span className="whitespace-nowrap text-xs text-gray-400">{timeAgo(item.timestamp)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
