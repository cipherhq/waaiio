'use client';

import { useEffect, useState, useCallback } from 'react';
import { useBusiness } from '@/components/dashboard/DashboardProvider';
import { createClient } from '@/lib/supabase/client';

/* ── Types ── */

interface BotSequence {
  id: string;
  business_id: string;
  name: string;
  trigger_event: TriggerEvent;
  is_active: boolean;
  created_at: string;
  enrollment_count?: number;
}

interface BotSequenceStep {
  id?: string;
  sequence_id?: string;
  step_order: number;
  delay_minutes: number;
  message_type: MessageType;
  message_content: string;
  image_url: string;
  condition: string;
  created_at?: string;
}

interface Enrollment {
  id: string;
  sequence_id: string;
  business_id: string;
  customer_phone: string;
  current_step: number;
  next_send_at: string | null;
  status: string;
  context: Record<string, unknown> | null;
  created_at: string;
}

type TriggerEvent =
  | 'after_booking'
  | 'after_order'
  | 'after_payment'
  | 'after_signup'
  | 'after_no_show'
  | 'after_cancellation'
  | 'manual';

type MessageType = 'text' | 'image' | 'template';
type ViewMode = 'list' | 'builder';
type BuilderTab = 'steps' | 'enrollments';

/* ── Constants ── */

const TRIGGER_OPTIONS: { value: TriggerEvent; label: string }[] = [
  { value: 'after_booking', label: 'After Booking' },
  { value: 'after_order', label: 'After Order' },
  { value: 'after_payment', label: 'After Payment' },
  { value: 'after_signup', label: 'After Signup' },
  { value: 'after_no_show', label: 'After No-Show' },
  { value: 'after_cancellation', label: 'After Cancellation' },
  { value: 'manual', label: 'Manual' },
];

const DELAY_OPTIONS: { value: number; label: string }[] = [
  { value: 0, label: 'Immediately' },
  { value: 60, label: 'After 1 hour' },
  { value: 360, label: 'After 6 hours' },
  { value: 1440, label: 'After 1 day' },
  { value: 4320, label: 'After 3 days' },
  { value: 10080, label: 'After 7 days' },
];

const MESSAGE_TYPE_OPTIONS: { value: MessageType; label: string }[] = [
  { value: 'text', label: 'Text' },
  { value: 'image', label: 'Image' },
  { value: 'template', label: 'Template' },
];

const VARIABLE_CHIPS = [
  '{customer_name}',
  '{business_name}',
  '{date}',
  '{time}',
  '{amount}',
  '{reference_code}',
  '{service_name}',
];

const TRIGGER_BADGE_COLORS: Record<string, string> = {
  after_booking: 'bg-blue-100 text-blue-700',
  after_order: 'bg-green-100 text-green-700',
  after_payment: 'bg-green-100 text-green-700',
  after_signup: 'bg-blue-100 text-blue-700',
  after_no_show: 'bg-orange-100 text-orange-700',
  after_cancellation: 'bg-orange-100 text-orange-700',
  manual: 'bg-gray-100 text-gray-700',
};

function triggerLabel(event: string): string {
  return TRIGGER_OPTIONS.find((o) => o.value === event)?.label || event;
}

function emptyStep(order: number): BotSequenceStep {
  return {
    step_order: order,
    delay_minutes: 0,
    message_type: 'text',
    message_content: '',
    image_url: '',
    condition: '',
  };
}

/* ════════════════════════════════════════════════
   Main Page Component
   ════════════════════════════════════════════════ */

