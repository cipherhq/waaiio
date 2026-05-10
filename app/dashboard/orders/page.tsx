'use client';

import { useEffect, useState, useMemo } from 'react';
import { useBusiness } from '@/components/dashboard/DashboardProvider';
import { createClient } from '@/lib/supabase/client';
import { formatCurrency, getLocale, type CountryCode } from '@/lib/constants';
import { useCategoryConfig } from '@/hooks/useCategoryConfig';
import { RefundModal } from '@/components/dashboard/RefundModal';
import { CsvExportButton } from '@/components/dashboard/CsvExportButton';
import EmptyState from '@/components/dashboard/EmptyState';
import { PageHelp } from '@/components/dashboard/PageHelp';

interface OrderItem {
  id: string;
  quantity: number;
  unit_price: number;
  product: { name: string } | null;
  variant_label: string | null;
  addons: Array<{ name: string; price: number; quantity?: number }> | null;
}

interface Order {
  id: string;
  reference_code: string;
  status: string;
  total_amount: number;
  shipping_cost: number;
  delivery_address: string | null;
  delivery_phone: string | null;
  notes: string | null;
  channel: string;
  created_at: string;
  shipping_carrier: string | null;
  tracking_number: string | null;
  shipped_at: string | null;
  delivery_zone_name: string | null;
  addons_total: number | null;
  volume_discount_amount: number | null;
  discount_amount: number | null;
  deposit_amount: number | null;
  deposit_percentage: number | null;
  balance_amount: number | null;
  balance_paid_at: string | null;
  deposit_paid_at: string | null;
  custom_order_data: Record<string, unknown> | null;
  user: { first_name: string | null; last_name: string | null; phone: string | null } | null;
  items: OrderItem[];
}

const ORDER_STATUSES = ['confirmed', 'processing', 'shipped', 'ready', 'delivered', 'cancelled'] as const;

const statusColors: Record<string, string> = {
  draft: 'bg-gray-100 text-gray-600',
  confirmed: 'bg-blue-100 text-blue-700',
  processing: 'bg-amber-100 text-amber-700',
  shipped: 'bg-purple-100 text-purple-700',
  ready: 'bg-green-100 text-green-700',
  delivered: 'bg-green-100 text-green-800',
  cancelled: 'bg-red-100 text-red-700',
};

