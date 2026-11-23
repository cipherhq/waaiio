'use client';

import { useEffect, useState } from 'react';
import { WEEKDAY_SHORT } from '@/lib/products/availability';
import { CLIENT_IMAGE_ACCEPT, ImagePrepError, prepareImageForUpload } from '@/lib/ai-setup/client-image';
import type { ViewMode } from './types';

/**
 * "Upload this week's menu" (Owner decisions 2026-11-23, M556). Ace reads the
 * photo(s); the owner reviews the dishes grouped by day, fixes name, price and
 * days, removes or adds dishes, then one "Save menu" saves them for this week.
 * Nothing is saved before that tap.
 */

interface Dish {
  key: number;
  name: string;
  /** null = no price yet; the menu cannot be saved until one is typed (0 = free). */
  price: number | null;
  /** ISO weekdays; empty = every day this week. */
  days: number[];
  category: string;
  description: string;
}

interface Allowance {
  limit: number;
  left: number;
  on_free_plan: boolean;
  week_start: string;
  week_end: string;
}

interface SaveResult {
  created?: number;
  updated?: number;
  hidden?: number;
  skipped?: string[];
}

interface Props {
  businessId: string;
  curr: string;
  setView: (view: ViewMode) => void;
  onSaved: () => void;
}

let nextKey = 1;

async function readJson(res: Response): Promise<Record<string, any>> {
  try {
    return await res.json();
  } catch {
    return {};
  }
}

function shortDate(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
}

function groupLabel(days: number[]): string {
  return days.length === 0 ? 'Every day this week' : days.map(d => WEEKDAY_SHORT[d - 1]).join(', ');
}

