'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useBusiness } from '@/components/dashboard/DashboardProvider';
import { PageHelp } from '@/components/dashboard/PageHelp';
import EmptyState from '@/components/dashboard/EmptyState';

interface TranslationOverride {
  id?: string;
  lang: string;
  key: string;
  value: string;
  updated_at?: string;
}

interface PlatformOverride {
  lang: string;
  key: string;
  value: string;
}

interface TranslationsData {
  overrides: TranslationOverride[];
  platformOverrides: PlatformOverride[];
  allowedLanguages: string[];
  allKeys: string[];
}

/** Extract category prefix from a key like "booking.confirm_btn" -> "booking" */
function getCategory(key: string): string {
  const dot = key.indexOf('.');
  return dot > 0 ? key.substring(0, dot) : 'general';
}

/** Human-readable category labels */
const CATEGORY_LABELS: Record<string, string> = {
  greeting: 'Greeting',
  nav: 'Navigation',
  error: 'Errors & Recovery',
  menu: 'Menu',
  account: 'My Account',
  booking: 'Booking & Scheduling',
  ordering: 'Ordering',
  payment: 'Payments',
  ticketing: 'Ticketing & Events',
  giving: 'Giving & Donations',
  crowdfunding: 'Campaigns',
  invoice: 'Invoices',
  loyalty: 'Loyalty',
  referral: 'Referrals',
  feedback: 'Reviews & Feedback',
  queue: 'Queue',
  waitlist: 'Waitlist',
  survey: 'Surveys & Forms',
  poll: 'Polls',
  recurring: 'Subscriptions',
  broadcast: 'Broadcasts',
  chat: 'Live Chat',
  waiver: 'Waivers',
  contract: 'Contracts & E-Sign',
  promo: 'Promotions',
  general: 'General',
};

/** Language display names */
const LANGUAGE_NAMES: Record<string, string> = {
  en: 'English',
  pcm: 'Nigerian Pidgin',
  yo: 'Yoruba',
  ig: 'Igbo',
  ha: 'Hausa',
  tw: 'Twi',
  fr: 'French',
  es: 'Spanish',
};