export default function OrdersPage() {
  const business = useBusiness();
  const { labels } = useCategoryConfig(business.category);
  const country = (business.country_code || 'NG') as CountryCode;
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterStatus, setFilterStatus] = useState<string>('all');
  const [selectedOrder, setSelectedOrder] = useState<Order | null>(null);
  const [updatingStatus, setUpdatingStatus] = useState(false);

  // Bulk selection
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const toggleSelect = (id: string) => setSelectedIds(prev => { const next = new Set(prev); next.has(id) ? next.delete(id) : next.add(id); return next; });
  const toggleAll = () => setSelectedIds(prev => prev.size === pageItems.length ? new Set() : new Set(pageItems.map(o => o.id)));
  const [bulkUpdating, setBulkUpdating] = useState(false);

  // Tracking form state
  const [trackingCarrier, setTrackingCarrier] = useState('');
  const [trackingNumber, setTrackingNumber] = useState('');
  const [savingTracking, setSavingTracking] = useState(false);

  // Balance request state
  const [requestingBalance, setRequestingBalance] = useState(false);

  // Search, date range, pagination
  const [search, setSearch] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [page, setPage] = useState(1);
  const perPage = 20;

  const filtered = useMemo(() => {
    let r = orders;
    if (filterStatus !== 'all') r = r.filter(o => o.status === filterStatus);
    if (search) {
      const q = search.toLowerCase();
      r = r.filter(o =>
        o.reference_code?.toLowerCase().includes(q) ||
        o.user?.first_name?.toLowerCase().includes(q) ||
        o.user?.last_name?.toLowerCase().includes(q) ||
        o.delivery_phone?.toLowerCase().includes(q)
      );
    }
    if (dateFrom) r = r.filter(o => o.created_at >= dateFrom);
    if (dateTo) r = r.filter(o => o.created_at <= dateTo + 'T23:59:59');
    return r;
  }, [orders, search, dateFrom, dateTo, filterStatus]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / perPage));
  const pageItems = filtered.slice((page - 1) * perPage, page * perPage);

  // Reset page on filter change
  useEffect(() => { setPage(1); }, [search, dateFrom, dateTo, filterStatus]);

  // Refund state
  const [refundModalOpen, setRefundModalOpen] = useState(false);
  const [refundPayment, setRefundPayment] = useState<{ id: string; amount: number; refund_amount: number; currency: string } | null>(null);

  async function openRefundForOrder(orderId: string) {
    const supabase = createClient();
    const { data: payment } = await supabase
      .from('payments')
      .select('id, amount, refund_amount, currency, status')
      .eq('business_id', business.id)
      .contains('metadata', { order_id: orderId })
      .eq('status', 'success')
      .maybeSingle();
    if (payment) {
      setRefundPayment({
        id: payment.id,
        amount: Number(payment.amount),
        refund_amount: Number(payment.refund_amount || 0),
        currency: payment.currency || 'NGN',
      });
      setRefundModalOpen(true);
    }
  }

  async function fetchOrders() {
    const supabase = createClient();

    let query = supabase
      .from('orders')
      .select(`
        id, reference_code, status, total_amount, shipping_cost, delivery_address,
        delivery_phone, notes, channel, created_at,
        shipping_carrier, tracking_number, shipped_at,
        delivery_zone_name, addons_total, volume_discount_amount, discount_amount,
        deposit_amount, deposit_percentage, balance_amount, balance_paid_at, deposit_paid_at,
        custom_order_data,
        user:profiles!orders_user_id_fkey(first_name, last_name, phone)
      `)
      .eq('business_id', business.id)
      .order('created_at', { ascending: false });

    if (filterStatus !== 'all') {
      query = query.eq('status', filterStatus);
    }

    const { data } = await query.limit(500);

    // Fetch items for each order
    const ordersWithItems: Order[] = [];
    for (const order of (data || [])) {
      const { data: items } = await supabase
        .from('order_items')
        .select('id, quantity, unit_price, variant_label, addons, product:products!order_items_product_id_fkey(name)')
        .eq('order_id', order.id);

      ordersWithItems.push({
        ...order,
        user: Array.isArray(order.user) ? order.user[0] : order.user,
        items: (items || []) as unknown as OrderItem[],
      } as Order);
    }

    setOrders(ordersWithItems);
    setLoading(false);
  }

  useEffect(() => { fetchOrders(); }, [business.id, filterStatus]);

  async function updateOrderStatus(orderId: string, newStatus: string) {
    setUpdatingStatus(true);
    try {
      await fetch('/api/orders/update-status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderId, businessId: business.id, status: newStatus }),
      });
    } catch {
      // Fallback to direct update if API fails
      const supabase = createClient();
      await supabase.from('orders').update({ status: newStatus }).eq('id', orderId);
    }
    await fetchOrders();
    if (selectedOrder?.id === orderId) {
      setSelectedOrder(prev => prev ? { ...prev, status: newStatus } : null);
    }
    setUpdatingStatus(false);
  }

  // Stats
  const totalOrders = orders.length;
  const pendingOrders = orders.filter(o => o.status === 'confirmed' || o.status === 'processing').length;
  const todayRevenue = orders
    .filter(o => {
      const today = new Date().toISOString().split('T')[0];
      return o.created_at.startsWith(today) && o.status !== 'cancelled';
    })
    .reduce((sum, o) => sum + o.total_amount, 0);

  if (loading) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-brand border-t-transparent" />
      </div>
    );
  }

  // Order Detail View
  if (selectedOrder) {
    return (
      <div>
        {/* Refund Modal (detail view) */}
        {refundPayment && (
          <RefundModal
            open={refundModalOpen}
            onClose={() => { setRefundModalOpen(false); setRefundPayment(null); }}
            paymentId={refundPayment.id}
            paymentAmount={refundPayment.amount}
            existingRefundAmount={refundPayment.refund_amount}
            currency={refundPayment.currency}
            businessId={business.id}
            isDirectSplit={business.payout_mode === 'direct_split'}
            countryCode={country}
            onSuccess={() => { fetchOrders(); setSelectedOrder(null); }}
          />
        )}
        <div className="flex items-center gap-4">
          <button
            onClick={() => setSelectedOrder(null)}
            className="rounded-lg p-2 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
          >
            <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
          </button>
          <div>
            <h1 className="text-2xl font-bold text-gray-900">
              Order {selectedOrder.reference_code}
            </h1>
            <p className="mt-0.5 text-sm text-gray-500">
              {new Date(selectedOrder.created_at).toLocaleDateString(getLocale((business.country_code || 'NG') as CountryCode), {
                day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit',
              })}
            </p>
          </div>
        </div>

        <div className="mt-6 grid gap-6 lg:grid-cols-3">
          <div className="lg:col-span-2 space-y-6">
            {/* Items */}
            <div className="rounded-xl border border-gray-100 bg-white p-6">
              <h2 className="text-sm font-semibold text-gray-900">Order Items</h2>
              <div className="mt-4 divide-y divide-gray-50">
                {selectedOrder.items.map((item) => (
                  <div key={item.id} className="py-3">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-sm font-medium text-gray-900">
                          {(item.product as { name: string } | null)?.name || 'Unknown Product'}
                        </p>
                        {item.variant_label && (
                          <p className="text-xs text-purple-600">{item.variant_label}</p>
                        )}
                        <p className="text-xs text-gray-500">Qty: {item.quantity}</p>
                      </div>
                      <p className="text-sm font-medium text-gray-900">
                        {formatCurrency(item.unit_price * item.quantity, country)}
                      </p>
                    </div>
                    {item.addons && item.addons.length > 0 && (
                      <div className="mt-1.5 ml-3 space-y-0.5">
                        {item.addons.map((addon, idx) => (
                          <div key={idx} className="flex items-center justify-between text-xs text-gray-500">
                            <span>+ {addon.name}{addon.quantity && addon.quantity > 1 ? ` x${addon.quantity}` : ''}</span>
                            <span>{formatCurrency(addon.price * (addon.quantity || 1), country)}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
              <div className="mt-3 space-y-1.5 border-t border-gray-100 pt-3">
                {!!selectedOrder.addons_total && selectedOrder.addons_total > 0 && (
                  <div className="flex justify-between">
                    <span className="text-sm text-gray-500">Add-ons</span>
                    <span className="text-sm text-gray-700">
                      {formatCurrency(selectedOrder.addons_total, country)}
                    </span>
                  </div>
                )}
                {!!selectedOrder.volume_discount_amount && selectedOrder.volume_discount_amount > 0 && (
                  <div className="flex justify-between">
                    <span className="text-sm text-green-600">Volume Discount</span>
                    <span className="text-sm text-green-600">
                      -{formatCurrency(selectedOrder.volume_discount_amount, country)}
                    </span>
                  </div>
                )}
                {!!selectedOrder.discount_amount && selectedOrder.discount_amount > 0 && (
                  <div className="flex justify-between">
                    <span className="text-sm text-green-600">Promo Discount</span>
                    <span className="text-sm text-green-600">
                      -{formatCurrency(selectedOrder.discount_amount, country)}
                    </span>
                  </div>
                )}
                {selectedOrder.shipping_cost > 0 && (
                  <div className="flex justify-between">
                    <span className="text-sm text-gray-500">
                      {selectedOrder.delivery_zone_name || 'Shipping'}
                    </span>
                    <span className="text-sm text-gray-700">
                      {formatCurrency(selectedOrder.shipping_cost, country)}
                    </span>
                  </div>
                )}
                <div className="flex justify-between">
                  <span className="text-sm font-semibold text-gray-900">Total</span>
                  <span className="text-sm font-bold text-gray-900">
                    {formatCurrency(selectedOrder.total_amount, country)}
                  </span>
                </div>
              </div>
            </div>

            {/* Customer Info */}
            <div className="rounded-xl border border-gray-100 bg-white p-6">
              <h2 className="text-sm font-semibold text-gray-900">{labels.personLabel}</h2>
              <div className="mt-3 space-y-2 text-sm">
                {selectedOrder.user && (
                  <div className="flex justify-between">
                    <span className="text-gray-500">Name</span>
                    <span className="font-medium text-gray-900">
                      {[selectedOrder.user.first_name, selectedOrder.user.last_name].filter(Boolean).join(' ') || '\u2014'}
                    </span>
                  </div>
                )}
                <div className="flex justify-between">
                  <span className="text-gray-500">Phone</span>
                  <span className="font-medium text-gray-900">{selectedOrder.delivery_phone || '\u2014'}</span>
                </div>
                {selectedOrder.delivery_address && (
                  <div className="flex justify-between">
                    <span className="text-gray-500">Delivery Address</span>
                    <span className="font-medium text-gray-900 text-right max-w-[60%]">
                      {selectedOrder.delivery_address}
                    </span>
                  </div>
                )}
                <div className="flex justify-between">
                  <span className="text-gray-500">Channel</span>
                  <span className="font-medium text-gray-900 capitalize">{selectedOrder.channel}</span>
                </div>
              </div>
            </div>
          </div>

          {/* Status, Tracking & Actions */}
          <div className="space-y-4">
            <div className="rounded-xl border border-gray-100 bg-white p-6">
              <h2 className="text-sm font-semibold text-gray-900">Status</h2>
              <div className="mt-3">
                <span className={`inline-flex rounded-full px-3 py-1 text-sm font-medium ${statusColors[selectedOrder.status] || 'bg-gray-100 text-gray-600'}`}>
                  {selectedOrder.status}
                </span>
              </div>

              <div className="mt-5 space-y-2">
                <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">Update Status</p>
                {ORDER_STATUSES.map((status) => (
                  <button
                    key={status}
                    onClick={() => updateOrderStatus(selectedOrder.id, status)}
                    disabled={updatingStatus || selectedOrder.status === status}
                    className={`w-full rounded-lg px-3 py-2 text-sm font-medium text-left transition ${
                      selectedOrder.status === status
                        ? 'bg-brand text-white'
                        : 'bg-gray-50 text-gray-700 hover:bg-gray-100 disabled:opacity-50'
                    }`}
                  >
                    {status.charAt(0).toUpperCase() + status.slice(1)}
                  </button>
                ))}
              </div>
            </div>

            {/* Balance Payment Request (for custom orders with deposit) */}
            {selectedOrder.balance_amount != null && selectedOrder.balance_amount > 0 && !selectedOrder.balance_paid_at && (
              <div className="rounded-xl border border-amber-200 bg-amber-50 p-6">
                <h2 className="text-sm font-semibold text-gray-900">Balance Payment</h2>
                <div className="mt-2 space-y-1 text-sm">
                  {selectedOrder.deposit_amount != null && selectedOrder.deposit_amount > 0 && (
                    <div className="flex justify-between">
                      <span className="text-gray-500">Deposit ({selectedOrder.deposit_percentage}%)</span>
                      <span className="font-medium text-green-600">{formatCurrency(selectedOrder.deposit_amount, country)} {selectedOrder.deposit_paid_at ? '\u2705' : ''}</span>
                    </div>
                  )}
                  <div className="flex justify-between">
                    <span className="text-gray-500">Balance due</span>
                    <span className="font-medium text-amber-700">{formatCurrency(selectedOrder.balance_amount, country)}</span>
                  </div>
                </div>
                <button
                  onClick={async () => {
                    setRequestingBalance(true);
                    try {
                      const res = await fetch('/api/orders/request-balance', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ order_id: selectedOrder.id, business_id: business.id }),
                      });
                      if (res.ok) {
                        await fetchOrders();
                        setSelectedOrder(prev => prev ? { ...prev, status: 'ready' } : null);
                      }
                    } catch {}
                    setRequestingBalance(false);
                  }}
                  disabled={requestingBalance}
                  className="mt-3 w-full rounded-lg bg-amber-600 px-4 py-2 text-sm font-semibold text-white hover:bg-amber-700 disabled:opacity-50"
                >
                  {requestingBalance ? 'Sending...' : 'Request Balance Payment'}
                </button>
                <p className="mt-1.5 text-xs text-gray-400">
                  Customer will receive a WhatsApp message with a payment link.
                </p>
              </div>
            )}

            {/* Refund Payment */}
            <div className="rounded-xl border border-gray-100 bg-white p-6">
              <h2 className="text-sm font-semibold text-gray-900">Refund Payment</h2>
              <p className="mt-1 text-xs text-gray-500">
                Issue a full or partial refund for this order
              </p>
              <button
                onClick={() => openRefundForOrder(selectedOrder.id)}
                className="mt-3 w-full rounded-lg border border-red-200 px-4 py-2 text-sm font-medium text-red-600 hover:bg-red-50"
              >
                Refund
              </button>
            </div>

            {selectedOrder.notes && (
              <div className="rounded-xl border border-gray-100 bg-white p-6">
                <h2 className="text-sm font-semibold text-gray-900">Notes</h2>
                <p className="mt-2 text-sm text-gray-600">{selectedOrder.notes}</p>
              </div>
            )}

            {/* Shipping & Tracking */}
            <div className="rounded-xl border border-gray-100 bg-white p-6">
              <h2 className="text-sm font-semibold text-gray-900">Shipping & Tracking</h2>
              {selectedOrder.shipped_at ? (
                <div className="mt-3 space-y-2 text-sm">
                  <div className="flex justify-between">
                    <span className="text-gray-500">Carrier</span>
                    <span className="font-medium text-gray-900">{selectedOrder.shipping_carrier || '\u2014'}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-500">Tracking #</span>
                    <span className="font-medium text-gray-900">{selectedOrder.tracking_number || '\u2014'}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-500">Shipped</span>
                    <span className="font-medium text-gray-900">
                      {new Date(selectedOrder.shipped_at).toLocaleDateString(getLocale((business.country_code || 'NG') as CountryCode), {
                        day: 'numeric', month: 'short', year: 'numeric',
                      })}
                    </span>
                  </div>
                </div>
              ) : (
                <div className="mt-3 space-y-3">
                  <div>
                    <label className="mb-1 block text-xs font-medium text-gray-600">Carrier Name</label>
                    <input
                      type="text"
                      value={trackingCarrier}
                      onChange={(e) => setTrackingCarrier(e.target.value)}
                      placeholder="e.g. DHL, FedEx, GIG"
                      className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-gray-600">Tracking Number</label>
                    <input
                      type="text"
                      value={trackingNumber}
                      onChange={(e) => setTrackingNumber(e.target.value)}
                      placeholder="Enter tracking number"
                      className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand"
                    />
                  </div>
                  <button
                    onClick={async () => {
                      if (!trackingCarrier.trim() && !trackingNumber.trim()) return;
                      setSavingTracking(true);
                      try {
                        const res = await fetch('/api/orders/tracking', {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({
                            orderId: selectedOrder.id,
                            businessId: business.id,
                            shippingCarrier: trackingCarrier.trim(),
                            trackingNumber: trackingNumber.trim(),
                          }),
                        });
                        if (res.ok) {
                          await fetchOrders();
                          setSelectedOrder(prev => prev ? {
                            ...prev,
                            status: 'shipped',
                            shipping_carrier: trackingCarrier.trim(),
                            tracking_number: trackingNumber.trim(),
                            shipped_at: new Date().toISOString(),
                          } : null);
                          setTrackingCarrier('');
                          setTrackingNumber('');
                        }
                      } catch {
                        // ignore
                      }
                      setSavingTracking(false);
                    }}
                    disabled={savingTracking || (!trackingCarrier.trim() && !trackingNumber.trim())}
                    className="w-full rounded-lg bg-purple-600 px-4 py-2 text-sm font-semibold text-white hover:bg-purple-700 disabled:opacity-50"
                  >
                    {savingTracking ? 'Saving...' : `Save & Notify ${labels.personLabel}`}
                  </button>
                  <p className="text-xs text-gray-400">
                    {labels.personLabel} will receive a WhatsApp message with tracking info.
                  </p>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div>
      {/* Refund Modal */}
      {refundPayment && (
        <RefundModal
          open={refundModalOpen}
          onClose={() => { setRefundModalOpen(false); setRefundPayment(null); }}
          paymentId={refundPayment.id}
          paymentAmount={refundPayment.amount}
          existingRefundAmount={refundPayment.refund_amount}
          currency={refundPayment.currency}
          businessId={business.id}
          isDirectSplit={business.payout_mode === 'direct_split'}
          countryCode={(business.country_code || 'NG') as CountryCode}
          onSuccess={() => { fetchOrders(); setSelectedOrder(null); }}
        />
      )}

      <h1 className="text-2xl font-bold text-gray-900">Orders</h1>
      <p className="mt-1 text-sm text-gray-500">
        Manage orders from your WhatsApp {labels.personLabelPlural.toLowerCase()}
      </p>

      <PageHelp
        pageKey="orders"
        title="Customer Orders"
        description="Orders placed by customers through your WhatsApp bot appear here. You can update the status, add tracking info, and manage delivery."
      />

      {/* Quick Stats */}
      <div className="mt-6 grid gap-4 sm:grid-cols-3">
        <div className="rounded-xl border border-gray-100 bg-white p-4">
          <p className="text-xs font-medium text-gray-500">Total Orders</p>
          <p className="mt-1 text-xl font-bold text-gray-900">{totalOrders}</p>
        </div>
        <div className="rounded-xl border border-gray-100 bg-white p-4">
          <p className="text-xs font-medium text-gray-500">Pending</p>
          <p className="mt-1 text-xl font-bold text-amber-600">{pendingOrders}</p>
        </div>
        <div className="rounded-xl border border-gray-100 bg-white p-4">
          <p className="text-xs font-medium text-gray-500">Today&apos;s Revenue</p>
          <p className="mt-1 text-xl font-bold text-green-600">{formatCurrency(todayRevenue, country)}</p>
        </div>
      </div>

      {/* Status Filter */}
      <div className="mt-6 flex gap-2 overflow-x-auto">
        {['all', ...ORDER_STATUSES].map((status) => (
          <button
            key={status}
            onClick={() => setFilterStatus(status)}
            className={`shrink-0 rounded-lg px-3 py-1.5 text-sm font-medium transition ${
              filterStatus === status
                ? 'bg-brand text-white'
                : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
            }`}
          >
            {status === 'all' ? 'All' : status.charAt(0).toUpperCase() + status.slice(1)}
          </button>
        ))}
      </div>

      {/* Search, Date Range & CSV */}
      <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <svg className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>
          <input
            type="text"
            placeholder="Search by reference, customer, phone..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full rounded-lg border border-gray-200 py-2 pl-10 pr-3 text-sm outline-none focus:border-brand"
          />
        </div>
        <div className="flex items-center gap-2">
          <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} className="rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand" />
          <span className="text-xs text-gray-400">to</span>
          <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} className="rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand" />
        </div>
        <CsvExportButton
          data={filtered.map(o => ({
            Reference: o.reference_code,
            Customer: [o.user?.first_name, o.user?.last_name].filter(Boolean).join(' '),
            Items: o.items.length,
            Amount: o.total_amount,
            Status: o.status,
            Date: new Date(o.created_at).toLocaleDateString(),
          }))}
          filename={`orders-${new Date().toISOString().slice(0, 10)}`}
        />
      </div>

      {/* Orders List */}
      {orders.length === 0 ? (
        <EmptyState
          icon="📦"
          title="No orders yet"
          description="Orders will appear here when customers place them through your WhatsApp bot."
          tip="Make sure you've added products first — customers can't order without a menu."
        />
      ) : filtered.length === 0 ? (
        <div className="mt-12 text-center">
          <p className="text-sm text-gray-500">No orders match your filters</p>
        </div>
      ) : (
        <div className="mt-4 space-y-2">
          {pageItems.map((order) => (
            <div key={order.id} className={`flex items-center gap-3 rounded-xl border ${selectedIds.has(order.id) ? 'border-brand/30 bg-brand-50/30' : 'border-gray-100 bg-white'} transition`}>
              <div className="pl-4" onClick={(e) => e.stopPropagation()}>
                <input type="checkbox" checked={selectedIds.has(order.id)} onChange={() => toggleSelect(order.id)} className="h-4 w-4 rounded border-gray-300" />
              </div>
              <button
                onClick={() => setSelectedOrder(order)}
                className="flex flex-1 items-center justify-between p-4 pl-0 text-left"
              >
              <div className="flex items-center gap-4 min-w-0">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-gray-50">
                  <span className="text-sm font-bold text-gray-400">#</span>
                </div>
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="font-mono text-sm font-semibold text-gray-900">{order.reference_code}</p>
                    <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${statusColors[order.status] || 'bg-gray-100 text-gray-600'}`}>
                      {order.status}
                    </span>
                  </div>
                  <p className="mt-0.5 text-xs text-gray-500">
                    {order.items.length} item{order.items.length !== 1 ? 's' : ''}
                    {' \u2022 '}
                    {new Date(order.created_at).toLocaleDateString(getLocale((business.country_code || 'NG') as CountryCode), {
                      day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
                    })}
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-3 shrink-0 pl-4">
                <span className="text-sm font-bold text-gray-900">
                  {formatCurrency(order.total_amount, country)}
                </span>
                <svg className="h-4 w-4 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                </svg>
              </div>
            </button>
            </div>
          ))}
        </div>
      )}

      {/* Bulk Action Bar */}
      {selectedIds.size > 0 && (
        <div className="mt-4 flex items-center gap-3 rounded-xl border border-brand/20 bg-brand-50 p-3">
          <span className="text-sm font-medium text-gray-700">{selectedIds.size} selected</span>
          <select
            disabled={bulkUpdating}
            onChange={async (e) => {
              const newStatus = e.target.value;
              if (!newStatus) return;
              setBulkUpdating(true);
              for (const id of selectedIds) {
                await updateOrderStatus(id, newStatus);
              }
              setBulkUpdating(false);
              setSelectedIds(new Set());
              e.target.value = '';
            }}
            className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs text-gray-700"
          >
            <option value="">Set status...</option>
            {ORDER_STATUSES.map(s => (
              <option key={s} value={s}>{s.charAt(0).toUpperCase() + s.slice(1)}</option>
            ))}
          </select>
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
    </div>
  );
}
