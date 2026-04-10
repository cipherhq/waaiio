'use client';

import { useEffect, useState, useCallback } from 'react';
import { useBusiness } from '@/components/dashboard/DashboardProvider';
import { createClient } from '@/lib/supabase/client';
import { formatCurrency, type CountryCode } from '@/lib/constants';

type QuoteStatus = 'pending' | 'quoted' | 'accepted' | 'rejected' | 'expired' | 'cancelled';

interface QuoteRequest {
  id: string;
  customer_phone: string | null;
  customer_name: string | null;
  status: QuoteStatus;
  cart_snapshot: Array<{ name: string; quantity: number; price: number; variant_label?: string; addons?: Array<{ name: string; price: number; quantity?: number }> }>;
  addons_snapshot: Array<{ name: string; price: number; quantity?: number }>;
  delivery_zone_name: string | null;
  delivery_address: string | null;
  estimated_subtotal: number;
  quoted_amount: number | null;
  quote_notes: string | null;
  customer_response: string | null;
  order_id: string | null;
  channel: string;
  created_at: string;
  expires_at: string | null;
}

const STATUS_COLORS: Record<QuoteStatus, string> = {
  pending: 'bg-yellow-100 text-yellow-700',
  quoted: 'bg-blue-100 text-blue-700',
  accepted: 'bg-green-100 text-green-700',
  rejected: 'bg-red-100 text-red-700',
  expired: 'bg-gray-100 text-gray-500',
  cancelled: 'bg-gray-100 text-gray-500',
};

