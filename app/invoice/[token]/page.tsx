'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { ReturnToWhatsApp } from '@/components/ReturnToWhatsApp';

interface InvoiceItem {
  id: string;
  description: string;
  quantity: number;
  unit_price: number;
  amount: number;
  sort_order: number;
}

interface InvoiceData {
  id: string;
  reference_code: string;
  customer_name: string;
  customer_email: string | null;
  customer_address: string | null;
  status: string;
  subtotal: number;
  tax_rate: number;
  tax_amount: number;
  discount_type: string | null;
  discount_value: number;
  discount_amount: number;
  total_amount: number;
  amount_paid: number;
  currency: string;
  issue_date: string;
  due_date: string | null;
  notes: string | null;
  terms: string | null;
  paid_at: string | null;
  business_name: string;
  logo_url: string | null;
  show_logo: boolean;
  whitelabel: boolean;
  items: InvoiceItem[];
}

type PageState = 'loading' | 'ready' | 'paying' | 'paid' | 'error';

function formatAmount(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(amount);
  } catch {
    return `${currency} ${amount.toLocaleString()}`;
  }
}

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
  } catch {
    return iso;
  }
}

export default function InvoicePage() {
  const params = useParams();
  const token = params.token as string;

  const [invoice, setInvoice] = useState<InvoiceData | null>(null);
  const [state, setState] = useState<PageState>('loading');
  const [errorMsg, setErrorMsg] = useState('');

  useEffect(() => {
    async function fetchInvoice() {
      try {
        const res = await fetch(`/api/invoices/public/${token}`);
        if (!res.ok) {
          const data = await res.json();
          setErrorMsg(data.error || 'Unable to load invoice');
          setState('error');
          return;
        }
        const data = await res.json();
        setInvoice(data);
        setState(data.status === 'paid' ? 'paid' : 'ready');
      } catch {
        setErrorMsg('Unable to load invoice. Please check your link.');
        setState('error');
      }
    }
    if (token) fetchInvoice();
  }, [token]);

  async function handlePay() {
    setState('paying');
    try {
      const res = await fetch('/api/invoices/pay', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });

      if (!res.ok) {
        const data = await res.json();
        setErrorMsg(data.error || 'Payment initialization failed');
        setState('ready');
        return;
      }

      const data = await res.json();
      if (data.url) {
        window.location.href = data.url;
      } else {
        setErrorMsg('Could not get payment URL');
        setState('ready');
      }
    } catch {
      setErrorMsg('Payment failed. Please try again.');
      setState('ready');
    }
  }

  if (state === 'loading') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50">
        <div className="text-center">
          <div className="mx-auto h-10 w-10 animate-spin rounded-full border-4 border-gray-200 border-t-violet-600" />
          <p className="mt-4 text-gray-500">Loading invoice...</p>
        </div>
      </div>
    );
  }

  if (state === 'error') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50 p-6">
        <div className="max-w-sm text-center">
          <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-red-100">
            <svg className="h-8 w-8 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </div>
          <h1 className="text-xl font-bold text-gray-900">Unable to Load Invoice</h1>
          <p className="mt-2 text-gray-600">{errorMsg}</p>
        </div>
      </div>
    );
  }

  if (!invoice) return null;

  const balance = invoice.total_amount - invoice.amount_paid;
  const isPaid = state === 'paid' || invoice.status === 'paid';

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="border-b bg-white px-4 py-4 shadow-sm">
        <div className="mx-auto max-w-lg">
          <div className="flex items-center gap-3">
            {invoice.logo_url && invoice.show_logo && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={invoice.logo_url}
                alt={invoice.business_name}
                className="h-10 w-10 rounded-lg object-contain"
              />
            )}
            <div>
              <p className="text-xs font-medium uppercase tracking-wider text-gray-400">Invoice from</p>
              <p className="text-sm font-bold text-gray-900">{invoice.business_name}</p>
            </div>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-lg px-4 py-6">
        {/* Status banner */}
        {isPaid && (
          <div className="mb-4 flex items-center gap-3 rounded-xl bg-green-50 border border-green-200 p-4">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-green-100">
              <svg className="h-5 w-5 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
            </div>
            <div>
              <p className="text-sm font-bold text-green-700">Paid</p>
              {invoice.paid_at && (
                <p className="text-xs text-green-600">on {formatDate(invoice.paid_at)}</p>
              )}
            </div>
          </div>
        )}

        {/* Invoice card */}
        <div className="rounded-xl border border-gray-200 bg-white shadow-sm">
          {/* Header info */}
          <div className="border-b border-gray-100 px-5 py-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs font-medium text-gray-400">Reference</p>
                <p className="text-sm font-bold text-gray-900">{invoice.reference_code}</p>
              </div>
              <div className="text-right">
                <p className="text-xs font-medium text-gray-400">Total</p>
                <p className="text-lg font-bold text-gray-900">{formatAmount(invoice.total_amount, invoice.currency)}</p>
              </div>
            </div>
            <div className="mt-3 flex gap-6 text-xs text-gray-500">
              <div>
                <span className="font-medium">Issued:</span> {formatDate(invoice.issue_date)}
              </div>
              <div>
                <span className="font-medium">Due:</span> {formatDate(invoice.due_date)}
              </div>
            </div>
          </div>

          {/* Bill to */}
          <div className="border-b border-gray-100 px-5 py-3">
            <p className="text-xs font-medium text-gray-400">Bill To</p>
            <p className="text-sm font-medium text-gray-900">{invoice.customer_name}</p>
            {invoice.customer_email && <p className="text-xs text-gray-500">{invoice.customer_email}</p>}
            {invoice.customer_address && <p className="text-xs text-gray-500">{invoice.customer_address}</p>}
          </div>

          {/* Line items */}
          <div className="px-5 py-4">
            <table className="w-full">
              <thead>
                <tr className="text-xs font-medium text-gray-400">
                  <th className="pb-2 text-left">Item</th>
                  <th className="pb-2 text-center">Qty</th>
                  <th className="pb-2 text-right">Price</th>
                  <th className="pb-2 text-right">Amount</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {invoice.items.map(item => (
                  <tr key={item.id}>
                    <td className="py-2 text-sm text-gray-700">{item.description}</td>
                    <td className="py-2 text-center text-sm text-gray-500">{item.quantity}</td>
                    <td className="py-2 text-right text-sm text-gray-500">{formatAmount(item.unit_price, invoice.currency)}</td>
                    <td className="py-2 text-right text-sm font-medium text-gray-700">{formatAmount(item.amount, invoice.currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Totals */}
          <div className="border-t border-gray-100 px-5 py-4 space-y-1">
            <div className="flex justify-between text-sm">
              <span className="text-gray-500">Subtotal</span>
              <span className="text-gray-700">{formatAmount(invoice.subtotal, invoice.currency)}</span>
            </div>
            {invoice.tax_rate > 0 && (
              <div className="flex justify-between text-sm">
                <span className="text-gray-500">Tax ({invoice.tax_rate}%)</span>
                <span className="text-gray-700">{formatAmount(invoice.tax_amount, invoice.currency)}</span>
              </div>
            )}
            {invoice.discount_amount > 0 && (
              <div className="flex justify-between text-sm">
                <span className="text-gray-500">
                  Discount {invoice.discount_type === 'percent' ? `(${invoice.discount_value}%)` : ''}
                </span>
                <span className="text-red-500">-{formatAmount(invoice.discount_amount, invoice.currency)}</span>
              </div>
            )}
            <div className="flex justify-between border-t border-gray-100 pt-2 text-sm font-bold">
              <span className="text-gray-700">Total</span>
              <span className="text-gray-900">{formatAmount(invoice.total_amount, invoice.currency)}</span>
            </div>
            {invoice.amount_paid > 0 && invoice.amount_paid < invoice.total_amount && (
              <>
                <div className="flex justify-between text-sm">
                  <span className="text-gray-500">Paid</span>
                  <span className="text-green-600">{formatAmount(invoice.amount_paid, invoice.currency)}</span>
                </div>
                <div className="flex justify-between text-sm font-bold">
                  <span className="text-gray-700">Balance Due</span>
                  <span className="text-gray-900">{formatAmount(balance, invoice.currency)}</span>
                </div>
              </>
            )}
          </div>

          {/* Notes & Terms */}
          {(invoice.notes || invoice.terms) && (
            <div className="border-t border-gray-100 px-5 py-4 space-y-3">
              {invoice.notes && (
                <div>
                  <p className="text-xs font-medium text-gray-400">Notes</p>
                  <p className="mt-1 text-sm text-gray-600">{invoice.notes}</p>
                </div>
              )}
              {invoice.terms && (
                <div>
                  <p className="text-xs font-medium text-gray-400">Terms</p>
                  <p className="mt-1 text-sm text-gray-600">{invoice.terms}</p>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="mt-6 space-y-3">
          {!isPaid && (
            <button
              onClick={handlePay}
              disabled={state === 'paying'}
              className="w-full rounded-xl bg-violet-600 px-6 py-4 text-center text-base font-bold text-white shadow-md transition hover:bg-violet-700 disabled:opacity-50"
            >
              {state === 'paying' ? (
                <span className="flex items-center justify-center gap-2">
                  <div className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
                  Processing...
                </span>
              ) : (
                `Pay ${formatAmount(balance > 0 ? balance : invoice.total_amount, invoice.currency)}`
              )}
            </button>
          )}

          {errorMsg && state === 'ready' && (
            <p className="text-center text-sm text-red-600">{errorMsg}</p>
          )}

          <a
            href={`/api/invoices/pdf/${invoice.id}?token=${token}`}
            className="flex w-full items-center justify-center gap-2 rounded-xl border border-gray-200 bg-white px-4 py-3 text-sm font-medium text-gray-700 shadow-sm transition hover:bg-gray-50"
          >
            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
            Download PDF
          </a>
        </div>

        {/* Return to WhatsApp */}
        <div className="mt-6 text-center">
          <ReturnToWhatsApp />
        </div>

        {/* Footer — hidden for whitelabel */}
        {!invoice.whitelabel && (
          <p className="mt-4 text-center text-xs text-gray-400">
            Powered by Waaiio
          </p>
        )}
      </main>
    </div>
  );
}
