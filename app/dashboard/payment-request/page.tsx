'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { useBusiness } from '@/components/dashboard/DashboardProvider';
import { createClient } from '@/lib/supabase/client';
import { formatCurrency, type CountryCode } from '@/lib/constants';
import EmptyState from '@/components/dashboard/EmptyState';
import { PageHelp } from '@/components/dashboard/PageHelp';
import { PhoneInput } from '@/components/auth/PhoneInput';

interface PaymentRow {
  status: string;
  gateway: string | null;
  gateway_reference: string | null;
  amount: number | null;
  currency: string | null;
  created_at: string | null;
  metadata: { square_checkout_url?: string; checkout_url?: string; checkout_short_ref?: string } | null;
}

interface PaymentRequestRow {
  id: string;
  reference_code: string;
  guest_name: string | null;
  guest_phone: string;
  total_amount: number;
  status: string;
  notes: string | null;
  created_at: string;
  channel: string | null;
  payments: PaymentRow[] | null;
}

interface CustomerSuggestion {
  phone: string;
  name: string | null;
}

type SendVia = 'whatsapp' | 'email' | 'both';
type RequestMode = 'single' | 'bulk';

function parseBulkRecipients(text: string): { phones: string[]; emails: string[] } {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const phones: string[] = [];
  const emails: string[] = [];
  for (const line of lines) {
    if (line.includes('@')) {
      emails.push(line);
    } else {
      phones.push(line);
    }
  }
  return { phones, emails };
}

