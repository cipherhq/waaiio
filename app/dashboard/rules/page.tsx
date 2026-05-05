'use client';

import { useEffect, useState } from 'react';
import { useBusiness } from '@/components/dashboard/DashboardProvider';
import { createClient } from '@/lib/supabase/client';

// ── Types ──

interface Condition {
  field: string;
  op: string;
  value: string | number;
}

interface BotRule {
  id: string;
  business_id: string;
  name: string;
  trigger_event: string;
  conditions: Condition[];
  action_type: string;
  action_payload: Record<string, unknown>;
  is_active: boolean;
  priority: number;
  created_at: string;
}

type ViewMode = 'list' | 'add' | 'edit';

// ── Constants ──

const TRIGGER_EVENTS = [
  { value: 'booking_created', label: 'New Booking' },
  { value: 'booking_completed', label: 'Booking Completed' },
  { value: 'booking_cancelled', label: 'Booking Cancelled' },
  { value: 'booking_no_show', label: 'No-Show' },
  { value: 'order_created', label: 'Order Created' },
  { value: 'order_delivered', label: 'Order Delivered' },
  { value: 'order_cancelled', label: 'Order Cancelled' },
  { value: 'payment_received', label: 'Payment Received' },
  { value: 'payment_failed', label: 'Payment Failed' },
  { value: 'customer_first_visit', label: 'Customer First Visit' },
  { value: 'customer_return_visit', label: 'Customer Return Visit' },
  { value: 'message_received', label: 'Message Received' },
] as const;

const ACTION_TYPES = [
  { value: 'send_message', label: 'Send Message' },
  { value: 'send_template', label: 'Send Template' },
  { value: 'enroll_sequence', label: 'Enroll in Sequence' },
  { value: 'assign_tag', label: 'Assign Tag' },
  { value: 'notify_owner', label: 'Notify Owner' },
  { value: 'update_status', label: 'Update Status' },
] as const;

const CONDITION_OPERATORS = [
  { value: 'eq', label: '=' },
  { value: 'neq', label: '!=' },
  { value: 'gt', label: '>' },
  { value: 'gte', label: '>=' },
  { value: 'lt', label: '<' },
  { value: 'lte', label: '<=' },
  { value: 'contains', label: 'contains' },
  { value: 'not_contains', label: 'not contains' },
] as const;

const FIELD_SUGGESTIONS = [
  'total_amount',
  'service_name',
  'customer_phone',
  'customer_name',
];

const RULE_TEMPLATES = [
  {
    label: 'Send thank you after first order',
    description: 'Automatically send a thank-you message when a new customer places their first order.',
    trigger_event: 'customer_first_visit',
    conditions: [] as Condition[],
    action_type: 'send_message',
    action_payload: { message: 'Thank you for your first order! We appreciate your business.' },
    priority: 10,
  },
  {
    label: 'Notify owner for high-value bookings',
    description: 'Get notified immediately when a booking exceeds 5,000 in value.',
    trigger_event: 'booking_created',
    conditions: [{ field: 'total_amount', op: 'gt', value: 5000 }],
    action_type: 'notify_owner',
    action_payload: { message: 'High-value booking received!' },
    priority: 5,
  },
  {
    label: 'Tag VIP customers',
    description: 'Automatically tag customers as VIP when a payment exceeds 10,000.',
    trigger_event: 'payment_received',
    conditions: [{ field: 'total_amount', op: 'gt', value: 10000 }],
    action_type: 'assign_tag',
    action_payload: { tag: 'VIP' },
    priority: 10,
  },
];

// ── Helpers ──

function triggerLabel(value: string): string {
  return TRIGGER_EVENTS.find((t) => t.value === value)?.label || value;
}

function actionLabel(value: string): string {
  return ACTION_TYPES.find((a) => a.value === value)?.label || value;
}

function conditionsSummary(conditions: Condition[]): string {
  if (!conditions || conditions.length === 0) return 'No conditions';
  return conditions
    .map((c) => {
      const opLabel = CONDITION_OPERATORS.find((o) => o.value === c.op)?.label || c.op;
      return `${c.field} ${opLabel} ${c.value}`;
    })
    .join(', ');
}

const EMPTY_FORM = {
  id: '',
  name: '',
  trigger_event: 'booking_created',
  conditions: [] as Condition[],
  action_type: 'send_message',
  action_payload: {} as Record<string, unknown>,
  is_active: true,
  priority: 10,
};

// ── Page Component ──

