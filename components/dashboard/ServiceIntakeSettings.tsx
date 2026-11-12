'use client';

import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';

export type IntakeTiming = 'before_booking' | 'after_booking';
export type IntakeFrequency = 'first_booking' | 'every_booking';

export interface ServiceIntakeValue {
  form_id: string | null;
  timing: IntakeTiming;
  frequency: IntakeFrequency;
}

interface FormOption {
  id: string;
  title: string;
  is_active: boolean;
  hasFileQuestion: boolean;
}

interface Props {
  businessId: string;
  /** Pro, Premium or an active trial (getLimitTier !== 'free'). */
  entitled: boolean;
  value: ServiceIntakeValue;
  onChange: (value: ServiceIntakeValue) => void;
}

/**
 * "Client intake form" setting on a service (#963 lane 2). The database guard
 * (M526) is the authority on the plan; this only hides the setting from
 * businesses that cannot use it.
 */
export function ServiceIntakeSettings({ businessId, entitled, value, onChange }: Props) {
  const [forms, setForms] = useState<FormOption[]>([]);
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    if (!entitled) return;
    let cancelled = false;
    (async () => {
      const { data, error } = await createClient()
        .from('forms')
        .select('id, title, is_active, fields')
        .eq('business_id', businessId)
        .order('created_at', { ascending: false });
      if (cancelled) return;
      if (error) { setLoadError(true); return; }
      setForms((data || []).map(f => ({
        id: f.id as string,
        title: f.title as string,
        is_active: f.is_active as boolean,
        // Client file uploads are not private yet, so a form with a file
        // question cannot be an intake form (Owner decision 2026-11-10, #963).
        hasFileQuestion: Array.isArray(f.fields) && (f.fields as Array<{ type?: string }>).some(q => q?.type === 'file'),
      })));
    })();
    return () => { cancelled = true; };
  }, [businessId, entitled]);

  if (!entitled) {
    if (!value.form_id) return null;
    return (
      <div className="space-y-2 rounded-lg border border-amber-200 bg-amber-50 p-4 dark:border-amber-800 dark:bg-amber-900/20" data-testid="intake-paused">
        <p className="text-sm font-medium text-amber-800 dark:text-amber-200">Client intake form paused</p>
        <p className="text-xs text-amber-700 dark:text-amber-300">
          Intake forms are on the Pro and Premium plans. Clients are not asked to fill it in until you upgrade.
        </p>
        <button type="button" onClick={() => onChange({ ...value, form_id: null })}
          className="text-xs font-medium text-amber-800 underline dark:text-amber-200">
          Remove the form from this service
        </button>
      </div>
    );
  }

  const selected = forms.find(f => f.id === value.form_id);

  return (
    <div className="space-y-3 rounded-lg border border-gray-100 bg-gray-50 p-4 dark:border-gray-700 dark:bg-gray-900" data-testid="intake-settings">
      <div>
        <p className="text-sm font-medium text-gray-700 dark:text-gray-300">Client intake form</p>
        <p className="text-xs text-gray-400 dark:text-gray-500">Ask clients your questions for this service. Only you can see their answers.</p>
      </div>

      {loadError ? (
        <p className="text-xs text-red-600">Your forms could not be loaded. Refresh the page to try again.</p>
      ) : (
        <select
          aria-label="Intake form"
          value={value.form_id || ''}
          onChange={e => onChange({ ...value, form_id: e.target.value || null })}
          className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100"
        >
          <option value="">No intake form</option>
          {forms.map(f => (
            <option key={f.id} value={f.id} disabled={f.hasFileQuestion && f.id !== value.form_id}>
              {f.title}{!f.is_active ? ' (inactive)' : ''}{f.hasFileQuestion ? ' (has a file question)' : ''}
            </option>
          ))}
        </select>
      )}
      {forms.some(f => f.hasFileQuestion) && (
        <p className="text-xs text-gray-400 dark:text-gray-500">Forms with a file question can&apos;t be used for intake yet.</p>
      )}
      {selected && !selected.is_active && (
        <p className="text-xs text-amber-600">This form is inactive. Clients can&apos;t fill it in until you turn it on in Surveys &amp; Forms.</p>
      )}

      {value.form_id && (
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400">When</span>
            <select aria-label="When to send" value={value.timing}
              onChange={e => onChange({ ...value, timing: e.target.value as IntakeTiming })}
              className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100">
              <option value="before_booking">Before the booking is confirmed (required)</option>
              <option value="after_booking">After the booking is confirmed</option>
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400">How often</span>
            <select aria-label="How often" value={value.frequency}
              onChange={e => onChange({ ...value, frequency: e.target.value as IntakeFrequency })}
              className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100">
              <option value="first_booking">First booking only</option>
              <option value="every_booking">Every booking</option>
            </select>
          </label>
        </div>
      )}
    </div>
  );
}
