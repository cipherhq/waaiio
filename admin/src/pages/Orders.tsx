import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { Pagination } from '@/components/Pagination';
import { StatusBadge } from '@/components/StatusBadge';
import { DetailModal, DetailRow } from '@/components/DetailModal';
import { fmtDate, fmtDateTime, fmtCurrency } from '@/lib/formatters';

interface Order {
  id: string;
  business_id: string;
  customer_id: string;
  status: string;
  total: number | null;
  currency: string | null;
  items_count: number;
  delivery_address: string | null;
  delivery_method: string | null;
  delivery_fee: number | null;
  delivery_notes: string | null;
  payment_status: string | null;
  payment_method: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string | null;
  // enriched
  business_name?: string;
  customer_name?: string;
  customer_email?: string;
}

interface OrderItem {
  id: string;
  order_id: string;
  product_name: string | null;
  quantity: number;
  unit_price: number | null;
  total_price: number | null;
  notes: string | null;
}

interface BusinessOption {
  id: string;
  name: string;
}

export default function Orders() {
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [businesses, setBusinesses] = useState<BusinessOption[]>([]);
  const [statusFilter, setStatusFilter] = useState('all');
  const [businessFilter, setBusinessFilter] = useState('all');
  const [dateStart, setDateStart] = useState('');
  const [dateEnd, setDateEnd] = useState('');
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Order | null>(null);
  const [orderItems, setOrderItems] = useState<OrderItem[]>([]);
  const [itemsLoading, setItemsLoading] = useState(false);
  const perPage = 20;

  useEffect(() => {
    async function load() {
      // Load orders
      const { data: orderData } = await supabase
        .from('orders')
        .select('*')
        .order('created_at', { ascending: false });

      const rows = orderData || [];

      // Load business names
      const bizIds = [...new Set(rows.map(o => o.business_id).filter(Boolean))];
      const { data: bizData } = bizIds.length > 0
        ? await supabase.from('businesses').select('id, name').in('id', bizIds)
        : { data: [] };

      const bizMap = new Map((bizData || []).map(b => [b.id, b.name]));
      setBusinesses(
        (bizData || []).map(b => ({ id: b.id, name: b.name })).sort((a, b) => a.name.localeCompare(b.name))
      );

      // Load customer profiles
      const customerIds = [...new Set(rows.map(o => o.customer_id).filter(Boolean))];
      const { data: profileData } = customerIds.length > 0
        ? await supabase.from('profiles').select('id, first_name, last_name, email').in('id', customerIds)
        : { data: [] };

      const profileMap = new Map(
        (profileData || []).map(p => [p.id, { name: [p.first_name, p.last_name].filter(Boolean).join(' ') || '—', email: p.email || '—' }])
      );

      // Count items per order
      const orderIds = rows.map(o => o.id);
      const { data: itemCounts } = orderIds.length > 0
        ? await supabase.from('order_items').select('order_id')
            .in('order_id', orderIds)
        : { data: [] };

      const countMap = new Map<string, number>();
      for (const item of itemCounts || []) {
        countMap.set(item.order_id, (countMap.get(item.order_id) || 0) + 1);
      }

      const enriched: Order[] = rows.map(o => ({
        ...o,
        business_name: bizMap.get(o.business_id) || 'Unknown',
        customer_name: profileMap.get(o.customer_id)?.name || 'Unknown',
        customer_email: profileMap.get(o.customer_id)?.email || '—',
        items_count: countMap.get(o.id) || o.items_count || 0,
      }));

      setOrders(enriched);
      setLoading(false);
    }
    load();
  }, []);

  // Load order items when detail modal opens
  useEffect(() => {
    if (!selected) {
      setOrderItems([]);
      return;
    }
    setItemsLoading(true);
    supabase
      .from('order_items')
      .select('id, order_id, product_name, quantity, unit_price, total_price, notes')
      .eq('order_id', selected.id)
      .order('created_at', { ascending: true })
      .then(({ data }) => {
        setOrderItems(data || []);
        setItemsLoading(false);
      });
  }, [selected]);

  const filtered = orders.filter(o => {
    if (statusFilter !== 'all' && o.status !== statusFilter) return false;
    if (businessFilter !== 'all' && o.business_id !== businessFilter) return false;
    if (dateStart && o.created_at < dateStart) return false;
    if (dateEnd && o.created_at > dateEnd + 'T23:59:59') return false;
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
      <h1 className="text-2xl font-bold text-gray-900">Orders</h1>
      <p className="mt-1 text-sm text-gray-500">Manage all customer orders across businesses</p>

      {/* Filters */}
      <div className="mt-6 flex flex-wrap items-center gap-3">
        <select
          value={statusFilter}
          onChange={e => { setStatusFilter(e.target.value); setPage(1); }}
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 focus:border-brand focus:outline-none"
        >
          <option value="all">All Statuses</option>
          <option value="pending">Pending</option>
          <option value="confirmed">Confirmed</option>
          <option value="processing">Processing</option>
          <option value="completed">Completed</option>
          <option value="cancelled">Cancelled</option>
        </select>
        <select
          value={businessFilter}
          onChange={e => { setBusinessFilter(e.target.value); setPage(1); }}
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 focus:border-brand focus:outline-none"
        >
          <option value="all">All Businesses</option>
          {businesses.map(b => (
            <option key={b.id} value={b.id}>{b.name}</option>
          ))}
        </select>
        <input
          type="date"
          value={dateStart}
          onChange={e => { setDateStart(e.target.value); setPage(1); }}
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 focus:border-brand focus:outline-none"
        />
        <input
          type="date"
          value={dateEnd}
          onChange={e => { setDateEnd(e.target.value); setPage(1); }}
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 focus:border-brand focus:outline-none"
        />
        {(statusFilter !== 'all' || businessFilter !== 'all' || dateStart || dateEnd) && (
          <button
            onClick={() => { setStatusFilter('all'); setBusinessFilter('all'); setDateStart(''); setDateEnd(''); setPage(1); }}
            className="text-sm text-brand hover:underline"
          >
            Clear filters
          </button>
        )}
      </div>

      {/* Table */}
      <div className="mt-4 overflow-x-auto rounded-xl border border-gray-200 bg-white">
        {pageItems.length === 0 ? (
          <div className="py-16 text-center text-sm text-gray-500">No orders found</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="border-b border-gray-100 bg-gray-50">
              <tr>
                <th className="px-4 py-3 text-left font-medium text-gray-500">ID</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Business</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Customer</th>
                <th className="px-4 py-3 text-right font-medium text-gray-500">Items</th>
                <th className="px-4 py-3 text-right font-medium text-gray-500">Total</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Status</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Date</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {pageItems.map(o => (
                <tr
                  key={o.id}
                  onClick={() => setSelected(o)}
                  className="cursor-pointer transition hover:bg-gray-50"
                >
                  <td className="px-4 py-3 text-gray-600 font-mono text-xs">{o.id.slice(0, 8)}...</td>
                  <td className="px-4 py-3 font-medium text-gray-900">{o.business_name}</td>
                  <td className="px-4 py-3 text-gray-600">{o.customer_name}</td>
                  <td className="px-4 py-3 text-right text-gray-600">{o.items_count}</td>
                  <td className="px-4 py-3 text-right font-medium text-gray-900">
                    {o.total != null ? fmtCurrency(o.total, o.currency || 'NGN') : '—'}
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge status={o.status} />
                  </td>
                  <td className="px-4 py-3 text-gray-600 whitespace-nowrap">{fmtDate(o.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <Pagination page={page} totalPages={totalPages} onPageChange={setPage} />

      {/* Detail Modal */}
      <DetailModal
        open={!!selected}
        onClose={() => setSelected(null)}
        title="Order Details"
        wide
      >
        {selected && (
          <div className="space-y-3 text-sm">
            <DetailRow label="Order ID" value={selected.id} />
            <DetailRow label="Status" value={selected.status} />
            <DetailRow label="Created" value={fmtDateTime(selected.created_at)} />
            {selected.updated_at && (
              <DetailRow label="Last Updated" value={fmtDateTime(selected.updated_at)} />
            )}

            <div className="mt-4 rounded-lg bg-gray-50 p-4">
              <p className="text-xs font-semibold uppercase text-gray-500 mb-2">Business</p>
              <div className="space-y-2">
                <DetailRow label="Business" value={selected.business_name || '—'} />
                <DetailRow label="Business ID" value={selected.business_id} />
              </div>
            </div>

            <div className="mt-4 rounded-lg bg-gray-50 p-4">
              <p className="text-xs font-semibold uppercase text-gray-500 mb-2">Customer</p>
              <div className="space-y-2">
                <DetailRow label="Name" value={selected.customer_name || '—'} />
                <DetailRow label="Email" value={selected.customer_email || '—'} />
                <DetailRow label="Customer ID" value={selected.customer_id} />
              </div>
            </div>

            {/* Order Items */}
            <div className="mt-4 rounded-lg bg-gray-50 p-4">
              <p className="text-xs font-semibold uppercase text-gray-500 mb-2">
                Order Items ({selected.items_count})
              </p>
              {itemsLoading ? (
                <div className="flex items-center justify-center py-4">
                  <div className="h-5 w-5 animate-spin rounded-full border-2 border-brand border-t-transparent" />
                </div>
              ) : orderItems.length === 0 ? (
                <p className="text-sm text-gray-400">No items found</p>
              ) : (
                <div className="space-y-2">
                  {orderItems.map((item, idx) => (
                    <div
                      key={item.id}
                      className="flex items-center justify-between rounded-lg bg-white px-3 py-2 border border-gray-100"
                    >
                      <div className="flex-1 min-w-0">
                        <p className="font-medium text-gray-900 truncate">
                          {idx + 1}. {item.product_name || 'Unnamed item'}
                        </p>
                        <p className="text-xs text-gray-500">
                          Qty: {item.quantity}
                          {item.unit_price != null && (
                            <span className="ml-2">
                              @ {fmtCurrency(item.unit_price, selected.currency || 'NGN')}
                            </span>
                          )}
                        </p>
                        {item.notes && (
                          <p className="text-xs text-gray-400 mt-0.5">{item.notes}</p>
                        )}
                      </div>
                      <span className="ml-3 font-medium text-gray-900 whitespace-nowrap">
                        {item.total_price != null
                          ? fmtCurrency(item.total_price, selected.currency || 'NGN')
                          : '—'}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="mt-4 rounded-lg bg-gray-50 p-4">
              <p className="text-xs font-semibold uppercase text-gray-500 mb-2">Payment</p>
              <div className="space-y-2">
                <DetailRow
                  label="Subtotal"
                  value={selected.total != null ? fmtCurrency(selected.total, selected.currency || 'NGN') : '—'}
                />
                <DetailRow
                  label="Delivery Fee"
                  value={selected.delivery_fee != null ? fmtCurrency(selected.delivery_fee, selected.currency || 'NGN') : '—'}
                />
                <DetailRow
                  label="Total"
                  value={
                    selected.total != null
                      ? fmtCurrency(
                          selected.total + (selected.delivery_fee || 0),
                          selected.currency || 'NGN'
                        )
                      : '—'
                  }
                />
                <DetailRow label="Currency" value={selected.currency || '—'} />
                <DetailRow label="Payment Status" value={selected.payment_status || '—'} />
                <DetailRow label="Payment Method" value={selected.payment_method || '—'} />
              </div>
            </div>

            {(selected.delivery_address || selected.delivery_method) && (
              <div className="mt-4 rounded-lg bg-gray-50 p-4">
                <p className="text-xs font-semibold uppercase text-gray-500 mb-2">Delivery</p>
                <div className="space-y-2">
                  <DetailRow label="Method" value={selected.delivery_method || '—'} />
                  <DetailRow label="Address" value={selected.delivery_address || '—'} />
                  {selected.delivery_notes && (
                    <DetailRow label="Notes" value={selected.delivery_notes} />
                  )}
                </div>
              </div>
            )}

            {selected.notes && (
              <div className="mt-4 rounded-lg bg-gray-50 p-4">
                <p className="text-xs font-semibold uppercase text-gray-500 mb-2">Order Notes</p>
                <p className="text-sm text-gray-700">{selected.notes}</p>
              </div>
            )}
          </div>
        )}
      </DetailModal>
    </div>
  );
}
