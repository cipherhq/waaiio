'use client';

import { useState, useEffect, useCallback } from 'react';
import { useBusiness } from '@/components/dashboard/DashboardProvider';
import { createClient } from '@/lib/supabase/client';

interface InvoiceItem {
  id: string;
  description: string;
  quantity: number;
  unit_price: number;
  amount: number;
  sort_order: number;
}

interface Invoice {
  id: string;
  reference_code: string;
  customer_name: string;
  customer_phone: string | null;
  customer_email: string | null;
  customer_address: string | null;
  customer_profile_id: string | null;
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
  sent_via: string | null;
  sent_at: string | null;
  paid_at: string | null;
  wa_delivery_status: string | null;
  created_at: string;
  invoice_items: InvoiceItem[];
}

interface FormItem {
  description: string;
  quantity: number;
  unit_price: number;
}

type StatusFilter = 'all' | 'draft' | 'sent' | 'viewed' | 'paid' | 'overdue' | 'cancelled';

function formatAmount(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(amount);
  } catch {
    return `${currency} ${amount.toLocaleString()}`;
  }
}

function getStatusBadge(status: string) {
  const styles: Record<string, string> = {
    draft: 'bg-gray-100 text-gray-600',
    sent: 'bg-blue-100 text-blue-700',
    viewed: 'bg-yellow-100 text-yellow-700',
    paid: 'bg-green-100 text-green-700',
    overdue: 'bg-red-100 text-red-700',
    cancelled: 'bg-gray-100 text-gray-500',
  };
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${styles[status] || styles.draft}`}>
      {status.charAt(0).toUpperCase() + status.slice(1)}
    </span>
  );
}

export default function InvoicesPage() {
  const business = useBusiness();
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [toastMsg, setToastMsg] = useState('');

  // Form state
  const [customerName, setCustomerName] = useState('');
  const [customerPhone, setCustomerPhone] = useState('');
  const [customerEmail, setCustomerEmail] = useState('');
  const [customerAddress, setCustomerAddress] = useState('');
  const [items, setItems] = useState<FormItem[]>([{ description: '', quantity: 1, unit_price: 0 }]);
  const [taxRate, setTaxRate] = useState(0);
  const [discountType, setDiscountType] = useState<'flat' | 'percent'>('flat');
  const [discountValue, setDiscountValue] = useState(0);
  const [dueDate, setDueDate] = useState('');
  const [notes, setNotes] = useState('');
  const [terms, setTerms] = useState('');
  const [saving, setSaving] = useState(false);

  // Send modal state
  const [sendModalInvoice, setSendModalInvoice] = useState<Invoice | null>(null);
  const [sendChannel, setSendChannel] = useState<'whatsapp' | 'email' | 'both'>('whatsapp');

  // Mark paid modal
  const [markPaidInvoice, setMarkPaidInvoice] = useState<Invoice | null>(null);
  const [markPaidMethod, setMarkPaidMethod] = useState('cash');
  const [markPaidNote, setMarkPaidNote] = useState('');
  const [markingPaid, setMarkingPaid] = useState(false);

  // Cancel confirm
  const [cancelConfirmId, setCancelConfirmId] = useState<string | null>(null);

  const supabase = createClient();

  const loadInvoices = useCallback(async () => {
    const res = await fetch(`/api/invoices?business_id=${business.id}&status=${statusFilter}`);
    if (res.ok) {
      const data = await res.json();
      setInvoices(data.invoices || []);
    }
    setLoading(false);
  }, [business.id, statusFilter]);

  useEffect(() => {
    setLoading(true);
    loadInvoices();
  }, [loadInvoices]);

  function resetForm() {
    setCustomerName('');
    setCustomerPhone('');
    setCustomerEmail('');
    setCustomerAddress('');
    setItems([{ description: '', quantity: 1, unit_price: 0 }]);
    setTaxRate(0);
    setDiscountType('flat');
    setDiscountValue(0);
    setDueDate('');
    setNotes('');
    setTerms('');
    setEditingId(null);
  }

  function openCreate() {
    resetForm();
    setShowForm(true);
  }

  function openEdit(inv: Invoice) {
    setEditingId(inv.id);
    setCustomerName(inv.customer_name);
    setCustomerPhone(inv.customer_phone || '');
    setCustomerEmail(inv.customer_email || '');
    setCustomerAddress(inv.customer_address || '');
    setItems(
      inv.invoice_items
        .sort((a, b) => a.sort_order - b.sort_order)
        .map(i => ({ description: i.description, quantity: i.quantity, unit_price: i.unit_price }))
    );
    setTaxRate(inv.tax_rate);
    setDiscountType((inv.discount_type as 'flat' | 'percent') || 'flat');
    setDiscountValue(inv.discount_value);
    setDueDate(inv.due_date || '');
    setNotes(inv.notes || '');
    setTerms(inv.terms || '');
    setShowForm(true);
  }

  // Computed totals
  const subtotal = items.reduce((sum, i) => sum + (i.quantity || 1) * (i.unit_price || 0), 0);
  const taxAmount = Math.round(subtotal * taxRate / 100 * 100) / 100;
  let discountAmount = 0;
  if (discountType === 'percent' && discountValue) {
    discountAmount = Math.round(subtotal * discountValue / 100 * 100) / 100;
  } else if (discountType === 'flat' && discountValue) {
    discountAmount = discountValue;
  }
  const totalAmount = Math.round((subtotal + taxAmount - discountAmount) * 100) / 100;

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!customerName || items.length === 0 || !items[0].description) return;

    setSaving(true);
    try {
      const body = {
        business_id: business.id,
        customer_name: customerName,
        customer_phone: customerPhone || undefined,
        customer_email: customerEmail || undefined,
        customer_address: customerAddress || undefined,
        items: items.filter(i => i.description),
        tax_rate: taxRate,
        discount_type: discountValue > 0 ? discountType : undefined,
        discount_value: discountValue || undefined,
        due_date: dueDate || undefined,
        notes: notes || undefined,
        terms: terms || undefined,
      };

      const res = editingId
        ? await fetch(`/api/invoices/${editingId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          })
        : await fetch('/api/invoices', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          });

      if (res.ok) {
        setShowForm(false);
        resetForm();
        await loadInvoices();
        toast(editingId ? 'Invoice updated' : 'Invoice created');
      }
    } catch (err) {
      console.error('Save failed:', err);
    } finally {
      setSaving(false);
    }
  }

  async function handleSend() {
    if (!sendModalInvoice) return;
    setSending(true);
    try {
      const res = await fetch('/api/invoices/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ invoice_id: sendModalInvoice.id, channel: sendChannel }),
      });
      if (res.ok) {
        setSendModalInvoice(null);
        await loadInvoices();
        toast('Invoice sent');
      }
    } catch (err) {
      console.error('Send failed:', err);
    } finally {
      setSending(false);
    }
  }

  async function handleMarkPaid() {
    if (!markPaidInvoice) return;
    setMarkingPaid(true);
    try {
      const res = await fetch(`/api/invoices/${markPaidInvoice.id}/mark-paid`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ payment_method: markPaidMethod, note: markPaidNote || undefined }),
      });
      if (res.ok) {
        setMarkPaidInvoice(null);
        setMarkPaidMethod('cash');
        setMarkPaidNote('');
        await loadInvoices();
        toast('Marked as paid');
      }
    } catch (err) {
      console.error('Mark paid failed:', err);
    } finally {
      setMarkingPaid(false);
    }
  }

  async function handleCancel(id: string) {
    try {
      await fetch(`/api/invoices/${id}`, { method: 'DELETE' });
      setCancelConfirmId(null);
      await loadInvoices();
      toast('Invoice cancelled');
    } catch (err) {
      console.error('Cancel failed:', err);
    }
  }

  function toast(msg: string) {
    setToastMsg(msg);
    setTimeout(() => setToastMsg(''), 3000);
  }

  const statusTabs: { key: StatusFilter; label: string }[] = [
    { key: 'all', label: 'All' },
    { key: 'draft', label: 'Draft' },
    { key: 'sent', label: 'Sent' },
    { key: 'paid', label: 'Paid' },
    { key: 'overdue', label: 'Overdue' },
  ];

  return (
    <div className="mx-auto max-w-5xl px-4 py-8">
      {/* Header */}
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Invoices</h1>
          <p className="mt-1 text-sm text-gray-500">Create and send invoices to customers</p>
        </div>
        <button
          onClick={openCreate}
          className="rounded-lg bg-brand px-4 py-2.5 text-sm font-medium text-white transition hover:opacity-90"
        >
          New Invoice
        </button>
      </div>

      {/* Status filter tabs */}
      <div className="mb-6 flex gap-1 rounded-lg border border-gray-200 bg-gray-50 p-1">
        {statusTabs.map(tab => (
          <button
            key={tab.key}
            onClick={() => setStatusFilter(tab.key)}
            className={`flex-1 rounded-md px-3 py-1.5 text-xs font-medium transition ${
              statusFilter === tab.key
                ? 'bg-white text-gray-900 shadow-sm'
                : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Stats */}
      {!loading && invoices.length > 0 && (() => {
        // Stats are based on ALL invoices (not filtered)
        const stats = [
          { label: 'Total', value: invoices.length, color: 'bg-blue-50 text-blue-700' },
          { label: 'Draft', value: invoices.filter(i => i.status === 'draft').length, color: 'bg-gray-50 text-gray-600' },
          { label: 'Sent', value: invoices.filter(i => ['sent', 'viewed'].includes(i.status)).length, color: 'bg-blue-50 text-blue-700' },
          { label: 'Paid', value: invoices.filter(i => i.status === 'paid').length, color: 'bg-green-50 text-green-700' },
        ];
        return statusFilter === 'all' ? (
          <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
            {stats.map(s => (
              <div key={s.label} className={`rounded-xl border border-gray-200 p-4 ${s.color}`}>
                <p className="text-2xl font-bold">{s.value}</p>
                <p className="text-xs font-medium opacity-70">{s.label}</p>
              </div>
            ))}
          </div>
        ) : null;
      })()}

      {/* Invoice list */}
      {loading ? (
        <div className="py-20 text-center text-gray-400">Loading invoices...</div>
      ) : invoices.length === 0 ? (
        <div className="rounded-xl border border-dashed border-gray-200 py-20 text-center">
          <p className="text-gray-500">No invoices yet</p>
          <p className="mt-1 text-sm text-gray-400">Create your first invoice to get started</p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-gray-200 bg-white">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Invoice</th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Customer</th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Amount</th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Status</th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Due</th>
                <th className="px-4 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-500">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {invoices.map(inv => (
                <tr key={inv.id} className="hover:bg-gray-50">
                  <td className="whitespace-nowrap px-4 py-3">
                    <p className="text-sm font-medium text-gray-900">{inv.reference_code}</p>
                    <p className="text-xs text-gray-400">{new Date(inv.created_at).toLocaleDateString()}</p>
                  </td>
                  <td className="whitespace-nowrap px-4 py-3">
                    <p className="text-sm text-gray-700">{inv.customer_name}</p>
                    <p className="text-xs text-gray-400">{inv.customer_phone || inv.customer_email || ''}</p>
                  </td>
                  <td className="whitespace-nowrap px-4 py-3">
                    <p className="text-sm font-medium text-gray-900">{formatAmount(inv.total_amount, inv.currency)}</p>
                  </td>
                  <td className="whitespace-nowrap px-4 py-3">
                    {getStatusBadge(inv.status)}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-sm text-gray-500">
                    {inv.due_date ? new Date(inv.due_date).toLocaleDateString() : '—'}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-right">
                    <div className="flex items-center justify-end gap-2">
                      {inv.status === 'draft' && (
                        <>
                          <button
                            onClick={() => openEdit(inv)}
                            className="text-sm font-medium text-gray-600 hover:underline"
                          >
                            Edit
                          </button>
                          <button
                            onClick={() => setSendModalInvoice(inv)}
                            className="text-sm font-medium text-brand hover:underline"
                          >
                            Send
                          </button>
                        </>
                      )}
                      {['sent', 'viewed', 'overdue'].includes(inv.status) && (
                        <>
                          <button
                            onClick={() => setSendModalInvoice(inv)}
                            className="text-sm font-medium text-brand hover:underline"
                          >
                            Resend
                          </button>
                          <button
                            onClick={() => setMarkPaidInvoice(inv)}
                            className="text-sm font-medium text-green-600 hover:underline"
                          >
                            Mark Paid
                          </button>
                        </>
                      )}
                      <a
                        href={`/api/invoices/pdf/${inv.id}`}
                        className="text-sm font-medium text-gray-500 hover:underline"
                      >
                        PDF
                      </a>
                      {inv.status !== 'paid' && inv.status !== 'cancelled' && (
                        <button
                          onClick={() => setCancelConfirmId(inv.id)}
                          className="text-sm font-medium text-red-500 hover:underline"
                        >
                          Cancel
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Create/Edit Form Modal */}
      {showForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="mx-4 max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-xl bg-white p-6 shadow-xl">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-lg font-bold text-gray-900">
                {editingId ? 'Edit Invoice' : 'New Invoice'}
              </h2>
              <button onClick={() => { setShowForm(false); resetForm(); }} className="text-gray-400 hover:text-gray-600">
                <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <form onSubmit={handleSave} className="space-y-4">
              {/* Customer */}
              <div className="grid grid-cols-2 gap-3">
                <div className="col-span-2">
                  <label className="block text-sm font-medium text-gray-700">Customer Name *</label>
                  <input
                    type="text"
                    value={customerName}
                    onChange={e => setCustomerName(e.target.value)}
                    required
                    placeholder="e.g. John Doe"
                    className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700">Phone</label>
                  <input
                    type="tel"
                    value={customerPhone}
                    onChange={e => setCustomerPhone(e.target.value)}
                    placeholder="+234..."
                    className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700">Email</label>
                  <input
                    type="email"
                    value={customerEmail}
                    onChange={e => setCustomerEmail(e.target.value)}
                    placeholder="john@example.com"
                    className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
                  />
                </div>
                <div className="col-span-2">
                  <label className="block text-sm font-medium text-gray-700">Address</label>
                  <input
                    type="text"
                    value={customerAddress}
                    onChange={e => setCustomerAddress(e.target.value)}
                    placeholder="Customer address"
                    className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
                  />
                </div>
              </div>

              {/* Line items */}
              <div>
                <label className="mb-2 block text-sm font-medium text-gray-700">Line Items</label>
                <div className="space-y-2">
                  {items.map((item, i) => (
                    <div key={i} className="flex items-start gap-2">
                      <input
                        type="text"
                        value={item.description}
                        onChange={e => setItems(prev => prev.map((x, j) => j === i ? { ...x, description: e.target.value } : x))}
                        placeholder="Description"
                        required
                        className="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
                      />
                      <input
                        type="number"
                        min="1"
                        value={item.quantity}
                        onChange={e => setItems(prev => prev.map((x, j) => j === i ? { ...x, quantity: parseFloat(e.target.value) || 1 } : x))}
                        className="w-16 rounded-lg border border-gray-300 px-2 py-2 text-center text-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
                        placeholder="Qty"
                      />
                      <input
                        type="number"
                        min="0"
                        step="0.01"
                        value={item.unit_price || ''}
                        onChange={e => setItems(prev => prev.map((x, j) => j === i ? { ...x, unit_price: parseFloat(e.target.value) || 0 } : x))}
                        className="w-28 rounded-lg border border-gray-300 px-2 py-2 text-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
                        placeholder="Price"
                      />
                      <span className="flex items-center py-2 text-sm font-medium text-gray-500 min-w-[60px] text-right">
                        {((item.quantity || 1) * (item.unit_price || 0)).toLocaleString()}
                      </span>
                      {items.length > 1 && (
                        <button
                          type="button"
                          onClick={() => setItems(prev => prev.filter((_, j) => j !== i))}
                          className="py-2 text-red-400 hover:text-red-600"
                        >
                          <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                          </svg>
                        </button>
                      )}
                    </div>
                  ))}
                </div>
                <button
                  type="button"
                  onClick={() => setItems(prev => [...prev, { description: '', quantity: 1, unit_price: 0 }])}
                  className="mt-2 text-sm font-medium text-brand hover:underline"
                >
                  + Add Item
                </button>
              </div>

              {/* Tax & Discount */}
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700">Tax Rate (%)</label>
                  <input
                    type="number"
                    min="0"
                    step="0.1"
                    value={taxRate || ''}
                    onChange={e => setTaxRate(parseFloat(e.target.value) || 0)}
                    className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700">Discount Type</label>
                  <select
                    value={discountType}
                    onChange={e => setDiscountType(e.target.value as 'flat' | 'percent')}
                    className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
                  >
                    <option value="flat">Flat</option>
                    <option value="percent">Percent</option>
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700">
                    Discount {discountType === 'percent' ? '(%)' : 'Amount'}
                  </label>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={discountValue || ''}
                    onChange={e => setDiscountValue(parseFloat(e.target.value) || 0)}
                    className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
                  />
                </div>
              </div>

              {/* Due date */}
              <div>
                <label className="block text-sm font-medium text-gray-700">Due Date</label>
                <input
                  type="date"
                  value={dueDate}
                  onChange={e => setDueDate(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
                />
              </div>

              {/* Notes & Terms */}
              <div>
                <label className="block text-sm font-medium text-gray-700">Notes</label>
                <textarea
                  value={notes}
                  onChange={e => setNotes(e.target.value)}
                  rows={2}
                  placeholder="Additional notes..."
                  className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700">Terms</label>
                <textarea
                  value={terms}
                  onChange={e => setTerms(e.target.value)}
                  rows={2}
                  placeholder="Payment terms..."
                  className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
                />
              </div>

              {/* Computed summary */}
              <div className="rounded-lg border border-gray-200 bg-gray-50 p-4">
                <div className="flex justify-between text-sm">
                  <span className="text-gray-500">Subtotal</span>
                  <span className="text-gray-700">{subtotal.toLocaleString()}</span>
                </div>
                {taxRate > 0 && (
                  <div className="mt-1 flex justify-between text-sm">
                    <span className="text-gray-500">Tax ({taxRate}%)</span>
                    <span className="text-gray-700">{taxAmount.toLocaleString()}</span>
                  </div>
                )}
                {discountAmount > 0 && (
                  <div className="mt-1 flex justify-between text-sm">
                    <span className="text-gray-500">Discount</span>
                    <span className="text-red-500">-{discountAmount.toLocaleString()}</span>
                  </div>
                )}
                <div className="mt-2 flex justify-between border-t border-gray-200 pt-2 text-sm font-bold">
                  <span className="text-gray-700">Total</span>
                  <span className="text-gray-900">{totalAmount.toLocaleString()}</span>
                </div>
              </div>

              {/* Actions */}
              <div className="flex gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => { setShowForm(false); resetForm(); }}
                  className="flex-1 rounded-lg border border-gray-300 px-4 py-2.5 text-sm font-medium text-gray-700 transition hover:bg-gray-50"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={saving || !customerName || !items[0]?.description}
                  className="flex-1 rounded-lg bg-brand px-4 py-2.5 text-sm font-medium text-white transition hover:opacity-90 disabled:opacity-50"
                >
                  {saving ? 'Saving...' : editingId ? 'Update Invoice' : 'Create Invoice'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Send Modal */}
      {sendModalInvoice && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="mx-4 w-full max-w-sm rounded-xl bg-white p-6 shadow-xl">
            <h2 className="text-lg font-bold text-gray-900">Send Invoice</h2>
            <p className="mt-1 text-sm text-gray-500">
              Send {sendModalInvoice.reference_code} to {sendModalInvoice.customer_name}
            </p>

            <div className="mt-4 space-y-2">
              <p className="text-sm font-medium text-gray-700">Send via:</p>
              {(['whatsapp', 'email', 'both'] as const).map(ch => (
                <label key={ch} className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="channel"
                    checked={sendChannel === ch}
                    onChange={() => setSendChannel(ch)}
                    className="h-4 w-4 border-gray-300 text-brand focus:ring-brand"
                  />
                  <span className="text-sm text-gray-700 capitalize">
                    {ch === 'both' ? 'WhatsApp & Email' : ch}
                    {ch === 'whatsapp' && !sendModalInvoice.customer_phone && ' (no phone)'}
                    {ch === 'email' && !sendModalInvoice.customer_email && ' (no email)'}
                  </span>
                </label>
              ))}
            </div>

            <div className="mt-5 flex gap-3">
              <button
                onClick={() => setSendModalInvoice(null)}
                className="flex-1 rounded-lg border border-gray-300 px-4 py-2.5 text-sm font-medium text-gray-700 transition hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                onClick={handleSend}
                disabled={sending}
                className="flex-1 rounded-lg bg-brand px-4 py-2.5 text-sm font-medium text-white transition hover:opacity-90 disabled:opacity-50"
              >
                {sending ? 'Sending...' : 'Send'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Mark Paid Modal */}
      {markPaidInvoice && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="mx-4 w-full max-w-sm rounded-xl bg-white p-6 shadow-xl">
            <h2 className="text-lg font-bold text-gray-900">Mark as Paid</h2>
            <p className="mt-1 text-sm text-gray-500">
              {markPaidInvoice.reference_code} &middot; {formatAmount(markPaidInvoice.total_amount, markPaidInvoice.currency)}
            </p>

            <div className="mt-4 space-y-3">
              <div>
                <label className="block text-sm font-medium text-gray-700">Payment Method</label>
                <select
                  value={markPaidMethod}
                  onChange={e => setMarkPaidMethod(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
                >
                  <option value="cash">Cash</option>
                  <option value="bank_transfer">Bank Transfer</option>
                  <option value="card">Card</option>
                  <option value="cheque">Cheque</option>
                  <option value="other">Other</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700">Note (optional)</label>
                <input
                  type="text"
                  value={markPaidNote}
                  onChange={e => setMarkPaidNote(e.target.value)}
                  placeholder="e.g. Ref #12345"
                  className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
                />
              </div>
            </div>

            <div className="mt-5 flex gap-3">
              <button
                onClick={() => setMarkPaidInvoice(null)}
                className="flex-1 rounded-lg border border-gray-300 px-4 py-2.5 text-sm font-medium text-gray-700 transition hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                onClick={handleMarkPaid}
                disabled={markingPaid}
                className="flex-1 rounded-lg bg-green-600 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-green-700 disabled:opacity-50"
              >
                {markingPaid ? 'Saving...' : 'Confirm Payment'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Cancel Confirmation */}
      {cancelConfirmId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="mx-4 w-full max-w-sm rounded-xl bg-white p-6 shadow-xl">
            <h2 className="text-lg font-bold text-gray-900">Cancel Invoice?</h2>
            <p className="mt-2 text-sm text-gray-600">
              This will cancel the invoice. This action cannot be undone.
            </p>
            <div className="mt-5 flex gap-3">
              <button
                onClick={() => setCancelConfirmId(null)}
                className="flex-1 rounded-lg border border-gray-300 px-4 py-2.5 text-sm font-medium text-gray-700 transition hover:bg-gray-50"
              >
                Keep
              </button>
              <button
                onClick={() => handleCancel(cancelConfirmId)}
                className="flex-1 rounded-lg bg-red-600 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-red-700"
              >
                Cancel Invoice
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Toast */}
      {toastMsg && (
        <div className="fixed bottom-6 left-1/2 z-[100] -translate-x-1/2 rounded-lg bg-gray-900 px-5 py-3 text-sm text-white shadow-lg">
          {toastMsg}
        </div>
      )}
    </div>
  );
}