export default function PaymentRequestPage() {
  const business = useBusiness();
  const country = (business.country_code || 'NG') as CountryCode;
  const [requests, setRequests] = useState<PaymentRequestRow[]>([]);
  const [loading, setLoading] = useState(true);

  // Mode
  const [mode, setMode] = useState<RequestMode>('single');

  // Single form
  const [phone, setPhone] = useState('');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('');
  const [sendVia, setSendVia] = useState<SendVia>('whatsapp');
  const [sending, setSending] = useState(false);
  const [statusMessage, setStatusMessage] = useState('');
  const [selectedRequest, setSelectedRequest] = useState<PaymentRequestRow | null>(null);
  const [copied, setCopied] = useState(false);

  // Bulk form
  const [bulkRecipients, setBulkRecipients] = useState('');
  const [bulkProgress, setBulkProgress] = useState('');

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
      .select('id, reference_code, guest_name, guest_phone, total_amount, status, notes, created_at, channel, payments(status, gateway, gateway_reference, amount, currency, created_at, metadata)')
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

  // Validation for single mode
  function isSingleFormValid(): boolean {
    if (!amount) return false;
    if (sendVia === 'whatsapp' && !phone.trim()) return false;
    if (sendVia === 'email' && !email.trim()) return false;
    if (sendVia === 'both' && (!phone.trim() || !email.trim())) return false;
    return true;
  }

  // Validation for bulk mode
  function isBulkFormValid(): boolean {
    if (!amount) return false;
    const { phones, emails } = parseBulkRecipients(bulkRecipients);
    return phones.length + emails.length > 0;
  }

  async function handleSubmit() {
    if (!isSingleFormValid()) return;
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
          customerPhone: phone.trim() || undefined,
          customerName: name.trim() || undefined,
          customerEmail: email.trim() || undefined,
          amount: amountNum,
          description: description.trim() || undefined,
          sendVia,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        setStatusMessage('Payment request sent!');
        setPhone('');
        setName('');
        setEmail('');
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

  async function handleBulkSubmit() {
    if (!isBulkFormValid()) return;
    const amountNum = parseFloat(amount);
    if (isNaN(amountNum) || amountNum <= 0) {
      setStatusMessage('Please enter a valid amount');
      return;
    }

    const { phones, emails } = parseBulkRecipients(bulkRecipients);
    const recipients = [
      ...phones.map(p => ({ phone: p, email: '', sendVia: 'whatsapp' as const })),
      ...emails.map(e => ({ phone: '', email: e, sendVia: 'email' as const })),
    ];

    setSending(true);
    setStatusMessage('');
    let sent = 0;
    let failed = 0;

    for (let i = 0; i < recipients.length; i++) {
      const r = recipients[i];
      setBulkProgress(`Sending ${i + 1} of ${recipients.length}...`);

      try {
        const res = await fetch('/api/payment-request/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            businessId: business.id,
            customerPhone: r.phone || undefined,
            customerEmail: r.email || undefined,
            amount: amountNum,
            description: description.trim() || undefined,
            sendVia: 'auto',
          }),
        });
        if (res.ok) {
          sent++;
        } else {
          failed++;
        }
      } catch {
        failed++;
      }

      // Small delay to avoid rate limits
      if (i < recipients.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }

    setBulkProgress('');
    setStatusMessage(`${sent} sent, ${failed} failed`);
    if (sent > 0) {
      setBulkRecipients('');
      setAmount('');
      setDescription('');
      loadRequests();
    }
    setSending(false);
  }

  function getCheckoutUrl(row: PaymentRequestRow): string | null {
    const payment = row.payments?.[0];
    if (!payment?.metadata) return null;
    return payment.metadata.square_checkout_url || payment.metadata.checkout_url || null;
  }

  function getProvider(row: PaymentRequestRow): string | null {
    return row.payments?.[0]?.gateway || null;
  }

  function getDeliveryMethod(row: PaymentRequestRow): string {
    const contact = row.guest_phone || '';
    if (contact.includes('@')) return 'Email';
    if (contact.startsWith('+') || /^\d{7,}$/.test(contact)) return 'WhatsApp';
    return row.channel || 'Unknown';
  }

  async function copyLink(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* clipboard not available */ }
  }

  function getPaymentStatus(row: PaymentRequestRow): { label: string; color: string } {
    const paymentStatuses = row.payments?.map(p => p.status) || [];
    if (paymentStatuses.includes('success')) {
      return { label: 'Paid', color: 'bg-green-100 text-green-700' };
    }
    if (paymentStatuses.includes('refunded')) {
      return { label: 'Refunded', color: 'bg-purple-100 text-purple-700' };
    }
    if (paymentStatuses.includes('failed')) {
      return { label: 'Failed', color: 'bg-red-100 text-red-700' };
    }
    if (paymentStatuses.includes('pending')) {
      return { label: 'Pending', color: 'bg-amber-100 text-amber-700' };
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
  const bulkParsed = parseBulkRecipients(bulkRecipients);
  const bulkPhoneCount = bulkParsed.phones.length;
  const bulkEmailCount = bulkParsed.emails.length;

  return (
    <div>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Request Payment</h1>
          <p className="mt-1 text-sm text-gray-500">Send payment links to customers via WhatsApp or email</p>
        </div>
      </div>

      <PageHelp
        pageKey="payment-request"
        title="Payment Requests"
        description="Send payment links to customers via WhatsApp or email. They click and pay instantly."
      />

      {/* Send form */}
      <div className="mt-6 rounded-xl border border-gray-100 bg-white p-6">
        {/* Mode tabs */}
        <div className="flex gap-2 mb-4">
          <button
            onClick={() => setMode('single')}
            className={`rounded-lg border px-4 py-2 text-sm font-medium transition-colors ${mode === 'single' ? 'border-brand bg-brand/10 text-brand' : 'border-gray-200 text-gray-500 hover:text-gray-700'}`}
          >
            Single Request
          </button>
          <button
            onClick={() => setMode('bulk')}
            className={`rounded-lg border px-4 py-2 text-sm font-medium transition-colors ${mode === 'bulk' ? 'border-brand bg-brand/10 text-brand' : 'border-gray-200 text-gray-500 hover:text-gray-700'}`}
          >
            Bulk Request
          </button>
        </div>

        <h3 className="text-sm font-semibold text-gray-900">
          {mode === 'single' ? 'Send Payment Request' : 'Send Bulk Payment Request'}
        </h3>

        {mode === 'single' ? (
          <>
            {/* Delivery method toggle */}
            <div className="mt-4">
              <label className="mb-1 block text-xs font-medium text-gray-700">Send via</label>
              <div className="flex gap-2">
                <button
                  onClick={() => setSendVia('whatsapp')}
                  className={`flex-1 rounded-lg border px-3 py-2 text-xs font-medium transition-colors ${sendVia === 'whatsapp' ? 'border-whatsapp bg-whatsapp/10 text-whatsapp' : 'border-gray-200 text-gray-500'}`}
                >
                  WhatsApp
                </button>
                <button
                  onClick={() => setSendVia('email')}
                  className={`flex-1 rounded-lg border px-3 py-2 text-xs font-medium transition-colors ${sendVia === 'email' ? 'border-brand bg-brand/10 text-brand' : 'border-gray-200 text-gray-500'}`}
                >
                  Email
                </button>
                <button
                  onClick={() => setSendVia('both')}
                  className={`flex-1 rounded-lg border px-3 py-2 text-xs font-medium transition-colors ${sendVia === 'both' ? 'border-brand bg-brand/10 text-brand' : 'border-gray-200 text-gray-500'}`}
                >
                  Both
                </button>
              </div>
            </div>

            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              {/* Phone field — shown for whatsapp and both */}
              {(sendVia === 'whatsapp' || sendVia === 'both') && (
                <div className="relative">
                  <label className="mb-1 block text-sm font-medium text-gray-700">
                    Customer Phone <span className="text-red-400">*</span>
                  </label>
                  {/* Customer search */}
                  <div className="relative mb-2">
                    <input
                      ref={phoneInputRef}
                      type="text"
                      onFocus={() => {
                        setSuggestions(customers.slice(0, 5));
                        setShowSuggestions(true);
                      }}
                      onChange={e => {
                        const q = e.target.value.toLowerCase();
                        if (q.length > 0) {
                          setSuggestions(
                            customers.filter(c =>
                              c.phone.includes(q) || c.name?.toLowerCase().includes(q)
                            ).slice(0, 5)
                          );
                        } else {
                          setSuggestions(customers.slice(0, 5));
                        }
                        setShowSuggestions(true);
                      }}
                      onBlur={() => setTimeout(() => setShowSuggestions(false), 200)}
                      placeholder="Search existing customers..."
                      className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand"
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
                  <PhoneInput
                    value={phone}
                    onChange={setPhone}
                    countryCode={country}
                  />
                </div>
              )}

              {/* Email field — shown for email and both */}
              {(sendVia === 'email' || sendVia === 'both') && (
                <div>
                  <label className="mb-1 block text-sm font-medium text-gray-700">
                    Customer Email <span className="text-red-400">*</span>
                  </label>
                  <input
                    type="email"
                    value={email}
                    onChange={e => setEmail(e.target.value)}
                    placeholder="customer@example.com"
                    className="w-full rounded-lg border border-gray-200 px-3 py-3 text-sm outline-none focus:border-brand"
                  />
                </div>
              )}

              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">Customer Name</label>
                <input
                  type="text"
                  value={name}
                  onChange={e => setName(e.target.value)}
                  placeholder="Optional"
                  className="w-full rounded-lg border border-gray-200 px-3 py-3 text-sm outline-none focus:border-brand"
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
                  className="w-full rounded-lg border border-gray-200 px-3 py-3 text-sm outline-none focus:border-brand"
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
                disabled={sending || !isSingleFormValid()}
                className="rounded-lg bg-brand px-6 py-2.5 text-sm font-semibold text-white hover:bg-brand-600 disabled:opacity-50"
              >
                {sending ? 'Sending...' : 'Send Payment Request'}
              </button>
            </div>
          </>
        ) : (
          /* Bulk mode */
          <>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <div className="sm:col-span-2">
                <label className="mb-1 block text-xs font-medium text-gray-700">Recipients</label>
                <textarea
                  value={bulkRecipients}
                  onChange={e => setBulkRecipients(e.target.value)}
                  placeholder={'One per line: phone number or email\ne.g.\n+2348012345678\ncustomer@email.com\n+1234567890'}
                  rows={5}
                  className="w-full rounded-lg border border-gray-200 px-3 py-3 text-sm outline-none focus:border-brand"
                />
                <p className="text-xs text-gray-400 mt-1">Enter phone numbers or emails, one per line</p>
                {(bulkPhoneCount > 0 || bulkEmailCount > 0) && (
                  <p className="text-xs text-brand mt-1 font-medium">
                    Sending to: {bulkPhoneCount > 0 && `${bulkPhoneCount} WhatsApp`}{bulkPhoneCount > 0 && bulkEmailCount > 0 && ', '}{bulkEmailCount > 0 && `${bulkEmailCount} Email`}
                  </p>
                )}
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
                  className="w-full rounded-lg border border-gray-200 px-3 py-3 text-sm outline-none focus:border-brand"
                />
              </div>
            </div>

            {bulkProgress && (
              <div className="mt-4 rounded-lg bg-blue-50 px-4 py-3 text-sm text-blue-700">
                {bulkProgress}
              </div>
            )}

            {statusMessage && (
              <div className={`mt-4 rounded-lg px-4 py-3 text-sm ${statusMessage.includes('failed') && !statusMessage.includes('0 failed') ? 'bg-amber-50 text-amber-700' : 'bg-green-50 text-green-700'}`}>
                {statusMessage}
              </div>
            )}

            <div className="mt-4">
              <button
                onClick={handleBulkSubmit}
                disabled={sending || !isBulkFormValid()}
                className="rounded-lg bg-brand px-6 py-2.5 text-sm font-semibold text-white hover:bg-brand-600 disabled:opacity-50"
              >
                {sending ? 'Sending...' : `Send to ${bulkPhoneCount + bulkEmailCount} recipient${bulkPhoneCount + bulkEmailCount !== 1 ? 's' : ''}`}
              </button>
            </div>
          </>
        )}
      </div>

      {/* Payment Requests */}
      {requests.length === 0 ? (
        <EmptyState
          icon="💳"
          title="No payment requests yet"
          description="Requests you send will appear here. Enter a phone number or email and amount above to get started."
        />
      ) : (
        <div className="mt-8">
          <h3 className="text-sm font-semibold text-gray-900">Payment Requests</h3>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-gray-100 text-xs font-medium uppercase tracking-wider text-gray-400">
                  <th scope="col" className="pb-3 pr-4">Customer</th>
                  <th scope="col" className="pb-3 pr-4">Amount</th>
                  <th scope="col" className="pb-3 pr-4">Sent</th>
                  <th scope="col" className="pb-3 pr-4">Status</th>
                  <th scope="col" className="pb-3 pr-4">Via</th>
                  <th scope="col" className="pb-3 pr-4">Provider</th>
                  <th scope="col" className="pb-3">Actions</th>
                </tr>
              </thead>
              <tbody>
                {requests.map(row => {
                  const payStatus = getPaymentStatus(row);
                  const checkoutUrl = getCheckoutUrl(row);
                  const provider = getProvider(row);
                  const isPending = payStatus.label === 'Pending';
                  return (
                    <tr key={row.id} className="border-b border-gray-50 hover:bg-gray-50/50 cursor-pointer" onClick={() => setSelectedRequest(row)}>
                      <td className="py-3 pr-4">
                        <p className="font-medium text-gray-900">{row.guest_name || 'Customer'}</p>
                        <p className="text-xs text-gray-400 font-mono">{row.guest_phone}</p>
                      </td>
                      <td className="py-3 pr-4 font-semibold text-gray-900">{formatCurrency(row.total_amount, country)}</td>
                      <td className="py-3 pr-4 text-gray-500 text-xs">
                        {new Date(row.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
                      </td>
                      <td className="py-3 pr-4">
                        <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${payStatus.color}`}>
                          {payStatus.label}
                        </span>
                      </td>
                      <td className="py-3 pr-4 text-xs text-gray-500">{getDeliveryMethod(row)}</td>
                      <td className="py-3 pr-4 text-xs text-gray-500 capitalize">{provider || '-'}</td>
                      <td className="py-3">
                        {isPending && checkoutUrl && (
                          <div className="flex items-center gap-2" onClick={e => e.stopPropagation()}>
                            <button
                              onClick={() => copyLink(checkoutUrl)}
                              className="rounded-md bg-gray-100 px-2 py-1 text-xs font-medium text-gray-700 hover:bg-gray-200 transition"
                            >
                              {copied ? 'Copied!' : 'Copy Link'}
                            </button>
                            <a
                              href={checkoutUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="rounded-md bg-brand/10 px-2 py-1 text-xs font-medium text-brand hover:bg-brand/20 transition"
                            >
                              Open
                            </a>
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Detail View Modal */}
      {selectedRequest && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setSelectedRequest(null)}>
          <div className="w-full max-w-md rounded-xl bg-white p-6 shadow-xl" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-semibold text-gray-900">Payment Request</h3>
              <button onClick={() => setSelectedRequest(null)} className="text-gray-400 hover:text-gray-600">
                <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
              </button>
            </div>

            <div className="mt-4 space-y-3 text-sm">
              <div className="flex justify-between">
                <span className="text-gray-500">Recipient</span>
                <span className="font-medium text-gray-900">{selectedRequest.guest_name || 'Customer'}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">Contact</span>
                <span className="font-mono text-xs text-gray-700">{selectedRequest.guest_phone}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">Amount</span>
                <span className="font-semibold text-gray-900">{formatCurrency(selectedRequest.total_amount, country)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">Reference</span>
                <span className="font-mono text-xs text-gray-700">{selectedRequest.reference_code}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">Provider</span>
                <span className="capitalize text-gray-700">{getProvider(selectedRequest) || 'Not assigned'}</span>
              </div>
              {selectedRequest.payments?.[0]?.gateway_reference && (
                <div className="flex justify-between">
                  <span className="text-gray-500">Gateway Ref</span>
                  <span className="font-mono text-xs text-gray-700">{selectedRequest.payments[0].gateway_reference}</span>
                </div>
              )}
              <div className="flex justify-between">
                <span className="text-gray-500">Created</span>
                <span className="text-gray-700">{new Date(selectedRequest.created_at).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
              </div>
              {selectedRequest.payments?.[0]?.status === 'success' && selectedRequest.payments[0].created_at && (
                <div className="flex justify-between">
                  <span className="text-gray-500">Paid</span>
                  <span className="text-green-700">{new Date(selectedRequest.payments[0].created_at).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
                </div>
              )}
              {selectedRequest.notes && (
                <div className="flex justify-between">
                  <span className="text-gray-500">Note</span>
                  <span className="text-gray-700 text-right max-w-[200px]">{selectedRequest.notes}</span>
                </div>
              )}
              <div className="flex justify-between items-center">
                <span className="text-gray-500">Status</span>
                {(() => {
                  const s = getPaymentStatus(selectedRequest);
                  return <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${s.color}`}>{s.label}</span>;
                })()}
              </div>
            </div>

            {/* Actions for pending requests */}
            {getPaymentStatus(selectedRequest).label === 'Pending' && getCheckoutUrl(selectedRequest) && (
              <div className="mt-5 flex gap-2">
                <button
                  onClick={() => copyLink(getCheckoutUrl(selectedRequest)!)}
                  className="flex-1 rounded-lg bg-gray-100 px-4 py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-200 transition"
                >
                  {copied ? 'Copied!' : 'Copy Payment Link'}
                </button>
                <a
                  href={getCheckoutUrl(selectedRequest)!}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex-1 rounded-lg bg-brand px-4 py-2.5 text-center text-sm font-medium text-white hover:bg-brand-600 transition"
                >
                  Open Payment Link
                </a>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