export default function WeeklyMenuUpload({ businessId, curr, setView, onSaved }: Props) {
  const [allowance, setAllowance] = useState<Allowance | null>(null);
  const [allowanceError, setAllowanceError] = useState<string | null>(null);
  const [dishes, setDishes] = useState<Dish[]>([]);
  const [reading, setReading] = useState(false);
  const [readMessage, setReadMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState<SaveResult | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/products/weekly-menu?business_id=${encodeURIComponent(businessId)}`);
        const data = await readJson(res);
        if (cancelled) return;
        if (!res.ok) setAllowanceError(data.error || 'Could not load your menu reads.');
        else setAllowance(data as Allowance);
      } catch {
        if (!cancelled) setAllowanceError('Could not load your menu reads.');
      }
    })();
    return () => { cancelled = true; };
  }, [businessId]);

  const update = (key: number, patch: Partial<Dish>) =>
    setDishes(prev => prev.map(d => (d.key === key ? { ...d, ...patch } : d)));

  const toggleDay = (dish: Dish, day: number) => {
    const days = dish.days.includes(day) ? dish.days.filter(d => d !== day) : [...dish.days, day].sort((a, b) => a - b);
    update(dish.key, { days: days.length === 7 ? [] : days });
  };

  const handleFiles = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    if (files.length === 0) return;
    setReading(true);
    setReadMessage(null);
    const problems: string[] = [];

    // One photo at a time: each photo is one menu read.
    for (const original of files) {
      const label = files.length > 1 ? `${original.name}: ` : '';
      let file: File;
      try {
        file = await prepareImageForUpload(original);
      } catch (err) {
        problems.push(label + (err instanceof ImagePrepError ? err.message : 'Could not prepare this photo.'));
        continue;
      }
      const formData = new FormData();
      formData.append('file', file);
      formData.append('business_id', businessId);
      formData.append('mode', 'weekly_menu');
      try {
        const res = await fetch('/api/ai-setup/parse-image', { method: 'POST', body: formData });
        const data = await readJson(res);
        if (typeof data.reads_left === 'number') {
          const left = data.reads_left;
          setAllowance(prev => (prev ? { ...prev, left } : prev));
        }
        if (!res.ok) {
          problems.push(label + (data.error || 'Ace could not read that photo. Try a clearer photo.'));
          if (res.status === 403 || res.status === 429) break; // no reads left or rate limit — stop sending more
          continue;
        }
        const items: Array<Record<string, unknown>> = Array.isArray(data.items) ? data.items : [];
        if (items.length === 0) {
          problems.push(label + (data.message || 'Could not read the menu clearly. Try a clearer photo.'));
          continue;
        }
        setDishes(prev => [...prev, ...items.map(item => ({
          key: nextKey++,
          name: typeof item.name === 'string' ? item.name : '',
          price: typeof item.price === 'number' && Number.isFinite(item.price) && item.price >= 0 ? item.price : null,
          days: Array.isArray(item.days) ? (item.days as number[]) : [],
          category: typeof item.category === 'string' ? item.category : '',
          description: typeof item.description === 'string' ? item.description : '',
        }))]);
      } catch {
        problems.push(label + 'Something went wrong reading the photo. Please try again.');
      }
    }
    if (problems.length) setReadMessage(problems.join('\n'));
    setReading(false);
  };

  const unnamed = dishes.filter(d => !d.name.trim()).length;
  const unpriced = dishes.filter(d => d.name.trim() && d.price === null).length;
  const canSave = dishes.length > 0 && unnamed === 0 && unpriced === 0 && !saving;

  const handleSave = async () => {
    if (!canSave) return;
    setSaving(true);
    setSaveError(null);
    try {
      const res = await fetch('/api/products/weekly-menu', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          business_id: businessId,
          items: dishes.map(d => ({ name: d.name, price: d.price, days: d.days, category: d.category, description: d.description })),
        }),
      });
      const data = await readJson(res);
      if (!res.ok) {
        setSaveError(data.error || 'Could not save your menu. Please try again.');
      } else {
        setSaved(data as SaveResult);
        onSaved();
      }
    } catch {
      setSaveError('Could not save your menu. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  // Groups: every day first, then by first weekday.
  const groups = new Map<string, Dish[]>();
  for (const d of [...dishes].sort((a, b) => (a.days[0] ?? 0) - (b.days[0] ?? 0) || a.days.length - b.days.length)) {
    const label = groupLabel(d.days);
    groups.set(label, [...(groups.get(label) || []), d]);
  }

  const noReadsLeft = allowance !== null && allowance.left <= 0;
  const weekText = allowance ? `${shortDate(allowance.week_start)} – ${shortDate(allowance.week_end)}` : 'this week';
  const chip = (active: boolean) =>
    `min-h-[36px] min-w-[40px] rounded-md border px-2 text-xs font-medium ${active
      ? 'border-brand bg-brand text-white'
      : 'border-gray-200 bg-white text-gray-600 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-300'}`;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <button aria-label="Go back" onClick={() => setView('list')} className="rounded-lg p-2 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-700 dark:hover:text-gray-300">
          <svg aria-hidden="true" className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
        </button>
        <div>
          <h1 className="text-xl font-bold text-gray-900 dark:text-gray-100">Upload this week&apos;s menu</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400">Take a photo of your menu. Ace reads the dishes and their days. Nothing is saved until you tap Save menu.</p>
        </div>
      </div>

      {saved ? (
        <div role="status" className="rounded-lg border border-green-200 bg-green-50 p-4 text-sm text-green-800 dark:border-green-800 dark:bg-green-900/20 dark:text-green-300 space-y-2">
          <p className="font-medium">Menu saved for {weekText}.</p>
          <p>
            {saved.created ?? 0} new dish{saved.created === 1 ? '' : 'es'}, {saved.updated ?? 0} brought back from earlier menus.
            {saved.hidden ? ` ${saved.hidden} dish${saved.hidden === 1 ? '' : 'es'} from your last menu ${saved.hidden === 1 ? 'is' : 'are'} now hidden from customers (not deleted).` : ''}
          </p>
          {saved.skipped && saved.skipped.length > 0 && (
            <p>Already on your menu every day, so left as they are: {saved.skipped.join(', ')}.</p>
          )}
          <button onClick={() => setView('list')} className="rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white hover:bg-brand-600">Back to products</button>
        </div>
      ) : (
        <>
          <div className="rounded-lg border border-dashed border-gray-300 bg-white p-4 dark:border-gray-600 dark:bg-gray-800 space-y-2">
            {allowanceError && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{allowanceError}</p>}
            {allowance && (
              <p className="text-sm font-medium text-gray-700 dark:text-gray-300">
                {allowance.left} of {allowance.limit} menu read{allowance.limit === 1 ? '' : 's'} left today
              </p>
            )}
            {noReadsLeft && (
              <p className="text-sm text-gray-600 dark:text-gray-400">
                You&apos;ve used today&apos;s menu reads. You can upload again tomorrow.
                {allowance?.on_free_plan && (
                  <> <a href="/dashboard/billing" className="font-medium text-brand underline">Upgrade to Pro</a> for 5 menu reads a day.</>
                )}
              </p>
            )}
            {reading ? (
              <p role="status" className="py-3 text-center text-sm text-gray-500">Ace is reading your menu...</p>
            ) : (
              <label className={`flex min-h-[44px] items-center justify-center gap-2 rounded-lg border border-gray-200 px-3 py-3 text-sm font-medium dark:border-gray-600 ${noReadsLeft || !allowance ? 'cursor-not-allowed opacity-50' : 'cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-700/50'}`}>
                <input type="file" accept={CLIENT_IMAGE_ACCEPT} multiple onChange={handleFiles} className="hidden" disabled={noReadsLeft || !allowance} aria-label="Menu photos" />
                Choose menu photo{dishes.length ? 's (adds to the list below)' : 's'}
              </label>
            )}
            {readMessage && <p role="alert" className="whitespace-pre-line text-sm text-red-600 dark:text-red-400">{readMessage}</p>}
          </div>

          {dishes.length > 0 && (
            <section aria-label="Dishes to review" className="space-y-4">
              {[...groups.entries()].map(([label, list]) => (
                <div key={label} className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800 space-y-3">
                  <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">{label} ({list.length})</h2>
                  {list.map(d => (
                    <div key={d.key} className="space-y-2 border-t border-gray-100 pt-3 first:border-0 first:pt-0 dark:border-gray-700">
                      <div className="flex items-center gap-2">
                        <input value={d.name} onChange={e => update(d.key, { name: e.target.value })} maxLength={200}
                          placeholder="Dish name" aria-label="Dish name" aria-invalid={!d.name.trim()}
                          className="flex-1 rounded border border-gray-200 px-2 py-1.5 text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100" />
                        <span className="text-sm text-gray-500" aria-hidden="true">{curr}</span>
                        <input type="number" min={0} value={d.price ?? ''} onChange={e => update(d.key, { price: e.target.value === '' ? null : Number(e.target.value) })}
                          placeholder="Add price" aria-label={`Price for ${d.name || 'dish'}`} aria-invalid={d.price === null}
                          className={`w-24 rounded border px-2 py-1.5 text-sm dark:bg-gray-700 dark:text-gray-100 ${d.price === null ? 'border-red-500 bg-red-50 dark:border-red-500 dark:bg-red-900/20' : 'border-gray-200 dark:border-gray-600'}`} />
                        <button onClick={() => setDishes(prev => prev.filter(x => x.key !== d.key))} aria-label={`Remove ${d.name || 'dish'}`} className="min-h-[36px] min-w-[36px] text-red-400 hover:text-red-600">
                          <svg aria-hidden="true" className="mx-auto h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                        </button>
                      </div>
                      <div role="group" aria-label={`Days for ${d.name || 'dish'}`} className="flex flex-wrap gap-1">
                        <button type="button" aria-pressed={d.days.length === 0} onClick={() => update(d.key, { days: [] })} className={chip(d.days.length === 0)}>Every day</button>
                        {WEEKDAY_SHORT.map((day, i) => (
                          <button key={day} type="button" aria-pressed={d.days.includes(i + 1)} onClick={() => toggleDay(d, i + 1)} className={chip(d.days.includes(i + 1))}>{day}</button>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              ))}
            </section>
          )}

          <button onClick={() => setDishes(prev => [...prev, { key: nextKey++, name: '', price: null, days: [], category: '', description: '' }])}
            className="text-sm font-medium text-brand hover:underline">
            + Add a dish
          </button>

          {unpriced > 0 && (
            <p className="text-sm text-red-600 dark:text-red-400">
              {unpriced} dish{unpriced === 1 ? ' needs' : 'es need'} a price. Type a price in the highlighted box{unpriced === 1 ? '' : 'es'} (0 if it&apos;s free).
            </p>
          )}
          {unnamed > 0 && <p className="text-sm text-red-600 dark:text-red-400">Give every dish a name, or remove it.</p>}

          {dishes.length > 0 && (
            <div className="space-y-2">
              <p className="text-xs text-gray-500 dark:text-gray-400">
                These dishes go on sale for {weekText}, on the days picked. Dishes from your last weekly menu are hidden from customers, not deleted. Your everyday items don&apos;t change.
              </p>
              {saveError && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{saveError}</p>}
              <button onClick={handleSave} disabled={!canSave}
                className="min-h-[44px] rounded-lg bg-brand px-5 py-2 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-50">
                {saving ? 'Saving...' : 'Save menu'}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