export default function SequencesPage() {
  const business = useBusiness();

  const [sequences, setSequences] = useState<BotSequence[]>([]);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<ViewMode>('list');

  // Builder state
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [triggerEvent, setTriggerEvent] = useState<TriggerEvent>('after_booking');
  const [isActive, setIsActive] = useState(true);
  const [steps, setSteps] = useState<BotSequenceStep[]>([emptyStep(1)]);
  const [saving, setSaving] = useState(false);
  const [builderTab, setBuilderTab] = useState<BuilderTab>('steps');

  // Enrollments
  const [enrollments, setEnrollments] = useState<Enrollment[]>([]);
  const [enrollmentsLoading, setEnrollmentsLoading] = useState(false);

  /* ── Data loading ── */

  const loadSequences = useCallback(async () => {
    setLoading(true);
    const supabase = createClient();

    const { data } = await supabase
      .from('bot_sequences')
      .select('*')
      .eq('business_id', business.id)
      .order('created_at', { ascending: false });

    const seqs = (data || []) as BotSequence[];

    // Fetch enrollment counts in one query
    if (seqs.length > 0) {
      const ids = seqs.map((s) => s.id);
      const { data: counts } = await supabase
        .from('bot_sequence_enrollments')
        .select('sequence_id')
        .eq('business_id', business.id)
        .in('sequence_id', ids);

      const countMap = new Map<string, number>();
      for (const row of counts || []) {
        countMap.set(row.sequence_id, (countMap.get(row.sequence_id) || 0) + 1);
      }
      for (const seq of seqs) {
        seq.enrollment_count = countMap.get(seq.id) || 0;
      }
    }

    setSequences(seqs);
    setLoading(false);
  }, [business.id]);

  useEffect(() => {
    loadSequences();
  }, [loadSequences]);

  async function loadEnrollments(sequenceId: string) {
    setEnrollmentsLoading(true);
    const supabase = createClient();
    const { data } = await supabase
      .from('bot_sequence_enrollments')
      .select('*')
      .eq('sequence_id', sequenceId)
      .eq('business_id', business.id)
      .order('created_at', { ascending: false })
      .limit(100);
    setEnrollments((data || []) as Enrollment[]);
    setEnrollmentsLoading(false);
  }

  async function loadSteps(sequenceId: string) {
    const supabase = createClient();
    const { data } = await supabase
      .from('bot_sequence_steps')
      .select('*')
      .eq('sequence_id', sequenceId)
      .order('step_order', { ascending: true });

    if (data && data.length > 0) {
      setSteps(
        data.map((s) => ({
          id: s.id,
          sequence_id: s.sequence_id,
          step_order: s.step_order,
          delay_minutes: s.delay_minutes,
          message_type: s.message_type,
          message_content: s.message_content || '',
          image_url: s.image_url || '',
          condition: s.condition || '',
          created_at: s.created_at,
        }))
      );
    } else {
      setSteps([emptyStep(1)]);
    }
  }

  /* ── Actions ── */

  function openNew() {
    setEditingId(null);
    setName('');
    setTriggerEvent('after_booking');
    setIsActive(true);
    setSteps([emptyStep(1)]);
    setEnrollments([]);
    setBuilderTab('steps');
    setView('builder');
  }

  async function openEdit(seq: BotSequence) {
    setEditingId(seq.id);
    setName(seq.name);
    setTriggerEvent(seq.trigger_event);
    setIsActive(seq.is_active);
    setBuilderTab('steps');
    setView('builder');
    await loadSteps(seq.id);
    loadEnrollments(seq.id);
  }

  async function handleSave() {
    if (!name.trim()) return;
    setSaving(true);
    const supabase = createClient();

    const payload = {
      business_id: business.id,
      name: name.trim(),
      trigger_event: triggerEvent,
      is_active: isActive,
    };

    let sequenceId = editingId;

    if (!editingId) {
      const { data } = await supabase
        .from('bot_sequences')
        .insert(payload)
        .select('id')
        .single();
      sequenceId = data?.id || null;
    } else {
      await supabase
        .from('bot_sequences')
        .update(payload)
        .eq('id', editingId);
    }

    // Save steps
    if (sequenceId) {
      // Remove existing steps then re-insert
      await supabase
        .from('bot_sequence_steps')
        .delete()
        .eq('sequence_id', sequenceId);

      const stepPayloads = steps.map((s, i) => ({
        sequence_id: sequenceId!,
        step_order: i + 1,
        delay_minutes: s.delay_minutes,
        message_type: s.message_type,
        message_content: s.message_content.trim() || null,
        image_url: s.image_url.trim() || null,
        condition: s.condition.trim() || null,
      }));

      if (stepPayloads.length > 0) {
        await supabase.from('bot_sequence_steps').insert(stepPayloads);
      }
    }

    setSaving(false);
    setView('list');
    loadSequences();
  }

  async function handleDelete() {
    if (!editingId || !confirm('Delete this sequence and all its steps?')) return;
    const supabase = createClient();
    await supabase.from('bot_sequence_steps').delete().eq('sequence_id', editingId);
    await supabase.from('bot_sequence_enrollments').delete().eq('sequence_id', editingId);
    await supabase.from('bot_sequences').delete().eq('id', editingId);
    setView('list');
    loadSequences();
  }

  async function handleToggleActive(seq: BotSequence) {
    const supabase = createClient();
    const newVal = !seq.is_active;
    await supabase
      .from('bot_sequences')
      .update({ is_active: newVal })
      .eq('id', seq.id);
    setSequences((prev) =>
      prev.map((s) => (s.id === seq.id ? { ...s, is_active: newVal } : s))
    );
  }

  /* ── Step helpers ── */

  function updateStep(index: number, patch: Partial<BotSequenceStep>) {
    setSteps((prev) => prev.map((s, i) => (i === index ? { ...s, ...patch } : s)));
  }

  function addStep() {
    setSteps((prev) => [...prev, emptyStep(prev.length + 1)]);
  }

  function removeStep(index: number) {
    setSteps((prev) => {
      const next = prev.filter((_, i) => i !== index);
      return next.length === 0 ? [emptyStep(1)] : next.map((s, i) => ({ ...s, step_order: i + 1 }));
    });
  }

  /* ── Loading spinner ── */

  if (loading) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-brand border-t-transparent" />
      </div>
    );
  }

  /* ════════════════════════════════════════════════
     SEQUENCE BUILDER
     ════════════════════════════════════════════════ */

  if (view === 'builder') {
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
            {editingId ? 'Edit Sequence' : 'New Sequence'}
          </h1>
        </div>

        {/* Sequence meta fields */}
        <div className="mt-5 grid gap-6 lg:grid-cols-[1fr_280px]">
          {/* Left column */}
          <div className="space-y-5">
            {/* Name */}
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">
                Sequence Name <span className="text-red-400">*</span>
              </label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Post-Booking Follow-up"
                className="w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm outline-none focus:border-brand"
                autoFocus
              />
            </div>

            {/* Trigger event */}
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">
                Trigger Event
              </label>
              <select
                value={triggerEvent}
                onChange={(e) => setTriggerEvent(e.target.value as TriggerEvent)}
                className="w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm outline-none focus:border-brand"
              >
                {TRIGGER_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>

            {/* Builder tabs */}
            <div className="flex gap-1 rounded-lg bg-gray-100 p-1 w-fit">
              <button
                onClick={() => setBuilderTab('steps')}
                className={`rounded-md px-4 py-1.5 text-sm font-medium transition ${
                  builderTab === 'steps'
                    ? 'bg-white text-gray-900 shadow-sm'
                    : 'text-gray-500 hover:text-gray-700'
                }`}
              >
                Steps
              </button>
              {editingId && (
                <button
                  onClick={() => {
                    setBuilderTab('enrollments');
                    loadEnrollments(editingId);
                  }}
                  className={`rounded-md px-4 py-1.5 text-sm font-medium transition ${
                    builderTab === 'enrollments'
                      ? 'bg-white text-gray-900 shadow-sm'
                      : 'text-gray-500 hover:text-gray-700'
                  }`}
                >
                  Enrollments
                </button>
              )}
            </div>

            {/* Steps tab */}
            {builderTab === 'steps' && (
              <div className="space-y-4">
                {steps.map((step, index) => (
                  <div
                    key={index}
                    className="rounded-xl border border-gray-100 bg-white p-6"
                  >
                    {/* Step header */}
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <div className="flex h-8 w-8 items-center justify-center rounded-full bg-brand-50 text-sm font-bold text-brand">
                          {index + 1}
                        </div>
                        <span className="text-sm font-semibold text-gray-900">
                          Step {index + 1}
                        </span>
                      </div>
                      {steps.length > 1 && (
                        <button
                          onClick={() => removeStep(index)}
                          className="rounded-lg p-1.5 text-gray-400 hover:bg-red-50 hover:text-red-500"
                          title="Remove step"
                        >
                          <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                          </svg>
                        </button>
                      )}
                    </div>

                    {/* Delay */}
                    <div className="mt-4 grid gap-4 sm:grid-cols-2">
                      <div>
                        <label className="mb-1 block text-xs font-medium text-gray-600">
                          Delay
                        </label>
                        <select
                          value={step.delay_minutes}
                          onChange={(e) =>
                            updateStep(index, { delay_minutes: Number(e.target.value) })
                          }
                          className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand"
                        >
                          {DELAY_OPTIONS.map((opt) => (
                            <option key={opt.value} value={opt.value}>
                              {opt.label}
                            </option>
                          ))}
                        </select>
                      </div>

                      {/* Message type */}
                      <div>
                        <label className="mb-1 block text-xs font-medium text-gray-600">
                          Message Type
                        </label>
                        <select
                          value={step.message_type}
                          onChange={(e) =>
                            updateStep(index, { message_type: e.target.value as MessageType })
                          }
                          className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand"
                        >
                          {MESSAGE_TYPE_OPTIONS.map((opt) => (
                            <option key={opt.value} value={opt.value}>
                              {opt.label}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>

                    {/* Message content */}
                    <div className="mt-4">
                      <label className="mb-1 block text-xs font-medium text-gray-600">
                        Message Content
                      </label>
                      <textarea
                        value={step.message_content}
                        onChange={(e) =>
                          updateStep(index, { message_content: e.target.value })
                        }
                        rows={3}
                        placeholder="Type your message here..."
                        className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand resize-none"
                      />
                      {/* Variable chips */}
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {VARIABLE_CHIPS.map((chip) => (
                          <button
                            key={chip}
                            type="button"
                            onClick={() =>
                              updateStep(index, {
                                message_content: step.message_content + chip,
                              })
                            }
                            className="rounded-md bg-gray-100 px-2 py-1 text-xs font-medium text-gray-600 hover:bg-brand-50 hover:text-brand transition"
                          >
                            {chip}
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* Image URL (shown when message_type is image) */}
                    {step.message_type === 'image' && (
                      <div className="mt-4">
                        <label className="mb-1 block text-xs font-medium text-gray-600">
                          Image URL
                        </label>
                        <input
                          type="url"
                          value={step.image_url}
                          onChange={(e) =>
                            updateStep(index, { image_url: e.target.value })
                          }
                          placeholder="https://example.com/image.jpg"
                          className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand"
                        />
                      </div>
                    )}
                  </div>
                ))}

                {/* Add Step */}
                <button
                  onClick={addStep}
                  className="flex w-full items-center justify-center gap-2 rounded-xl border-2 border-dashed border-gray-200 py-4 text-sm font-medium text-gray-500 hover:border-brand hover:text-brand transition"
                >
                  <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                  </svg>
                  Add Step
                </button>
              </div>
            )}

            {/* Enrollments tab */}
            {builderTab === 'enrollments' && (
              <div className="rounded-xl border border-gray-100 bg-white">
                {enrollmentsLoading ? (
                  <div className="flex items-center justify-center py-12">
                    <div className="h-6 w-6 animate-spin rounded-full border-2 border-brand border-t-transparent" />
                  </div>
                ) : enrollments.length === 0 ? (
                  <div className="p-8 text-center">
                    <p className="text-sm text-gray-500">No customers enrolled yet</p>
                    <p className="mt-1 text-xs text-gray-400">
                      Customers will appear here once the sequence triggers
                    </p>
                  </div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-gray-100 text-left text-xs font-medium uppercase tracking-wide text-gray-400">
                          <th className="px-6 py-3">Phone</th>
                          <th className="px-6 py-3">Current Step</th>
                          <th className="px-6 py-3">Next Send</th>
                          <th className="px-6 py-3">Status</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-50">
                        {enrollments.map((e) => (
                          <tr key={e.id} className="hover:bg-gray-50">
                            <td className="px-6 py-3 font-medium text-gray-900">
                              {e.customer_phone}
                            </td>
                            <td className="px-6 py-3 text-gray-600">
                              Step {e.current_step}
                            </td>
                            <td className="px-6 py-3 text-gray-600">
                              {e.next_send_at
                                ? new Date(e.next_send_at).toLocaleString('en-US', {
                                    month: 'short',
                                    day: 'numeric',
                                    hour: '2-digit',
                                    minute: '2-digit',
                                  })
                                : '--'}
                            </td>
                            <td className="px-6 py-3">
                              <span
                                className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${
                                  e.status === 'active'
                                    ? 'bg-green-100 text-green-700'
                                    : e.status === 'completed'
                                    ? 'bg-blue-100 text-blue-700'
                                    : e.status === 'paused'
                                    ? 'bg-orange-100 text-orange-700'
                                    : 'bg-gray-100 text-gray-600'
                                }`}
                              >
                                {e.status}
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Right column: Settings */}
          <div className="space-y-3">
            <p className="text-xs font-medium uppercase tracking-wide text-gray-400">
              Settings
            </p>

            <ToggleRow
              label="Active"
              description="Sequence will enroll and send messages"
              checked={isActive}
              onChange={setIsActive}
            />

            {editingId && (
              <div className="rounded-lg border border-gray-100 bg-white p-3">
                <p className="text-xs font-medium text-gray-400">Enrollments</p>
                <p className="mt-1 text-lg font-bold text-gray-900">
                  {enrollments.length}
                </p>
              </div>
            )}
          </div>
        </div>

        {/* Save / Cancel / Delete footer */}
        <div className="mt-6 flex gap-3 border-t border-gray-100 pt-4">
          <button
            onClick={handleSave}
            disabled={saving || !name.trim()}
            className="rounded-lg bg-brand px-6 py-2.5 text-sm font-semibold text-white hover:bg-brand-600 disabled:opacity-50"
          >
            {saving ? 'Saving...' : editingId ? 'Save Changes' : 'Create Sequence'}
          </button>
          <button
            onClick={() => setView('list')}
            className="rounded-lg border border-gray-200 px-4 py-2.5 text-sm font-medium text-gray-600 hover:bg-gray-50"
          >
            Cancel
          </button>
          {editingId && (
            <button
              onClick={handleDelete}
              className="ml-auto rounded-lg px-4 py-2.5 text-sm font-medium text-red-500 hover:bg-red-50"
            >
              Delete Sequence
            </button>
          )}
        </div>
      </div>
    );
  }

  /* ════════════════════════════════════════════════
     SEQUENCE LIST
     ════════════════════════════════════════════════ */

  return (
    <div>
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Sequences</h1>
          <p className="mt-1 text-sm text-gray-500">
            Automate time-delayed message series triggered by customer actions
          </p>
        </div>
        <button
          onClick={openNew}
          className="rounded-lg bg-brand px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-600"
        >
          + New Sequence
        </button>
      </div>

      {sequences.length === 0 ? (
        <div className="mt-8 rounded-xl border border-dashed border-gray-200 p-12 text-center">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-gray-50">
            <svg
              className="h-6 w-6 text-gray-300"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"
              />
            </svg>
          </div>
          <p className="mt-3 text-sm text-gray-500">No sequences yet</p>
          <p className="mt-1 text-xs text-gray-400">
            Create a sequence to automatically send follow-up messages after customer actions
          </p>
          <button
            onClick={openNew}
            className="mt-4 rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white hover:bg-brand-600"
          >
            + New Sequence
          </button>
        </div>
      ) : (
        <div className="mt-6 space-y-3">
          {sequences.map((seq) => (
            <div
              key={seq.id}
              className="rounded-xl border border-gray-100 bg-white p-6 transition hover:shadow-sm"
            >
              <div className="flex items-start justify-between gap-4">
                {/* Left: name + trigger badge */}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-3">
                    <h3 className="text-sm font-semibold text-gray-900 truncate">
                      {seq.name}
                    </h3>
                    <span
                      className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${
                        TRIGGER_BADGE_COLORS[seq.trigger_event] || 'bg-gray-100 text-gray-700'
                      }`}
                    >
                      {triggerLabel(seq.trigger_event)}
                    </span>
                  </div>
                  <div className="mt-2 flex items-center gap-4 text-xs text-gray-500">
                    <span className="flex items-center gap-1">
                      <svg
                        className="h-3.5 w-3.5"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z"
                        />
                      </svg>
                      {seq.enrollment_count || 0} enrolled
                    </span>
                    <span>
                      Created{' '}
                      {new Date(seq.created_at).toLocaleDateString('en-US', {
                        month: 'short',
                        day: 'numeric',
                        year: 'numeric',
                      })}
                    </span>
                  </div>
                </div>

                {/* Right: toggle + action buttons */}
                <div className="flex items-center gap-3">
                  {/* Active toggle */}
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleToggleActive(seq);
                    }}
                    className={`relative h-6 w-11 shrink-0 rounded-full transition ${
                      seq.is_active ? 'bg-brand' : 'bg-gray-200'
                    }`}
                    title={seq.is_active ? 'Active' : 'Inactive'}
                  >
                    <div
                      className="absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition"
                      style={{ left: seq.is_active ? '22px' : '2px' }}
                    />
                  </button>

                  {/* Edit button */}
                  <button
                    onClick={() => openEdit(seq)}
                    className="rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50"
                  >
                    Edit
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

/* ── Reusable toggle row ── */

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
    <div className="flex items-center justify-between rounded-lg border border-gray-100 bg-white p-3">
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
