'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { useBusiness } from '@/components/dashboard/DashboardProvider';
import { createClient } from '@/lib/supabase/client';
import { formatCurrency, type CountryCode } from '@/lib/constants';
import EmptyState from '@/components/dashboard/EmptyState';
import { PageHelp } from '@/components/dashboard/PageHelp';

interface PaymentRequestRow {
  id: string;
  reference_code: string;
  guest_name: string | null;
  guest_phone: string;
  total_amount: number;
  status: string;
  notes: string | null;
  created_at: string;
  payments: { status: string }[] | null;
}

interface CustomerSuggestion {
  phone: string;
  name: string | null;
}

export default function PaymentRequestPage() {
  const business = useBusiness();
  const country = (business.country_code || 'NG') as CountryCode;
  const [requests, setRequests] = useState<PaymentRequestRow[]>([]);
  const [loading, setLoading] = useState(true);

  // Form
  const [phone, setPhone] = useState('');
  const [name, setName] = useState('');
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('');
  const [sending, setSending] = useState(false);
  const [statusMessage, setStatusMessage] = useState('');

  // Customer autocomplete
  const [customers, setCustomers] = useState<CustomerSuggestion[]>([]);
  const [suggestions, setSuggestions] = useState<CustomerSuggestion[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const phoneInputRef = useRef<HTMLInputElement>(null);

  // Load existing customers for autocomplete
  useEffect(() => {
    async function loadCustomers() {
      const supabase = createClient();
      const { data } = await supabase
        .from('customer_profiles')
        .select('phone, name')
        .eq('business_id', business.id)
        .order('last_seen_at', { ascending: false })
        .limit(100);
      setCustomers((data || []) as CustomerSuggestion[]);
    }
    loadCustomers();
  }, [business.id]);

  const loadRequests = useCallback(async () => {
    const supabase = createClient();
    const { data } = await supabase
      .from('bookings')
      .select('id, reference_code, guest_name, guest_phone, total_amount, status, notes, created_at, payments(status)')
      .eq('business_id', business.id)
      .eq('flow_type', 'payment')
      .order('created_at', { ascending: false })
      .limit(50);
    setRequests((data || []) as PaymentRequestRow[]);
    setLoading(false);
  }, [business.id]);

  useEffect(() => { loadRequests(); }, [loadRequests]);

  // Realtime subscription for payment status updates
  useEffect(() => {
    const supabase = createClient();
    const channel = supabase
      .channel('payment-request-updates')
      .on('postgres_changes', {
        event: 'UPDATE',
        schema: 'public',
        table: 'payments',
        filter: `business_id=eq.${business.id}`,
      }, () => {
        loadRequests();
      })
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [business.id, loadRequests]);

  async function handleSubmit() {
    if (!phone.trim() || !amount) return;
    const amountNum = parseFloat(amount);
    if (isNaN(amountNum) || amountNum <= 0) {
      setStatusMessage('Please enter a valid amount');
      return;
    }

    setSending(true);
    setStatusMessage('');

    try {
      const res = await fetch('/api/payment-request/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          businessId: business.id,
          customerPhone: phone.trim(),
          customerName: name.trim() || undefined,
          amount: amountNum,
          description: description.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        setStatusMessage('Payment request sent!');
        setPhone('');
        setName('');
        setAmount('');
        setDescription('');
        loadRequests();
      } else {
        setStatusMessage(data.error || 'Failed to send payment request');
      }
    } catch {
      setStatusMessage('Failed to send payment request');
    }
    setSending(false);
  }

  function getPaymentStatus(row: PaymentRequestRow): { label: string; color: string } {
    const paymentStatuses = row.payments?.map(p => p.status) || [];
    if (paymentStatuses.includes('completed') || paymentStatuses.includes('successful')) {
      return { label: 'Paid', color: 'bg-green-100 text-green-700' };
    }
    if (paymentStatuses.includes('pending')) {
      return { label: 'Pending', color: 'bg-amber-100 text-amber-700' };
    }
    // Check if older than 24 hours with no payment
    const age = Date.now() - new Date(row.created_at).getTime();
    if (age > 24 * 60 * 60 * 1000) {
      return { label: 'Expired', color: 'bg-gray-100 text-gray-600' };
    }
    return { label: 'Pending', color: 'bg-amber-100 text-amber-700' };
  }

  if (loading) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-brand border-t-transparent" />
      </div>
    );
  }

  const curr = formatCurrency(0, country).charAt(0);

  return (
    <div>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Request Payment</h1>
          <p className="mt-1 text-sm text-gray-500">Send payment links to customers via WhatsApp</p>
        </div>
      </div>

      <PageHelp
        pageKey="payment-request"
        title="Payment Requests"
        description="Send payment links to customers via WhatsApp. They click and pay instantly."
      />

      {/* Send form */}
      <div className="mt-6 rounded-xl border border-gray-100 bg-white p-6">
        <h3 className="text-sm font-semibold text-gray-900">Send Payment Request</h3>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div className="relative">
            <label className="mb-1 block text-sm font-medium text-gray-700">Customer Phone <span className="text-red-400">*</span></label>
            <input
              ref={phoneInputRef}
              type="tel"
              value={phone}
              onChange={e => {
                const val = e.target.value;
                setPhone(val);
                const q = val.toLowerCase();
                if (q.length > 0) {
                  setSuggestions(
                    customers.filter(c =>
                      c.phone.includes(q) || c.name?.toLowerCase().includes(q)
                    ).slice(0, 5)
                  );
                  setShowSuggestions(true);
                } else {
                  setSuggestions(customers.slice(0, 5));
                  setShowSuggestions(true);
                }
              }}
              onFocus={() => {
                if (!phone) {
                  setSuggestions(customers.slice(0, 5));
                } else {
                  const q = phone.toLowerCase();
                  setSuggestions(
                    customers.filter(c =>
                      c.phone.includes(q) || c.name?.toLowerCase().includes(q)
                    ).slice(0, 5)
                  );
                }
                setShowSuggestions(true);
              }}
              onBlur={() => setTimeout(() => setShowSuggestions(false), 200)}
              placeholder="Enter phone or search customer"
              className="w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm outline-none focus:border-brand"
            />
            {showSuggestions && suggestions.length > 0 && (
              <div className="absolute z-10 mt-1 w-full rounded-lg border border-gray-200 bg-white shadow-lg">
                {suggestions.map(c => (
                  <button
                    key={c.phone}
                    type="button"
                    onMouseDown={e => e.preventDefault()}
                    onClick={() => {
                      setPhone(c.phone);
                      setName(c.name || '');
                      setShowSuggestions(false);
                      setSuggestions([]);
                    }}
                    className="flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-gray-50 first:rounded-t-lg last:rounded-b-lg"
                  >
                    <span className="font-medium text-gray-900">{c.name || 'Unknown'}</span>
                    <span className="font-mono text-xs text-gray-400">{c.phone}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">Customer Name</label>
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="Optional"
              className="w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm outline-none focus:border-brand"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">Amount ({curr}) <span className="text-red-400">*</span></label>
            <div className="relative">
              <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-gray-400">{curr}</span>
              <input
                type="number"
                min={1}
                value={amount || ''}
                onChange={e => setAmount(e.target.value)}
                placeholder="5000"
                className="w-full rounded-lg border border-gray-200 py-2.5 pl-7 pr-3 text-sm outline-none focus:border-brand"
              />
            </div>
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">Description</label>
            <input
              type="text"
              value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder="e.g. Balance for catering order"
              className="w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm outline-none focus:border-brand"
            />
          </div>
        </div>

        {statusMessage && (
          <div className={`mt-4 rounded-lg px-4 py-3 text-sm ${statusMessage.includes('sent') ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'}`}>
            {statusMessage}
          </div>
        )}

        <div className="mt-4">
          <button
            onClick={handleSubmit}
            disabled={sending || !phone.trim() || !amount}
            className="rounded-lg bg-brand px-6 py-2.5 text-sm font-semibold text-white hover:bg-brand-600 disabled:opacity-50"
          >
            {sending ? 'Sending...' : 'Send Payment Request'}
          </button>
        </div>
      </div>

      {/* Recent requests */}
      {requests.length === 0 ? (
        <EmptyState
          icon="💳"
          title="No payment requests yet"
          description="Request a payment from any customer — just enter their phone number and amount."
        />
      ) : (
        <div className="mt-8">
          <h3 className="text-sm font-semibold text-gray-900">Recent Requests</h3>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-gray-100 text-xs font-medium uppercase tracking-wider text-gray-400">
                  <th className="pb-3 pr-4">Customer</th>
                  <th className="pb-3 pr-4">Phone</th>
                  <th className="pb-3 pr-4">Amount</th>
                  <th className="pb-3 pr-4">Note</th>
                  <th className="pb-3 pr-4">Status</th>
                  <th className="pb-3">Date</th>
                </tr>
              </thead>
              <tbody>
                {requests.map(row => {
                  const payStatus = getPaymentStatus(row);
                  return (
                    <tr key={row.id} className="border-b border-gray-50">
                      <td className="py-3 pr-4 font-medium text-gray-900">{row.guest_name || '-'}</td>
                      <td className="py-3 pr-4 text-gray-600 font-mono text-xs">{row.guest_phone}</td>
                      <td className="py-3 pr-4 font-semibold text-gray-900">{formatCurrency(row.total_amount, country)}</td>
                      <td className="py-3 pr-4 text-gray-500 text-xs max-w-[200px] truncate">{row.notes || '-'}</td>
                      <td className="py-3 pr-4">
                        <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${payStatus.color}`}>
                          {payStatus.label}
                        </span>
                      </td>
                      <td className="py-3 text-gray-400 text-xs">
                        {new Date(row.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
