'use client';

import { useEffect, useState, useCallback } from 'react';
import { useBusiness } from '@/components/dashboard/DashboardProvider';

const EVENT_TYPES = [
  { id: 'booking.created', label: 'Booking Created' },
  { id: 'booking.confirmed', label: 'Booking Confirmed' },
  { id: 'booking.cancelled', label: 'Booking Cancelled' },
  { id: 'booking.completed', label: 'Booking Completed' },
  { id: 'payment.received', label: 'Payment Received' },
  { id: 'payment.failed', label: 'Payment Failed' },
  { id: 'order.created', label: 'Order Created' },
  { id: 'order.completed', label: 'Order Completed' },
  { id: 'customer.checkin', label: 'Customer Check-in' },
  { id: 'feedback.received', label: 'Feedback Received' },
  { id: 'chat.escalated', label: 'Chat Escalated' },
];

interface WebhookDelivery {
  id: string;
  event_type: string;
  timestamp: string;
  response_status: number | null;
  success: boolean;
}

interface Webhook {
  id: string;
  url: string;
  events: string[];
  active: boolean;
  created_at: string;
  last_triggered_at: string | null;
  failure_count: number;
  success_count: number;
  total_deliveries: number;
  recent_deliveries?: WebhookDelivery[];
}

export default function IntegrationsPage() {
  const business = useBusiness();
  const [webhooks, setWebhooks] = useState<Webhook[]>([]);
  const [loading, setLoading] = useState(true);

  // Form state
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formUrl, setFormUrl] = useState('');
  const [formEvents, setFormEvents] = useState<string[]>([]);
  const [formActive, setFormActive] = useState(true);
  const [saving, setSaving] = useState(false);

  // Signing secret reveal (shown once after creation)
  const [revealedSecret, setRevealedSecret] = useState<string | null>(null);
  const [secretCopied, setSecretCopied] = useState(false);

  // Expanded webhook for deliveries
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [deliveriesLoading, setDeliveriesLoading] = useState(false);
  const [deliveries, setDeliveries] = useState<Record<string, WebhookDelivery[]>>({});

  // Delete confirmation
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);

  const fetchWebhooks = useCallback(async () => {
    try {
      const res = await fetch(`/api/webhooks?businessId=${business.id}`);
      const data = await res.json();
      if (data.webhooks) {
        setWebhooks(data.webhooks);
      }
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, [business.id]);

  useEffect(() => {
    fetchWebhooks();
  }, [fetchWebhooks]);

  function resetForm() {
    setFormUrl('');
    setFormEvents([]);
    setFormActive(true);
    setEditingId(null);
    setShowForm(false);
    setRevealedSecret(null);
    setSecretCopied(false);
  }

  function handleEdit(webhook: Webhook) {
    setEditingId(webhook.id);
    setFormUrl(webhook.url);
    setFormEvents([...webhook.events]);
    setFormActive(webhook.active);
    setShowForm(true);
    setRevealedSecret(null);
  }

  function toggleEvent(eventId: string) {
    setFormEvents(prev =>
      prev.includes(eventId)
        ? prev.filter(e => e !== eventId)
        : [...prev, eventId]
    );
  }

  async function handleSave() {
    if (!formUrl || formEvents.length === 0) return;
    setSaving(true);
    try {
      const payload = {
        businessId: business.id,
        url: formUrl,
        events: formEvents,
        active: formActive,
        ...(editingId ? { id: editingId } : {}),
      };

      const res = await fetch('/api/webhooks', {
        method: editingId ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();

      if (data.error) {
        alert(data.error);
        return;
      }

      // If creating a new webhook, show the signing secret
      if (!editingId && data.signing_secret) {
        setRevealedSecret(data.signing_secret);
        setSecretCopied(false);
      } else {
        resetForm();
      }

      fetchWebhooks();
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(webhookId: string) {
    setDeleteLoading(true);
    try {
      const res = await fetch('/api/webhooks', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: webhookId, businessId: business.id }),
      });
      const data = await res.json();
      if (data.error) {
        alert(data.error);
        return;
      }
      setDeletingId(null);
      fetchWebhooks();
    } finally {
      setDeleteLoading(false);
    }
  }

  async function fetchDeliveries(webhookId: string) {
    setDeliveriesLoading(true);
    try {
      const res = await fetch(
        `/api/webhooks?businessId=${business.id}&webhookId=${webhookId}&deliveries=true`
      );
      const data = await res.json();
      if (data.deliveries) {
        setDeliveries(prev => ({ ...prev, [webhookId]: data.deliveries }));
      }
    } catch {
      // silent
    } finally {
      setDeliveriesLoading(false);
    }
  }

  function toggleExpand(webhookId: string) {
    if (expandedId === webhookId) {
      setExpandedId(null);
    } else {
      setExpandedId(webhookId);
      if (!deliveries[webhookId]) {
        fetchDeliveries(webhookId);
      }
    }
  }

  function copySecret() {
    if (revealedSecret) {
      navigator.clipboard.writeText(revealedSecret);
      setSecretCopied(true);
      setTimeout(() => setSecretCopied(false), 2000);
    }
  }

  function truncateUrl(url: string, maxLen = 50) {
    if (url.length <= maxLen) return url;
    return url.slice(0, maxLen) + '...';
  }

  function deliveryRate(webhook: Webhook) {
    if (webhook.total_deliveries === 0) return '--';
    const rate = Math.round((webhook.success_count / webhook.total_deliveries) * 100);
    return `${rate}%`;
  }

  function formatTime(dateStr: string | null) {
    if (!dateStr) return 'Never';
    const d = new Date(dateStr);
    return d.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  }

  return (
    <div>
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Integrations</h1>
          <p className="mt-1 text-sm text-gray-500">
            Manage webhook endpoints to receive real-time event notifications.
          </p>
        </div>
        <button
          onClick={() => {
            resetForm();
            setShowForm(true);
          }}
          className="rounded-lg bg-brand px-5 py-2 text-sm font-semibold text-white hover:bg-brand-600"
        >
          + Add Webhook
        </button>
      </div>

      {/* Add / Edit Form */}
      {showForm && (
        <div className="mt-6 rounded-xl border border-gray-200 bg-white p-6">
          <h3 className="text-sm font-semibold text-gray-900">
            {editingId ? 'Edit Webhook' : 'New Webhook'}
          </h3>

          {/* URL Input */}
          <div className="mt-4">
            <label className="block text-xs font-medium text-gray-500 mb-1.5">
              Endpoint URL
            </label>
            <input
              type="url"
              value={formUrl}
              onChange={e => setFormUrl(e.target.value)}
              placeholder="https://example.com/webhooks"
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
            />
          </div>

          {/* Event Types */}
          <div className="mt-4">
            <label className="block text-xs font-medium text-gray-500 mb-2">
              Event Types
            </label>
            <div className="grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-3 lg:grid-cols-5">
              {EVENT_TYPES.map(evt => (
                <label
                  key={evt.id}
                  className="flex items-center gap-2 cursor-pointer select-none"
                >
                  <input
                    type="checkbox"
                    checked={formEvents.includes(evt.id)}
                    onChange={() => toggleEvent(evt.id)}
                    className="h-4 w-4 rounded border-gray-300 text-brand focus:ring-brand"
                  />
                  <span className="text-sm text-gray-700">{evt.label}</span>
                </label>
              ))}
            </div>
          </div>

          {/* Active toggle */}
          <div className="mt-4 flex items-center gap-3">
            <label className="text-xs font-medium text-gray-500">Status</label>
            <button
              type="button"
              onClick={() => setFormActive(!formActive)}
              className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${
                formActive ? 'bg-brand' : 'bg-gray-200'
              }`}
            >
              <span
                className={`pointer-events-none inline-block h-5 w-5 rounded-full bg-white shadow ring-0 transition-transform ${
                  formActive ? 'translate-x-5' : 'translate-x-0'
                }`}
              />
            </button>
            <span className="text-sm text-gray-600">
              {formActive ? 'Active' : 'Inactive'}
            </span>
          </div>

          {/* Actions */}
          <div className="mt-5 flex items-center gap-3">
            <button
              onClick={handleSave}
              disabled={saving || !formUrl || formEvents.length === 0}
              className="rounded-lg bg-brand px-5 py-2 text-sm font-semibold text-white hover:bg-brand-600 disabled:opacity-50"
            >
              {saving ? 'Saving...' : editingId ? 'Update Webhook' : 'Create Webhook'}
            </button>
            <button
              onClick={resetForm}
              className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
            >
              Cancel
            </button>
          </div>

          {/* Signing Secret Reveal (only after creation) */}
          {revealedSecret && (
            <div className="mt-5 rounded-lg border border-amber-200 bg-amber-50 p-4">
              <p className="text-sm font-semibold text-amber-800">
                Signing Secret (shown once)
              </p>
              <p className="mt-1 text-xs text-amber-700">
                Copy this secret now. You will not be able to see it again.
              </p>
              <div className="mt-2 flex items-center gap-2">
                <code className="flex-1 rounded-md bg-white px-3 py-2 text-sm font-mono text-gray-900 border border-amber-200 break-all">
                  {revealedSecret}
                </code>
                <button
                  onClick={copySecret}
                  className="shrink-0 rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
                >
                  {secretCopied ? 'Copied!' : 'Copy'}
                </button>
              </div>
              <button
                onClick={resetForm}
                className="mt-3 rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white hover:bg-brand-600"
              >
                Done
              </button>
            </div>
          )}
        </div>
      )}

      {/* Webhooks List */}
      <div className="mt-6 space-y-4">
        {loading ? (
          <div className="rounded-xl border border-gray-200 bg-white px-4 py-12 text-center text-sm text-gray-400">
            Loading webhooks...
          </div>
        ) : webhooks.length === 0 && !showForm ? (
          <div className="rounded-xl border border-gray-200 bg-white px-4 py-12 text-center">
            <p className="text-sm text-gray-500">No webhooks configured yet.</p>
            <p className="mt-1 text-xs text-gray-400">
              Click &quot;+ Add Webhook&quot; to get started.
            </p>
          </div>
        ) : (
          webhooks.map(wh => (
            <div
              key={wh.id}
              className="rounded-xl border border-gray-200 bg-white"
            >
              {/* Webhook Card Header */}
              <div className="p-5">
                <div className="flex items-start justify-between gap-4">
                  {/* Left: URL + events */}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p
                        className="text-sm font-semibold text-gray-900 truncate max-w-md"
                        title={wh.url}
                      >
                        {truncateUrl(wh.url)}
                      </p>
                      <span
                        className={`inline-flex shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${
                          wh.active
                            ? 'bg-green-50 text-green-700'
                            : 'bg-gray-100 text-gray-500'
                        }`}
                      >
                        {wh.active ? 'Active' : 'Inactive'}
                      </span>
                    </div>

                    {/* Event pills */}
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {wh.events.map(evt => (
                        <span
                          key={evt}
                          className="inline-flex rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-600"
                        >
                          {evt}
                        </span>
                      ))}
                    </div>

                    {/* Stats row */}
                    <div className="mt-3 flex flex-wrap items-center gap-4 text-xs text-gray-500">
                      <span>
                        Last triggered:{' '}
                        <span className="font-medium text-gray-700">
                          {formatTime(wh.last_triggered_at)}
                        </span>
                      </span>
                      <span>
                        Failures:{' '}
                        <span
                          className={`font-medium ${
                            wh.failure_count > 0 ? 'text-red-600' : 'text-gray-700'
                          }`}
                        >
                          {wh.failure_count}
                        </span>
                      </span>
                      <span>
                        Success rate:{' '}
                        <span className="font-medium text-gray-700">
                          {deliveryRate(wh)}
                        </span>
                      </span>
                    </div>
                  </div>

                  {/* Right: Actions */}
                  <div className="flex shrink-0 items-center gap-2">
                    <button
                      onClick={() => toggleExpand(wh.id)}
                      className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50"
                    >
                      {expandedId === wh.id ? 'Collapse' : 'Deliveries'}
                    </button>
                    <button
                      onClick={() => handleEdit(wh)}
                      className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50"
                    >
                      Edit
                    </button>
                    <button
                      onClick={() => setDeletingId(wh.id)}
                      className="rounded-lg border border-red-200 px-3 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              </div>

              {/* Delete Confirmation */}
              {deletingId === wh.id && (
                <div className="border-t border-gray-100 bg-red-50 px-5 py-3">
                  <div className="flex items-center justify-between">
                    <p className="text-sm text-red-700">
                      Are you sure you want to delete this webhook?
                    </p>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => setDeletingId(null)}
                        className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50"
                      >
                        Cancel
                      </button>
                      <button
                        onClick={() => handleDelete(wh.id)}
                        disabled={deleteLoading}
                        className="rounded-lg bg-red-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-red-700 disabled:opacity-50"
                      >
                        {deleteLoading ? 'Deleting...' : 'Confirm Delete'}
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {/* Expanded Deliveries */}
              {expandedId === wh.id && (
                <div className="border-t border-gray-100">
                  <div className="px-5 py-3">
                    <h4 className="text-xs font-semibold text-gray-500 mb-2">
                      Recent Deliveries
                    </h4>
                    {deliveriesLoading && !deliveries[wh.id] ? (
                      <p className="py-4 text-center text-xs text-gray-400">
                        Loading deliveries...
                      </p>
                    ) : !deliveries[wh.id] || deliveries[wh.id].length === 0 ? (
                      <p className="py-4 text-center text-xs text-gray-400">
                        No deliveries recorded yet.
                      </p>
                    ) : (
                      <div className="overflow-x-auto rounded-lg border border-gray-200">
                        <table className="w-full text-left text-sm">
                          <thead className="border-b border-gray-100 bg-gray-50/50">
                            <tr>
                              <th className="px-4 py-2.5 text-xs font-semibold text-gray-500">
                                Event Type
                              </th>
                              <th className="px-4 py-2.5 text-xs font-semibold text-gray-500">
                                Timestamp
                              </th>
                              <th className="px-4 py-2.5 text-xs font-semibold text-gray-500">
                                Response Status
                              </th>
                              <th className="px-4 py-2.5 text-xs font-semibold text-gray-500">
                                Result
                              </th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-gray-50">
                            {deliveries[wh.id].map(d => (
                              <tr key={d.id} className="hover:bg-gray-50/50">
                                <td className="px-4 py-2.5 font-medium text-gray-900">
                                  {d.event_type}
                                </td>
                                <td className="px-4 py-2.5 text-gray-500">
                                  {formatTime(d.timestamp)}
                                </td>
                                <td className="px-4 py-2.5">
                                  <span
                                    className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${
                                      d.response_status !== null &&
                                      d.response_status >= 200 &&
                                      d.response_status < 300
                                        ? 'bg-green-50 text-green-700'
                                        : 'bg-red-50 text-red-700'
                                    }`}
                                  >
                                    {d.response_status ?? 'Timeout'}
                                  </span>
                                </td>
                                <td className="px-4 py-2.5">
                                  <span
                                    className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${
                                      d.success
                                        ? 'bg-green-50 text-green-700'
                                        : 'bg-red-50 text-red-700'
                                    }`}
                                  >
                                    {d.success ? 'Success' : 'Failed'}
                                  </span>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