export default function QuotesPage() {
  const business = useBusiness();
  const country = (business.country_code || 'NG') as CountryCode;
  const curr = formatCurrency(0, country).charAt(0);

  const [quotes, setQuotes] = useState<QuoteRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<QuoteStatus | 'all'>('all');
  const [selectedQuote, setSelectedQuote] = useState<QuoteRequest | null>(null);
  const [respondAmount, setRespondAmount] = useState('');
  const [respondNotes, setRespondNotes] = useState('');
  const [responding, setResponding] = useState(false);

  const fetchQuotes = useCallback(async () => {
    const supabase = createClient();
    let query = supabase
      .from('quote_requests')
      .select('*')
      .eq('business_id', business.id)
      .order('created_at', { ascending: false });

    if (statusFilter !== 'all') {
      query = query.eq('status', statusFilter);
    }

    const { data } = await query.limit(50);
    setQuotes((data as QuoteRequest[]) || []);
    setLoading(false);
  }, [business.id, statusFilter]);

  useEffect(() => { fetchQuotes(); }, [fetchQuotes]);

  async function handleRespond() {
    if (!selectedQuote || !respondAmount) return;
    setResponding(true);

    try {
      const res = await fetch('/api/orders/quote-respond', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          quote_id: selectedQuote.id,
          business_id: business.id,
          quoted_amount: Number(respondAmount),
          quote_notes: respondNotes.trim() || null,
        }),
      });

      if (res.ok) {
        setSelectedQuote(null);
        setRespondAmount('');
        setRespondNotes('');
        fetchQuotes();
      }
    } catch {
      // error handled silently
    }
    setResponding(false);
  }

  if (loading) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-brand border-t-transparent" />
      </div>
    );
  }

  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-900">Quote Requests</h1>
      <p className="mt-1 text-sm text-gray-500">
        Manage pricing quotes for custom orders with negotiable items.
      </p>

      {/* Status Tabs */}
      <div className="mt-4 flex gap-2">
        {(['all', 'pending', 'quoted', 'accepted', 'rejected'] as const).map(s => (
          <button
            key={s}
            onClick={() => setStatusFilter(s)}
            className={`rounded-lg px-3 py-1.5 text-sm font-medium transition ${
              statusFilter === s ? 'bg-brand text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
            }`}
          >
            {s.charAt(0).toUpperCase() + s.slice(1)}
          </button>
        ))}
      </div>

      {/* Quotes List */}
      {quotes.length === 0 ? (
        <div className="mt-12 text-center">
          <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-gray-100">
            <svg className="h-8 w-8 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
          </div>
          <h3 className="mt-4 text-sm font-semibold text-gray-900">No quote requests yet</h3>
          <p className="mx-auto mt-1 max-w-xs text-sm text-gray-500">
            When customers encounter negotiable items in their WhatsApp order, quote requests appear here.
          </p>
        </div>
      ) : (
        <div className="mt-5 space-y-3">
          {quotes.map(quote => (
            <div
              key={quote.id}
              className="cursor-pointer rounded-xl border border-gray-100 bg-white p-5 transition hover:shadow-sm"
              onClick={() => setSelectedQuote(quote)}
            >
              <div className="flex items-start justify-between">
                <div>
                  <p className="text-sm font-semibold text-gray-900">
                    {quote.customer_name || quote.customer_phone || 'Customer'}
                  </p>
                  <p className="mt-0.5 text-xs text-gray-500">
                    {new Date(quote.created_at).toLocaleDateString('en-US', {
                      day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
                    })}
                  </p>
                </div>
                <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_COLORS[quote.status]}`}>
                  {quote.status}
                </span>
              </div>

              {/* Cart summary */}
              <div className="mt-3 space-y-1">
                {(quote.cart_snapshot || []).slice(0, 3).map((item, i) => (
                  <p key={i} className="text-xs text-gray-600">
                    {item.name}{item.variant_label ? ` (${item.variant_label})` : ''} x{item.quantity} — {formatCurrency(item.price * item.quantity, country)}
                  </p>
                ))}
                {(quote.cart_snapshot || []).length > 3 && (
                  <p className="text-xs text-gray-400">+{quote.cart_snapshot.length - 3} more items</p>
                )}
              </div>

              <div className="mt-3 flex items-center gap-4 text-xs">
                <span className="text-gray-500">Subtotal: <span className="font-medium text-gray-900">{formatCurrency(quote.estimated_subtotal, country)}</span></span>
                {quote.quoted_amount != null && (
                  <span className="text-brand">Quoted: <span className="font-medium">{formatCurrency(quote.quoted_amount, country)}</span></span>
                )}
                {quote.delivery_zone_name && (
                  <span className="text-gray-500">Zone: {quote.delivery_zone_name}</span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Quote Detail Modal */}
      {selectedQuote && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="max-h-[90vh] w-full max-w-lg overflow-auto rounded-2xl bg-white p-6 shadow-xl">
            <div className="flex items-start justify-between">
              <div>
                <h2 className="text-lg font-bold text-gray-900">Quote Request</h2>
                <p className="text-sm text-gray-500">
                  {selectedQuote.customer_name || 'Customer'}
                  {selectedQuote.customer_phone && ` (${selectedQuote.customer_phone})`}
                </p>
              </div>
              <button
                onClick={() => setSelectedQuote(null)}
                className="rounded p-1 text-gray-400 hover:text-gray-600"
              >
                <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <span className={`mt-2 inline-block rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_COLORS[selectedQuote.status]}`}>
              {selectedQuote.status}
            </span>

            {/* Cart Items */}
            <div className="mt-4">
              <p className="text-xs font-medium uppercase tracking-wide text-gray-500">Cart Items</p>
              <div className="mt-2 space-y-2">
                {(selectedQuote.cart_snapshot || []).map((item, i) => (
                  <div key={i} className="rounded-lg bg-gray-50 p-3">
                    <div className="flex items-center justify-between">
                      <p className="text-sm font-medium text-gray-900">
                        {item.name}{item.variant_label ? ` (${item.variant_label})` : ''}
                      </p>
                      <p className="text-sm text-gray-700">{formatCurrency(item.price * item.quantity, country)}</p>
                    </div>
                    <p className="text-xs text-gray-500">Qty: {item.quantity} @ {formatCurrency(item.price, country)}</p>
                    {item.addons && item.addons.length > 0 && (
                      <div className="mt-1">
                        {item.addons.map((addon, j) => (
                          <p key={j} className="text-xs text-gray-500">
                            + {addon.name}: {formatCurrency(addon.price * (addon.quantity || 1), country)}
                          </p>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>

            {/* Add-ons */}
            {selectedQuote.addons_snapshot && selectedQuote.addons_snapshot.length > 0 && (
              <div className="mt-4">
                <p className="text-xs font-medium uppercase tracking-wide text-gray-500">Add-ons</p>
                <div className="mt-2 space-y-1">
                  {selectedQuote.addons_snapshot.map((addon, i) => (
                    <p key={i} className="text-sm text-gray-700">
                      {addon.name} — {formatCurrency(addon.price * (addon.quantity || 1), country)}
                    </p>
                  ))}
                </div>
              </div>
            )}

            {/* Delivery */}
            {(selectedQuote.delivery_zone_name || selectedQuote.delivery_address) && (
              <div className="mt-4">
                <p className="text-xs font-medium uppercase tracking-wide text-gray-500">Delivery</p>
                {selectedQuote.delivery_zone_name && (
                  <p className="mt-1 text-sm text-gray-700">Zone: {selectedQuote.delivery_zone_name}</p>
                )}
                {selectedQuote.delivery_address && (
                  <p className="mt-0.5 text-sm text-gray-700">Address: {selectedQuote.delivery_address}</p>
                )}
              </div>
            )}

            {/* Summary */}
            <div className="mt-4 rounded-lg border border-gray-200 p-3">
              <div className="flex justify-between text-sm">
                <span className="text-gray-600">Estimated Subtotal</span>
                <span className="font-medium text-gray-900">{formatCurrency(selectedQuote.estimated_subtotal, country)}</span>
              </div>
              {selectedQuote.quoted_amount != null && (
                <div className="mt-1 flex justify-between text-sm">
                  <span className="text-brand">Your Quoted Price</span>
                  <span className="font-bold text-brand">{formatCurrency(selectedQuote.quoted_amount, country)}</span>
                </div>
              )}
            </div>

            {/* Notes */}
            {selectedQuote.quote_notes && (
              <div className="mt-3">
                <p className="text-xs font-medium text-gray-500">Your Notes</p>
                <p className="mt-1 text-sm text-gray-700">{selectedQuote.quote_notes}</p>
              </div>
            )}

            {selectedQuote.customer_response && (
              <div className="mt-3">
                <p className="text-xs font-medium text-gray-500">Customer Response</p>
                <p className="mt-1 text-sm text-gray-700">{selectedQuote.customer_response}</p>
              </div>
            )}

            {/* Respond Form (only for pending quotes) */}
            {selectedQuote.status === 'pending' && (
              <div className="mt-5 border-t border-gray-100 pt-4">
                <p className="text-sm font-semibold text-gray-900">Respond to Quote</p>
                <div className="mt-3 space-y-3">
                  <div>
                    <label className="mb-1 block text-xs font-medium text-gray-600">Quoted Amount ({curr})</label>
                    <div className="relative">
                      <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-gray-400">{curr}</span>
                      <input
                        type="number"
                        min={0}
                        value={respondAmount}
                        onChange={(e) => setRespondAmount(e.target.value)}
                        placeholder={String(selectedQuote.estimated_subtotal)}
                        className="w-full rounded-lg border border-gray-200 py-2 pl-7 pr-3 text-sm outline-none focus:border-brand"
                      />
                    </div>
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-gray-600">Notes (optional)</label>
                    <textarea
                      value={respondNotes}
                      onChange={(e) => setRespondNotes(e.target.value)}
                      rows={2}
                      placeholder="e.g. Price includes setup and delivery"
                      className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand"
                    />
                  </div>
                  <button
                    onClick={handleRespond}
                    disabled={responding || !respondAmount}
                    className="rounded-lg bg-brand px-6 py-2.5 text-sm font-semibold text-white hover:bg-brand-600 disabled:opacity-50"
                  >
                    {responding ? 'Sending...' : 'Send Quote to Customer'}
                  </button>
                </div>
              </div>
            )}

            <button
              onClick={() => setSelectedQuote(null)}
              className="mt-4 w-full rounded-lg border border-gray-200 py-2 text-sm font-medium text-gray-600 hover:bg-gray-50"
            >
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
