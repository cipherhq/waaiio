'use client';

import { useEffect, useState } from 'react';
import { useBusiness } from '@/components/dashboard/DashboardProvider';
import { createClient } from '@/lib/supabase/client';
import { formatCurrency, type CountryCode } from '@/lib/constants';

interface OrderItem {
  id: string;
  quantity: number;
  unit_price: number;
  product: { name: string } | null;
  variant_label: string | null;
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
  const country = (business.country_code || 'NG') as CountryCode;
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterStatus, setFilterStatus] = useState<string>('all');
  const [selectedOrder, setSelectedOrder] = useState<Order | null>(null);
  const [updatingStatus, setUpdatingStatus] = useState(false);

  // Tracking form state
  const [trackingCarrier, setTrackingCarrier] = useState('');
  const [trackingNumber, setTrackingNumber] = useState('');
  const [savingTracking, setSavingTracking] = useState(false);

  async function fetchOrders() {
    const supabase = createClient();

    let query = supabase
      .from('orders')
      .select(`
        id, reference_code, status, total_amount, shipping_cost, delivery_address,
        delivery_phone, notes, channel, created_at,
        shipping_carrier, tracking_number, shipped_at,
        user:profiles!orders_user_id_fkey(first_name, last_name, phone)
      `)
      .eq('business_id', business.id)
      .order('created_at', { ascending: false });

    if (filterStatus !== 'all') {
      query = query.eq('status', filterStatus);
    }

    const { data } = await query.limit(50);

    // Fetch items for each order
    const ordersWithItems: Order[] = [];
    for (const order of (data || [])) {
      const { data: items } = await supabase
        .from('order_items')
        .select('id, quantity, unit_price, variant_label, product:products!order_items_product_id_fkey(name)')
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
              {new Date(selectedOrder.created_at).toLocaleDateString('en-NG', {
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
                  <div key={item.id} className="flex items-center justify-between py-3">
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
                ))}
              </div>
              <div className="mt-3 space-y-1.5 border-t border-gray-100 pt-3">
                {selectedOrder.shipping_cost > 0 && (
                  <div className="flex justify-between">
                    <span className="text-sm text-gray-500">Shipping</span>
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
              <h2 className="text-sm font-semibold text-gray-900">Customer</h2>
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
                      {new Date(selectedOrder.shipped_at).toLocaleDateString('en-NG', {
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
                    {savingTracking ? 'Saving...' : 'Save & Notify Customer'}
                  </button>
                  <p className="text-xs text-gray-400">
                    Customer will receive a WhatsApp message with tracking info.
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
      <h1 className="text-2xl font-bold text-gray-900">Orders</h1>
      <p className="mt-1 text-sm text-gray-500">
        Manage orders from your WhatsApp customers
      </p>

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

      {/* Orders List */}
      {orders.length === 0 ? (
        <div className="mt-12 text-center">
          <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-brand-50">
            <svg className="h-8 w-8 text-brand" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
            </svg>
          </div>
          <h3 className="mt-4 text-sm font-semibold text-gray-900">No orders yet</h3>
          <p className="mt-1 text-sm text-gray-500">
            Orders from WhatsApp customers will appear here.
          </p>
        </div>
      ) : (
        <div className="mt-4 space-y-2">
          {orders.map((order) => (
            <button
              key={order.id}
              onClick={() => setSelectedOrder(order)}
              className="flex w-full items-center justify-between rounded-xl border border-gray-100 bg-white p-4 text-left transition hover:border-brand/20 hover:shadow-sm"
            >
              <div className="flex items-center gap-4 min-w-0">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-gray-50">
                  <span className="text-sm font-bold text-gray-400">#</span>
                </div>
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="font-mono text-sm font-semibold text-gray-900">{order.reference_code}</p>
                    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${statusColors[order.status] || 'bg-gray-100 text-gray-600'}`}>
                      {order.status}
                    </span>
                  </div>
                  <p className="mt-0.5 text-xs text-gray-500">
                    {order.items.length} item{order.items.length !== 1 ? 's' : ''}
                    {' \u2022 '}
                    {new Date(order.created_at).toLocaleDateString('en-NG', {
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
          ))}
        </div>
      )}
    </div>
  );
}