export default function RulesPage() {
  const business = useBusiness();
  const [rules, setRules] = useState<BotRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [view, setView] = useState<ViewMode>('list');
  const [templatesOpen, setTemplatesOpen] = useState(true);

  // Form state
  const [form, setForm] = useState({ ...EMPTY_FORM });

  useEffect(() => {
    loadRules();
  }, [business.id]);

  async function loadRules() {
    const supabase = createClient();
    const { data } = await supabase
      .from('bot_rules')
      .select('*')
      .eq('business_id', business.id)
      .order('priority', { ascending: true });
    setRules((data || []) as BotRule[]);
    setLoading(false);
  }

  function openAdd() {
    setForm({ ...EMPTY_FORM });
    setView('add');
  }

  function openEdit(rule: BotRule) {
    setForm({
      id: rule.id,
      name: rule.name,
      trigger_event: rule.trigger_event,
      conditions: rule.conditions || [],
      action_type: rule.action_type,
      action_payload: rule.action_payload || {},
      is_active: rule.is_active,
      priority: rule.priority,
    });
    setView('edit');
  }

  function applyTemplate(tpl: (typeof RULE_TEMPLATES)[number]) {
    setForm({
      ...EMPTY_FORM,
      name: tpl.label,
      trigger_event: tpl.trigger_event,
      conditions: tpl.conditions.map((c) => ({ ...c })),
      action_type: tpl.action_type,
      action_payload: { ...tpl.action_payload },
      priority: tpl.priority,
    });
    setView('add');
  }

  async function handleSave() {
    if (!form.name.trim()) return;
    setSaving(true);
    const supabase = createClient();

    const payload = {
      business_id: business.id,
      name: form.name.trim(),
      trigger_event: form.trigger_event,
      conditions: form.conditions,
      action_type: form.action_type,
      action_payload: form.action_payload,
      is_active: form.is_active,
      priority: form.priority,
    };

    if (view === 'add') {
      await supabase.from('bot_rules').insert(payload);
    } else {
      await supabase.from('bot_rules').update(payload).eq('id', form.id);
    }

    setSaving(false);
    setView('list');
    loadRules();
  }

  async function handleDelete() {
    if (!form.id || !confirm('Delete this rule?')) return;
    const supabase = createClient();
    await supabase.from('bot_rules').delete().eq('id', form.id);
    setView('list');
    loadRules();
  }

  async function toggleActive(rule: BotRule) {
    const supabase = createClient();
    const newVal = !rule.is_active;
    await supabase.from('bot_rules').update({ is_active: newVal }).eq('id', rule.id);
    setRules((prev) =>
      prev.map((r) => (r.id === rule.id ? { ...r, is_active: newVal } : r)),
    );
  }

  // ── Condition helpers ──

  function addCondition() {
    setForm((f) => ({
      ...f,
      conditions: [...f.conditions, { field: '', op: 'eq', value: '' }],
    }));
  }

  function updateCondition(index: number, patch: Partial<Condition>) {
    setForm((f) => ({
      ...f,
      conditions: f.conditions.map((c, i) => (i === index ? { ...c, ...patch } : c)),
    }));
  }

  function removeCondition(index: number) {
    setForm((f) => ({
      ...f,
      conditions: f.conditions.filter((_, i) => i !== index),
    }));
  }

  function setFieldFromChip(index: number, field: string) {
    updateCondition(index, { field });
  }

  // ── Action payload helpers ──

  function updatePayload(key: string, value: string) {
    setForm((f) => ({ ...f, action_payload: { ...f.action_payload, [key]: value } }));
  }

  function payloadString(key: string): string {
    return (form.action_payload[key] as string) || '';
  }

  // ── Loading state ──

  if (loading) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-brand border-t-transparent" />
      </div>
    );
  }

  // ═══════════════════════════════════════════
  // ADD / EDIT — Rule Builder
  // ═══════════════════════════════════════════
  if (view === 'add' || view === 'edit') {
    return (
      <div>
        {/* Header */}
        <div className="flex items-center gap-3">
          <button
            onClick={() => setView('list')}
            className="rounded-lg p-2 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
          >
            <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
          </button>
          <h1 className="text-xl font-bold text-gray-900">
            {view === 'add' ? 'New Rule' : 'Edit Rule'}
          </h1>
        </div>

        <div className="mt-5 space-y-6">
          {/* Rule Name */}
          <div className="rounded-xl border border-gray-100 bg-white p-6">
            <label className="mb-1 block text-sm font-medium text-gray-700">
              Rule Name <span className="text-red-400">*</span>
            </label>
            <input
              type="text"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="e.g. Welcome new customers"
              className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand"
              autoFocus
            />
          </div>

          {/* Trigger Event */}
          <div className="rounded-xl border border-gray-100 bg-white p-6">
            <h2 className="text-sm font-semibold text-gray-900">When this happens...</h2>
            <p className="mt-0.5 text-xs text-gray-400">Choose the event that triggers this rule</p>
            <select
              value={form.trigger_event}
              onChange={(e) => setForm({ ...form, trigger_event: e.target.value })}
              className="mt-3 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand"
            >
              {TRIGGER_EVENTS.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
          </div>

          {/* Conditions Builder */}
          <div className="rounded-xl border border-gray-100 bg-white p-6">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-sm font-semibold text-gray-900">Only if...</h2>
                <p className="mt-0.5 text-xs text-gray-400">
                  Add conditions to filter when this rule should fire
                </p>
              </div>
              <button
                onClick={addCondition}
                className="rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50"
              >
                + Add Condition
              </button>
            </div>

            {form.conditions.length === 0 && (
              <p className="mt-4 text-xs text-gray-400">
                No conditions -- this rule will fire on every matching event.
              </p>
            )}

            <div className="mt-4 space-y-3">
              {form.conditions.map((cond, i) => (
                <div key={i} className="space-y-2">
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      value={cond.field}
                      onChange={(e) => updateCondition(i, { field: e.target.value })}
                      placeholder="Field name"
                      className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand"
                    />
                    <select
                      value={cond.op}
                      onChange={(e) => updateCondition(i, { op: e.target.value })}
                      className="shrink-0 rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand"
                    >
                      {CONDITION_OPERATORS.map((op) => (
                        <option key={op.value} value={op.value}>
                          {op.label}
                        </option>
                      ))}
                    </select>
                    <input
                      type="text"
                      value={cond.value}
                      onChange={(e) => {
                        const raw = e.target.value;
                        const num = Number(raw);
                        updateCondition(i, { value: raw !== '' && !isNaN(num) ? num : raw });
                      }}
                      placeholder="Value"
                      className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand"
                    />
                    <button
                      onClick={() => removeCondition(i)}
                      className="shrink-0 rounded-lg p-2 text-gray-400 hover:bg-red-50 hover:text-red-500"
                    >
                      <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  </div>
                  {/* Field suggestion chips */}
                  <div className="flex flex-wrap gap-1.5 pl-1">
                    {FIELD_SUGGESTIONS.map((f) => (
                      <button
                        key={f}
                        type="button"
                        onClick={() => setFieldFromChip(i, f)}
                        className={`rounded-full px-2.5 py-0.5 text-xs font-medium transition ${
                          cond.field === f
                            ? 'bg-brand-50 text-brand'
                            : 'bg-gray-100 text-gray-500 hover:bg-gray-200'
                        }`}
                      >
                        {f}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Action Type + Payload */}
          <div className="rounded-xl border border-gray-100 bg-white p-6">
            <h2 className="text-sm font-semibold text-gray-900">Then do this...</h2>
            <p className="mt-0.5 text-xs text-gray-400">Choose the action to perform</p>

            <select
              value={form.action_type}
              onChange={(e) =>
                setForm({ ...form, action_type: e.target.value, action_payload: {} })
              }
              className="mt-3 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand"
            >
              {ACTION_TYPES.map((a) => (
                <option key={a.value} value={a.value}>
                  {a.label}
                </option>
              ))}
            </select>

            {/* Action payload fields */}
            <div className="mt-4">
              {form.action_type === 'send_message' && (
                <div>
                  <label className="mb-1 block text-sm font-medium text-gray-700">Message</label>
                  <textarea
                    rows={4}
                    value={payloadString('message')}
                    onChange={(e) => updatePayload('message', e.target.value)}
                    placeholder="Type your message..."
                    className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand"
                  />
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    <span className="text-xs text-gray-400">Variables:</span>
                    {['{{customer_name}}', '{{service_name}}', '{{total_amount}}', '{{booking_date}}'].map((v) => (
                      <button
                        key={v}
                        type="button"
                        onClick={() =>
                          updatePayload('message', payloadString('message') + ' ' + v)
                        }
                        className="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-600 hover:bg-gray-200"
                      >
                        {v}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {form.action_type === 'send_template' && (
                <div>
                  <label className="mb-1 block text-sm font-medium text-gray-700">
                    Template Name
                  </label>
                  <input
                    type="text"
                    value={payloadString('template_name')}
                    onChange={(e) => updatePayload('template_name', e.target.value)}
                    placeholder="e.g. booking_confirmation"
                    className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand"
                  />
                </div>
              )}

              {form.action_type === 'enroll_sequence' && (
                <div>
                  <label className="mb-1 block text-sm font-medium text-gray-700">
                    Sequence ID
                  </label>
                  <input
                    type="text"
                    value={payloadString('sequence_id')}
                    onChange={(e) => updatePayload('sequence_id', e.target.value)}
                    placeholder="Enter sequence ID"
                    className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand"
                  />
                </div>
              )}

              {form.action_type === 'assign_tag' && (
                <div>
                  <label className="mb-1 block text-sm font-medium text-gray-700">Tag Name</label>
                  <input
                    type="text"
                    value={payloadString('tag')}
                    onChange={(e) => updatePayload('tag', e.target.value)}
                    placeholder="e.g. VIP"
                    className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand"
                  />
                </div>
              )}

              {form.action_type === 'notify_owner' && (
                <div>
                  <label className="mb-1 block text-sm font-medium text-gray-700">
                    Notification Message
                  </label>
                  <textarea
                    rows={3}
                    value={payloadString('message')}
                    onChange={(e) => updatePayload('message', e.target.value)}
                    placeholder="Message to send to the business owner..."
                    className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand"
                  />
                </div>
              )}

              {form.action_type === 'update_status' && (
                <div>
                  <label className="mb-1 block text-sm font-medium text-gray-700">
                    New Status
                  </label>
                  <input
                    type="text"
                    value={payloadString('status')}
                    onChange={(e) => updatePayload('status', e.target.value)}
                    placeholder="e.g. confirmed"
                    className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand"
                  />
                </div>
              )}
            </div>
          </div>

          {/* Priority & Active */}
          <div className="rounded-xl border border-gray-100 bg-white p-6">
            <div className="grid gap-5 sm:grid-cols-2">
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">Priority</label>
                <input
                  type="number"
                  min={0}
                  value={form.priority}
                  onChange={(e) => setForm({ ...form, priority: Number(e.target.value) || 0 })}
                  className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand"
                />
                <p className="mt-1 text-xs text-gray-400">Lower number = higher priority</p>
              </div>
              <div className="flex items-center">
                <ToggleRow
                  label="Active"
                  description="Rule will be evaluated when events occur"
                  checked={form.is_active}
                  onChange={(v) => setForm({ ...form, is_active: v })}
                />
              </div>
            </div>
          </div>

          {/* Save / Cancel / Delete footer */}
          <div className="flex gap-3 border-t border-gray-100 pt-4">
            <button
              onClick={handleSave}
              disabled={saving || !form.name.trim()}
              className="rounded-lg bg-brand px-6 py-2.5 text-sm font-semibold text-white hover:bg-brand-600 disabled:opacity-50"
            >
              {saving ? 'Saving...' : view === 'add' ? 'Create Rule' : 'Save Changes'}
            </button>
            <button
              onClick={() => setView('list')}
              className="rounded-lg border border-gray-200 px-4 py-2.5 text-sm font-medium text-gray-600 hover:bg-gray-50"
            >
              Cancel
            </button>
            {view === 'edit' && (
              <button
                onClick={handleDelete}
                className="ml-auto rounded-lg px-4 py-2.5 text-sm font-medium text-red-500 hover:bg-red-50"
              >
                Delete Rule
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }

  // ═══════════════════════════════════════════
  // LIST VIEW
  // ═══════════════════════════════════════════
  return (
    <div>
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Rules</h1>
          <p className="mt-1 text-sm text-gray-500">Automate actions based on events</p>
        </div>
        <button
          onClick={openAdd}
          className="rounded-lg bg-brand px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-600"
        >
          + New Rule
        </button>
      </div>

      {/* Templates Section */}
      <div className="mt-6 rounded-xl border border-gray-100 bg-white p-6">
        <button
          onClick={() => setTemplatesOpen(!templatesOpen)}
          className="flex w-full items-center justify-between"
        >
          <div>
            <h2 className="text-sm font-semibold text-gray-900">Quick-Start Templates</h2>
            <p className="mt-0.5 text-xs text-gray-400">
              Pre-built rules to get you started
            </p>
          </div>
          <svg
            className={`h-5 w-5 text-gray-400 transition ${templatesOpen ? 'rotate-180' : ''}`}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </button>

        {templatesOpen && (
          <div className="mt-4 grid gap-3 sm:grid-cols-3">
            {RULE_TEMPLATES.map((tpl) => (
              <button
                key={tpl.label}
                onClick={() => applyTemplate(tpl)}
                className="rounded-lg border border-gray-100 p-4 text-left transition hover:border-brand hover:shadow-sm"
              >
                <p className="text-sm font-semibold text-gray-900">{tpl.label}</p>
                <p className="mt-1 text-xs text-gray-400 line-clamp-2">{tpl.description}</p>
                <div className="mt-3 flex flex-wrap gap-1.5">
                  <span className="rounded-full bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-700">
                    {triggerLabel(tpl.trigger_event)}
                  </span>
                  <span className="rounded-full bg-purple-100 px-2 py-0.5 text-xs font-medium text-purple-700">
                    {actionLabel(tpl.action_type)}
                  </span>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Rules List */}
      {rules.length === 0 ? (
        <div className="mt-6 rounded-xl border border-dashed border-gray-200 p-12 text-center">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-gray-50">
            <svg className="h-6 w-6 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z"
              />
            </svg>
          </div>
          <p className="mt-3 text-sm text-gray-500">No automation rules yet</p>
          <p className="mt-1 text-xs text-gray-400">
            Create a rule or use a template above to get started
          </p>
          <button
            onClick={openAdd}
            className="mt-4 rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white hover:bg-brand-600"
          >
            + New Rule
          </button>
        </div>
      ) : (
        <div className="mt-6 space-y-3">
          {rules.map((rule) => (
            <div
              key={rule.id}
              className="rounded-xl border border-gray-100 bg-white p-5 transition hover:shadow-sm"
            >
              <div className="flex items-start justify-between gap-4">
                {/* Left: name + badges */}
                <div
                  className="min-w-0 flex-1 cursor-pointer"
                  onClick={() => openEdit(rule)}
                >
                  <h3 className="text-sm font-semibold text-gray-900">{rule.name}</h3>
                  <p className="mt-1 text-xs text-gray-400">{conditionsSummary(rule.conditions)}</p>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    <span className="rounded-full bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-700">
                      {triggerLabel(rule.trigger_event)}
                    </span>
                    <span className="rounded-full bg-purple-100 px-2 py-0.5 text-xs font-medium text-purple-700">
                      {actionLabel(rule.action_type)}
                    </span>
                    {rule.priority !== 10 && (
                      <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-500">
                        Priority {rule.priority}
                      </span>
                    )}
                  </div>
                </div>

                {/* Right: toggle + actions */}
                <div className="flex shrink-0 items-center gap-3">
                  {/* Active toggle */}
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleActive(rule);
                    }}
                    className={`relative h-6 w-11 shrink-0 rounded-full transition ${
                      rule.is_active ? 'bg-brand' : 'bg-gray-200'
                    }`}
                  >
                    <div
                      className="absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition"
                      style={{ left: rule.is_active ? '22px' : '2px' }}
                    />
                  </button>

                  {/* Edit button */}
                  <button
                    onClick={() => openEdit(rule)}
                    className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
                  >
                    <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
                      />
                    </svg>
                  </button>

                  {/* Delete button */}
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      if (confirm('Delete this rule?')) {
                        const supabase = createClient();
                        supabase
                          .from('bot_rules')
                          .delete()
                          .eq('id', rule.id)
                          .then(() => loadRules());
                      }
                    }}
                    className="rounded-lg p-1.5 text-gray-400 hover:bg-red-50 hover:text-red-500"
                  >
                    <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                      />
                    </svg>
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Reusable toggle row ──
function ToggleRow({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex w-full items-center justify-between rounded-lg border border-gray-100 bg-white p-3">
      <div className="mr-3">
        <p className="text-sm font-medium text-gray-800">{label}</p>
        <p className="text-xs text-gray-400">{description}</p>
      </div>
      <button
        type="button"
        onClick={() => onChange(!checked)}
        className={`relative h-6 w-11 shrink-0 rounded-full transition ${
          checked ? 'bg-brand' : 'bg-gray-200'
        }`}
      >
        <div
          className="absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition"
          style={{ left: checked ? '22px' : '2px' }}
        />
      </button>
    </div>
  );
}
