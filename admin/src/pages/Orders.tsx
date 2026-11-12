import { useEffect, useState } from 'react';
import { adminApiGet } from '@/lib/adminApi';
import { Pagination } from '@/components/Pagination';
import { StatusBadge } from '@/components/StatusBadge';
import { DetailModal, DetailRow } from '@/components/DetailModal';
import { fmtDate, fmtDateTime, fmtCurrency } from '@/lib/formatters';

interface Order {
  id: string;
  business_id: string;
  user_id: string;
  status: string;
  total_amount: number | null;
  currency: string | null;
  items_count: number;
  delivery_address: string | null;
  delivery_phone: string | null;
  shipping_cost: number | null;
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
  variant_label: string | null;
  addons: Array<{ name?: string; price?: number; quantity?: number }> | null;
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
  const [error, setError] = useState('');
  const [itemsError, setItemsError] = useState('');
  const [truncated, setTruncated] = useState(false);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let active = true;
    setLoading(true); setError('');
    void (async () => {
      try {
        const response = await adminApiGet('/api/admin/orders');
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || 'Unable to load orders.');
        if (!active) return;
        const rows: Order[] = body.data;
        setOrders(rows); setTruncated(body.truncated === true);
        setBusinesses([...new Map(rows.map(row => [row.business_id, { id: row.business_id, name: row.business_name || 'Unknown' }])).values()].sort((a, b) => a.name.localeCompare(b.name)));
      } catch (cause) {
        if (active) setError(cause instanceof Error ? cause.message : 'Unable to load orders.');
      } finally { if (active) setLoading(false); }
    })();
    return () => { active = false; };
  }, [reload]);

  useEffect(() => {
    let active = true;
    setOrderItems([]); setItemsError('');
    if (!selected) return;
    setItemsLoading(true);
    void (async () => {
      try {
        const response = await adminApiGet(`/api/admin/orders?orderId=${encodeURIComponent(selected.id)}`);
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || 'Unable to load order items.');
        if (active) { setOrderItems(body.data.items); setSelected(body.data); }
      } catch (cause) {
        if (active) setItemsError(cause instanceof Error ? cause.message : 'Unable to load order items.');
      } finally { if (active) setItemsLoading(false); }
    })();
    return () => { active = false; };
  }, [selected?.id]);

  const money = (amount: number | null, currency: string | null) => amount == null ? '—' : currency ? fmtCurrency(amount, currency) : `${amount.toLocaleString()} (currency unavailable)`;

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
      <p className="mt-1 text-sm text-gray-500">Manage all customer orders across accounts</p>

      {error && <div role="alert">{error} <button onClick={() => setReload(value => value + 1)}>Retry loading orders</button></div>}
      {truncated && <p role="status">Showing the latest 500 orders. Filters and totals on this page cover these loaded orders only.</p>}
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
          <option value="all">All Accounts</option>
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
        {error ? null : pageItems.length === 0 ? (
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
                    {money(o.total_amount, o.currency)}
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
                <DetailRow label="Customer ID" value={selected.user_id} />
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
              ) : itemsError ? (<p role="alert">{itemsError}</p>) : orderItems.length === 0 ? (
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
                              @ {money(item.unit_price, selected.currency)}
                            </span>
                          )}
                        </p>
                        {item.variant_label && <p>{item.variant_label}</p>}
                        {Array.isArray(item.addons) && item.addons.map((addon, index) => <p key={index} className="text-xs text-gray-500">Add-on: {addon.name || 'Unnamed add-on'}{typeof addon.quantity === 'number' ? ` × ${addon.quantity}` : ''}{typeof addon.price === 'number' ? ` · ${money(addon.price, selected.currency)}` : ''}</p>)}
                      </div>
                      <span className="ml-3 font-medium text-gray-900 whitespace-nowrap">
                        Base line: {item.unit_price != null ? money(item.unit_price * item.quantity, selected.currency) : '—'}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="mt-4 rounded-lg bg-gray-50 p-4">
              <p className="text-xs font-semibold uppercase text-gray-500 mb-2">Order amount</p>
              <div className="space-y-2">
                <DetailRow label="Total" value={money(selected.total_amount, selected.currency)} />
                <DetailRow label="Shipping / delivery (included)" value={money(selected.shipping_cost, selected.currency)} />
                <DetailRow label="Currency" value={selected.currency || 'Unavailable'} />
              </div>
            </div>

            {(selected.delivery_address || selected.delivery_phone) && (
              <div className="mt-4 rounded-lg bg-gray-50 p-4">
                <p className="text-xs font-semibold uppercase text-gray-500 mb-2">Delivery</p>
                <div className="space-y-2">
                    <DetailRow label="Address" value={selected.delivery_address || '—'} />
                    <DetailRow label="Phone" value={selected.delivery_phone || '—'} />
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