export default function TranslationsPage() {
  const business = useBusiness();

  const [data, setData] = useState<TranslationsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [validationErrors, setValidationErrors] = useState<string[]>([]);

  const [selectedLang, setSelectedLang] = useState<string>('en');
  const [search, setSearch] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);

  // Local edits: Map<"lang:key", value>
  const [edits, setEdits] = useState<Map<string, string>>(new Map());
  const [dirty, setDirty] = useState(false);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/translations?businessId=${business.id}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: 'Failed to load translations' }));
        setError(body.error || 'Failed to load translations');
        setLoading(false);
        return;
      }
      const json: TranslationsData = await res.json();
      setData(json);

      // Default to first non-English language if available, otherwise English
      if (json.allowedLanguages.length > 1) {
        const firstNonEn = json.allowedLanguages.find(l => l !== 'en');
        if (firstNonEn) setSelectedLang(firstNonEn);
      }

      // Populate edits from existing overrides
      const map = new Map<string, string>();
      for (const ov of json.overrides) {
        map.set(`${ov.lang}:${ov.key}`, ov.value);
      }
      setEdits(map);
      setDirty(false);
    } catch {
      setError('Failed to load translations');
    }
    setLoading(false);
  }, [business.id]);

  useEffect(() => {
    loadData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [business.id]);

  // Get the platform default for a key+lang
  const getPlatformDefault = useCallback((lang: string, key: string): string => {
    if (!data) return '';
    // Check platform overrides first
    const po = data.platformOverrides.find(p => p.lang === lang && p.key === key);
    if (po) return po.value;
    // Fall back to English platform override
    const enPo = data.platformOverrides.find(p => p.lang === 'en' && p.key === key);
    if (enPo) return enPo.value;
    return '';
  }, [data]);

  // Get the English default text for a key (from platform overrides or key name)
  const getEnglishDefault = useCallback((key: string): string => {
    if (!data) return '';
    const po = data.platformOverrides.find(p => p.lang === 'en' && p.key === key);
    return po?.value || '';
  }, [data]);

  // Group keys by category
  const categories = useMemo(() => {
    if (!data) return [];
    const cats = new Map<string, string[]>();
    for (const key of data.allKeys) {
      const cat = getCategory(key);
      if (!cats.has(cat)) cats.set(cat, []);
      cats.get(cat)!.push(key);
    }
    return Array.from(cats.entries())
      .map(([cat, keys]) => ({ id: cat, label: CATEGORY_LABELS[cat] || cat, keys }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [data]);

  // Filter keys by search + selected category
  const filteredKeys = useMemo(() => {
    if (!data) return [];
    let keys = data.allKeys;
    if (selectedCategory) {
      keys = keys.filter(k => getCategory(k) === selectedCategory);
    }
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      keys = keys.filter(k => {
        if (k.toLowerCase().includes(q)) return true;
        const defaultText = getEnglishDefault(k);
        if (defaultText.toLowerCase().includes(q)) return true;
        const editKey = `${selectedLang}:${k}`;
        const editVal = edits.get(editKey);
        if (editVal && editVal.toLowerCase().includes(q)) return true;
        return false;
      });
    }
    return keys;
  }, [data, selectedCategory, search, selectedLang, edits, getEnglishDefault]);

  function handleEdit(key: string, value: string) {
    const editKey = `${selectedLang}:${key}`;
    setEdits(prev => {
      const next = new Map(prev);
      if (value === '') {
        next.delete(editKey);
      } else {
        next.set(editKey, value);
      }
      return next;
    });
    setDirty(true);
  }

  async function handleSave() {
    if (!data) return;
    setSaving(true);
    setSaved(false);
    setValidationErrors([]);

    // Build overrides array from all edits
    const overrides: Array<{ lang: string; key: string; value: string | null }> = [];

    // For every key in every language, check if there's an edit
    for (const [editKey, value] of Array.from(edits.entries())) {
      const [lang, ...rest] = editKey.split(':');
      const key = rest.join(':');
      overrides.push({ lang, key, value: value.trim() || null });
    }

    // Also send deletes for original overrides that were cleared
    if (data.overrides) {
      for (const ov of data.overrides) {
        const editKey = `${ov.lang}:${ov.key}`;
        if (!edits.has(editKey)) {
          overrides.push({ lang: ov.lang, key: ov.key, value: null });
        }
      }
    }

    if (overrides.length === 0) {
      setSaving(false);
      return;
    }

    try {
      const res = await fetch('/api/translations', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ businessId: business.id, overrides }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: 'Save failed' }));
        if (body.errors) {
          setValidationErrors(body.errors);
        } else {
          setError(body.error || 'Save failed');
        }
        setSaving(false);
        return;
      }

      setSaved(true);
      setDirty(false);
      setTimeout(() => setSaved(false), 3000);
      // Reload to get fresh data
      await loadData();
    } catch {
      setError('Failed to save. Please try again.');
    }
    setSaving(false);
  }

  const inputClass =
    'w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500';

  if (loading) {
    return (
      <div className="mx-auto max-w-4xl px-4 py-6 sm:px-6">
        <div className="flex items-center justify-center py-16">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-brand-600 border-t-transparent" />
        </div>
      </div>
    );
  }

  if (error && !data) {
    return (
      <div className="mx-auto max-w-4xl px-4 py-6 sm:px-6">
        <div className="rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 p-4">
          <p className="text-sm text-red-700 dark:text-red-300">{error}</p>
          <button
            onClick={loadData}
            className="mt-2 text-sm font-medium text-red-600 dark:text-red-400 underline"
          >
            Try again
          </button>
        </div>
      </div>
    );
  }

  // If business has only English, show empty state
  if (data && data.allowedLanguages.length <= 1) {
    return (
      <div className="mx-auto max-w-4xl px-4 py-6 sm:px-6">
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Bot Text</h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Customize the messages your customers see in WhatsApp
          </p>
        </div>
        <EmptyState
          icon="T"
          title="Add more languages first"
          description="Translation overrides are available when your business supports multiple languages. Go to AI Settings to enable additional languages, then come back here to customize the text."
          actionLabel="Go to AI Settings"
          actionHref="/dashboard/ai-settings"
          tip="Even with only English, you can still override any message your bot sends. Enable at least one more language in AI Settings to unlock this page."
        />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl px-4 py-6 sm:px-6">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Bot Text</h1>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          Customize the messages your customers see in WhatsApp
        </p>
        <PageHelp
          pageKey="translations"
          title="Translation Overrides"
          description="Customize the text your customers see in WhatsApp. Override any message for each language you offer. Leave blank to use the platform default."
        />
      </div>

      {/* Language tabs */}
      {data && (
        <div className="mb-4 flex flex-wrap gap-1 rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 p-1">
          {data.allowedLanguages.map(lang => (
            <button
              key={lang}
              onClick={() => setSelectedLang(lang)}
              className={`rounded-md px-3 py-1.5 text-sm font-medium transition ${
                selectedLang === lang
                  ? 'bg-white dark:bg-gray-700 text-brand-600 dark:text-brand-400 shadow-sm'
                  : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'
              }`}
            >
              {LANGUAGE_NAMES[lang] || lang}
            </button>
          ))}
        </div>
      )}

      {/* Search + category filter */}
      <div className="mb-4 flex flex-col gap-3 sm:flex-row">
        <div className="relative flex-1">
          <svg
            className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
            />
          </svg>
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search keys or text..."
            className={`${inputClass} pl-9`}
          />
        </div>
        <select
          value={selectedCategory || ''}
          onChange={e => setSelectedCategory(e.target.value || null)}
          className={`${inputClass} sm:w-48`}
        >
          <option value="">All categories</option>
          {categories.map(cat => (
            <option key={cat.id} value={cat.id}>
              {cat.label} ({cat.keys.length})
            </option>
          ))}
        </select>
      </div>

      {/* Validation errors */}
      {validationErrors.length > 0 && (
        <div className="mb-4 rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 p-4">
          <p className="mb-2 text-sm font-medium text-red-700 dark:text-red-300">
            Please fix the following errors:
          </p>
          <ul className="space-y-1">
            {validationErrors.map((err, i) => (
              <li key={i} className="text-sm text-red-600 dark:text-red-400">
                {err}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Error banner */}
      {error && data && (
        <div className="mb-4 rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 p-3">
          <p className="text-sm text-red-700 dark:text-red-300">{error}</p>
        </div>
      )}

      {/* Translation keys grouped by category */}
      {data && (
        <div className="space-y-6">
          {categories
            .filter(cat => !selectedCategory || cat.id === selectedCategory)
            .map(cat => {
              const keysInCategory = cat.keys.filter(k => filteredKeys.includes(k));
              if (keysInCategory.length === 0) return null;
              return (
                <div
                  key={cat.id}
                  className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800"
                >
                  <div className="border-b border-gray-100 dark:border-gray-700 px-4 py-3">
                    <h2 className="text-sm font-semibold text-gray-900 dark:text-white">
                      {cat.label}
                    </h2>
                    <p className="text-xs text-gray-400 dark:text-gray-500">
                      {keysInCategory.length} key{keysInCategory.length !== 1 ? 's' : ''}
                    </p>
                  </div>
                  <div className="divide-y divide-gray-100 dark:divide-gray-700">
                    {keysInCategory.map(key => {
                      const editKey = `${selectedLang}:${key}`;
                      const currentValue = edits.get(editKey) || '';
                      const platformDefault = getPlatformDefault(selectedLang, key);
                      const englishDefault = getEnglishDefault(key);
                      const displayDefault = platformDefault || englishDefault;

                      return (
                        <div key={key} className="px-4 py-3">
                          <div className="mb-1.5 flex items-baseline gap-2">
                            <span className="text-xs font-mono font-medium text-gray-500 dark:text-gray-400">
                              {key}
                            </span>
                          </div>
                          {displayDefault && (
                            <p className="mb-2 text-xs text-gray-400 dark:text-gray-500 leading-relaxed">
                              Default: {displayDefault}
                            </p>
                          )}
                          <textarea
                            value={currentValue}
                            onChange={e => handleEdit(key, e.target.value)}
                            placeholder={displayDefault || 'Enter override text...'}
                            rows={Math.max(1, Math.ceil((displayDefault?.length || 40) / 60))}
                            className={`${inputClass} resize-y text-sm`}
                          />
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}

          {filteredKeys.length === 0 && (
            <div className="py-12 text-center">
              <p className="text-sm text-gray-500 dark:text-gray-400">
                No keys match your search.
              </p>
            </div>
          )}
        </div>
      )}

      {/* Sticky save bar */}
      {data && (
        <div className="sticky bottom-0 mt-6 flex items-center gap-3 rounded-xl border border-gray-200 dark:border-gray-700 bg-white/95 dark:bg-gray-800/95 px-4 py-3 backdrop-blur-sm shadow-lg">
          <button
            onClick={handleSave}
            disabled={saving || !dirty}
            className="rounded-lg bg-brand-600 px-6 py-2.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50 transition-colors"
          >
            {saving ? 'Saving...' : 'Save Changes'}
          </button>
          {saved && (
            <span className="text-sm text-green-600 dark:text-green-400">Changes saved</span>
          )}
          {dirty && !saved && (
            <span className="text-xs text-gray-400">Unsaved changes</span>
          )}
          <div className="ml-auto text-xs text-gray-400">
            {filteredKeys.length} of {data.allKeys.length} keys shown
          </div>
        </div>
      )}
    </div>
  );
}
