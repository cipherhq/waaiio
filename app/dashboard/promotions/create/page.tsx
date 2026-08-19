'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useBusiness } from '@/components/dashboard/DashboardProvider';
import { createClient } from '@/lib/supabase/client';
import { useRouter } from 'next/navigation';
import type { PromoPrizeType, PromoCodeEntryMode } from '@/lib/promotions/types';
import { MIN_GENERATED_BODY_LENGTH, computeBodyLength, validateGeneratedEntropy, normalizePromoCode, isImportablePromoCode } from '@/lib/promotions/normalize';

// ─── Constants ───────────────────────────────────────────────────────────────

const TIMEZONES = [
  'UTC',
  'Africa/Lagos',
  'Africa/Nairobi',
  'Africa/Accra',
  'Africa/Johannesburg',
  'Africa/Cairo',
  'Africa/Casablanca',
  'Africa/Abidjan',
  'Africa/Dar_es_Salaam',
  'Africa/Kampala',
  'Africa/Kigali',
  'Africa/Lusaka',
  'Africa/Harare',
  'Africa/Luanda',
  'Africa/Dakar',
  'Europe/London',
  'Europe/Paris',
  'Europe/Amsterdam',
  'Europe/Berlin',
  'Europe/Madrid',
  'America/New_York',
  'America/Chicago',
  'America/Los_Angeles',
  'America/Toronto',
  'America/Sao_Paulo',
];

const PRIZE_TYPES: { value: PromoPrizeType; label: string }[] = [
  { value: 'cash', label: 'Cash' },
  { value: 'airtime', label: 'Airtime' },
  { value: 'product', label: 'Product' },
  { value: 'voucher', label: 'Voucher' },
  { value: 'discount', label: 'Discount' },
  { value: 'custom', label: 'Custom' },
];

const CURRENCIES = ['NGN', 'USD', 'GBP', 'GHS', 'KES'];

const ENTRY_MODES: { value: PromoCodeEntryMode; label: string; description: string }[] = [
  { value: 'keyword', label: 'Keyword only', description: 'Customer must send the keyword, then enter their code' },
  { value: 'bare_code', label: 'Bare code', description: 'Customer sends their code directly without any keyword' },
  { value: 'both', label: 'Both', description: 'Accept codes sent via keyword flow or directly as bare codes' },
];

const STEP_LABELS = [
  'Basics',
  'Codes',
  'Prizes',
  'WhatsApp',
  'Eligibility',
  'Review',
];

// ─── Types ────────────────────────────────────────────────────────────────────

interface PrizeTier {
  _key: string; // local UI key for list rendering
  name: string;
  prize_type: PromoPrizeType;
  quantity: number;
  value: string;
  currency: string;
  fulfillment_instructions: string;
}

interface WizardState {
  // Step 1 — Basics
  name: string;
  description: string;
  start_at: string;
  end_at: string;
  timezone: string;
  // Step 2 — Codes
  code_source: 'generate' | 'import';
  code_count: number;
  code_length: number;
  code_prefix: string;
  import_file: File | null;
  import_preview: string[]; // first few codes from CSV
  import_error: string;
  import_total: number;
  // Step 3 — Prizes
  prizes: PrizeTier[];
  // Step 4 — WhatsApp
  keyword: string;
  code_entry_mode: PromoCodeEntryMode;
  accept_bare_codes: boolean;
  winner_message: string;
  try_again_message: string;
  invalid_message: string;
  already_used_message: string;
  expired_message: string;
  // Step 5 — Eligibility & Fraud
  max_attempts_per_phone: number;
  rate_limit_max_attempts: number;
  rate_limit_window_minutes: number;
  eligibility_mode: 'none' | 'age_confirmation' | 'custom';
  eligibility_min_age: number;
  eligibility_prompt: string;
}

const DEFAULT_WINNER_MESSAGE =
  'Congratulations! You won {prize_name}. Your claim reference is {claim_ref}. We will contact you shortly with next steps.';
const DEFAULT_TRY_AGAIN_MESSAGE =
  'Sorry, not a winner this time. Better luck next round! Keep participating for more chances to win.';
const DEFAULT_INVALID_MESSAGE =
  'That code is not valid. Please check and try again with a valid code.';
const DEFAULT_ALREADY_USED_MESSAGE =
  'This code has already been claimed. Each code can only be used once.';
const DEFAULT_EXPIRED_MESSAGE =
  'This campaign has ended. Thank you for participating!';

function makeKey() {
  return Math.random().toString(36).slice(2, 10);
}

function generateExampleCodes(count: number, length: number, prefix: string): string[] {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bodyLen = computeBodyLength(length, prefix || null);
  const codes: string[] = [];
  for (let i = 0; i < count; i++) {
    const body = Array.from({ length: bodyLen }, () =>
      chars[Math.floor(Math.random() * chars.length)]
    ).join('');
    codes.push(prefix + body);
  }
  return codes;
}

// ─── Step Components ─────────────────────────────────────────────────────────

function FieldLabel({ children, required }: { children: React.ReactNode; required?: boolean }) {
  return (
    <label className="mb-1.5 block text-sm font-medium text-gray-700 dark:text-gray-300">
      {children}
      {required && <span className="ml-0.5 text-red-500">*</span>}
    </label>
  );
}

function Input({
  value,
  onChange,
  type = 'text',
  placeholder,
  min,
  max,
  className = '',
  autoFocus,
}: {
  value: string | number;
  onChange: (v: string) => void;
  type?: string;
  placeholder?: string;
  min?: number;
  max?: number;
  className?: string;
  autoFocus?: boolean;
}) {
  return (
    <input
      type={type}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      min={min}
      max={max}
      autoFocus={autoFocus}
      className={`w-full rounded-lg border border-gray-200 bg-white px-3 py-2.5 text-sm text-gray-900 outline-none transition focus:border-brand focus:ring-1 focus:ring-brand dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100 dark:focus:border-brand ${className}`}
    />
  );
}

function Textarea({
  value,
  onChange,
  placeholder,
  rows = 3,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  rows?: number;
}) {
  return (
    <textarea
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      rows={rows}
      className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2.5 text-sm text-gray-900 outline-none transition focus:border-brand focus:ring-1 focus:ring-brand dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100 dark:focus:border-brand resize-none"
    />
  );
}

function Select<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value as T)}
      className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2.5 text-sm text-gray-900 outline-none transition focus:border-brand focus:ring-1 focus:ring-brand dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100"
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className={`relative h-6 w-11 shrink-0 rounded-full transition-colors duration-200 focus:outline-none ${checked ? 'bg-brand' : 'bg-gray-200 dark:bg-gray-600'}`}
    >
      <span
        className="absolute top-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-transform duration-200"
        style={{ left: checked ? '22px' : '2px' }}
      />
    </button>
  );
}

function Card({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`rounded-xl border border-gray-100 bg-white p-5 dark:border-gray-800 dark:bg-gray-900 ${className}`}>
      {children}
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="mb-4 text-sm font-semibold text-gray-900 dark:text-gray-100">{children}</h3>
  );
}

// ─── Step 1: Basics ───────────────────────────────────────────────────────────

function Step1Basics({ state, update }: { state: WizardState; update: (p: Partial<WizardState>) => void }) {
  return (
    <div className="space-y-5">
      <Card>
        <SectionTitle>Campaign Details</SectionTitle>
        <div className="space-y-4">
          <div>
            <FieldLabel required>Campaign Name</FieldLabel>
            <Input
              value={state.name}
              onChange={(v) => update({ name: v })}
              placeholder="e.g. Summer Win Big Campaign"
              autoFocus
            />
          </div>
          <div>
            <FieldLabel>Description</FieldLabel>
            <Textarea
              value={state.description}
              onChange={(v) => update({ description: v })}
              placeholder="Optional — describe this campaign to your team..."
              rows={3}
            />
          </div>
        </div>
      </Card>

      <Card>
        <SectionTitle>Schedule</SectionTitle>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <FieldLabel>Start Date &amp; Time</FieldLabel>
            <Input
              type="datetime-local"
              value={state.start_at}
              onChange={(v) => update({ start_at: v })}
            />
          </div>
          <div>
            <FieldLabel>End Date &amp; Time</FieldLabel>
            <Input
              type="datetime-local"
              value={state.end_at}
              onChange={(v) => update({ end_at: v })}
            />
          </div>
          <div className="sm:col-span-2">
            <FieldLabel>Timezone</FieldLabel>
            <Select
              value={state.timezone}
              onChange={(v) => update({ timezone: v })}
              options={TIMEZONES.map((tz) => ({ value: tz, label: tz }))}
            />
            <p className="mt-1 text-xs text-gray-400">
              All dates and times above are interpreted in this timezone.
            </p>
          </div>
        </div>
      </Card>
    </div>
  );
}

// ─── Step 2: Codes ────────────────────────────────────────────────────────────

function Step2Codes({ state, update }: { state: WizardState; update: (p: Partial<WizardState>) => void }) {
  const dropRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  const exampleCodes = generateExampleCodes(
    3,
    Math.max(state.code_prefix.length + 1, state.code_length),
    state.code_prefix.toUpperCase().slice(0, 4),
  );

  const handleFile = useCallback((file: File) => {
    if (!file.name.endsWith('.csv') && file.type !== 'text/csv') {
      update({ import_error: 'Please upload a .csv file.', import_file: null, import_preview: [], import_total: 0 });
      return;
    }
    const reader = new FileReader();
    reader.onload = (e) => {
      const text = e.target?.result as string;
      const lines = text
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);
      const dataLines = lines[0]?.toLowerCase().includes('code') ? lines.slice(1) : lines;
      const rawCodes = dataLines.map((l) => l.split(',')[0].trim()).filter(Boolean);
      if (rawCodes.length === 0) {
        update({ import_error: 'No codes found in file.', import_file: null, import_preview: [], import_total: 0 });
        return;
      }
      // Validate each code against import security policy
      let invalidCount = 0;
      const validCodes: string[] = [];
      for (const raw of rawCodes) {
        const normalized = normalizePromoCode(raw);
        if (isImportablePromoCode(normalized)) {
          validCodes.push(normalized);
        } else {
          invalidCount++;
        }
      }
      if (invalidCount > 0 && validCodes.length === 0) {
        update({
          import_error: `All ${rawCodes.length} codes are too short. Imported codes must be at least 10 characters after normalization.`,
          import_file: null, import_preview: [], import_total: 0,
        });
        return;
      }
      const errorMsg = invalidCount > 0
        ? `${invalidCount} of ${rawCodes.length} codes rejected (too short — minimum 10 characters). ${validCodes.length} valid codes will be imported.`
        : '';
      update({
        import_file: file,
        import_preview: validCodes.slice(0, 5),
        import_total: validCodes.length,
        import_error: errorMsg,
      });
    };
    reader.readAsText(file);
  }, [update]);

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragging(false);
      const file = e.dataTransfer.files[0];
      if (file) handleFile(file);
    },
    [handleFile],
  );

  const downloadTemplate = () => {
    const csv = 'code\nABC123456789\nXYZ987654321\n';
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'promo-codes-template.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-5">
      <Card>
        <SectionTitle>Code Source</SectionTitle>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {(
            [
              { value: 'generate', label: 'Generate with Waaiio', icon: '✦', desc: 'We create unique, secure codes for you' },
              { value: 'import', label: 'Import your codes', icon: '↑', desc: 'Upload a CSV of existing codes' },
            ] as const
          ).map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => update({ code_source: opt.value })}
              className={`flex items-start gap-3 rounded-xl border-2 p-4 text-left transition ${
                state.code_source === opt.value
                  ? 'border-brand bg-brand/5 dark:bg-brand/10'
                  : 'border-gray-200 hover:border-gray-300 dark:border-gray-700'
              }`}
            >
              <span className="mt-0.5 text-lg">{opt.icon}</span>
              <div>
                <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">{opt.label}</p>
                <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">{opt.desc}</p>
              </div>
            </button>
          ))}
        </div>
      </Card>

      {state.code_source === 'generate' && (
        <Card>
          <SectionTitle>Generation Settings</SectionTitle>
          <div className="space-y-4">
            <div>
              <FieldLabel required>Number of Codes</FieldLabel>
              <Input
                type="number"
                value={state.code_count}
                onChange={(v) => update({ code_count: v === '' ? ('' as unknown as number) : Number(v) })}
                placeholder="e.g. 10000"
              />
              <p className="mt-1 text-xs text-gray-400">Min 1 — Max 50,000 per batch.</p>
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <FieldLabel>Code Length</FieldLabel>
                <Input
                  type="number"
                  value={state.code_length}
                  onChange={(v) => update({ code_length: v === '' ? ('' as unknown as number) : Number(v) })}
                  placeholder="12"
                />
                <p className="mt-1 text-xs text-gray-400">
                  Min {MIN_GENERATED_BODY_LENGTH + (state.code_prefix?.length || 0)}, max 24 (must have {MIN_GENERATED_BODY_LENGTH}+ random characters{state.code_prefix ? ` after "${state.code_prefix}" prefix` : ''})
                </p>
              </div>
              <div>
                <FieldLabel>Prefix (optional)</FieldLabel>
                <Input
                  value={state.code_prefix}
                  onChange={(v) => update({ code_prefix: v.toUpperCase().slice(0, 4) })}
                  placeholder="e.g. WIN"
                />
                <p className="mt-1 text-xs text-gray-400">Up to 4 characters — prepended to every code</p>
              </div>
            </div>

            {/* Preview */}
            <div className="rounded-lg border border-dashed border-gray-200 bg-gray-50 p-4 dark:border-gray-700 dark:bg-gray-800/50">
              <p className="mb-2 text-xs font-medium uppercase tracking-wide text-gray-400">Example codes</p>
              <div className="flex flex-wrap gap-2">
                {exampleCodes.map((code, i) => (
                  <span
                    key={i}
                    className="rounded-md bg-white px-3 py-1.5 font-mono text-sm font-medium tracking-widest text-gray-800 shadow-sm dark:bg-gray-700 dark:text-gray-200"
                  >
                    {code}
                  </span>
                ))}
              </div>
              <p className="mt-2 text-xs text-gray-400">
                Format: {state.code_prefix ? <><span className="font-medium text-brand">{state.code_prefix.toUpperCase()}</span> prefix + </> : null}
                {Math.max(6, state.code_length - state.code_prefix.length)} random characters
              </p>
            </div>
          </div>
        </Card>
      )}

      {state.code_source === 'import' && (
        <Card>
          <SectionTitle>Import Codes</SectionTitle>
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <p className="text-sm text-gray-600 dark:text-gray-400">Upload a CSV file with one code per row.</p>
              <button
                type="button"
                onClick={downloadTemplate}
                className="rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-400 dark:hover:bg-gray-800"
              >
                Download template
              </button>
            </div>

            {/* Drop zone */}
            <div
              ref={dropRef}
              onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
              onDragLeave={() => setDragging(false)}
              onDrop={onDrop}
              onClick={() => fileRef.current?.click()}
              className={`cursor-pointer rounded-xl border-2 border-dashed px-6 py-10 text-center transition ${
                dragging
                  ? 'border-brand bg-brand/5'
                  : 'border-gray-200 hover:border-gray-300 dark:border-gray-700'
              }`}
            >
              <input
                ref={fileRef}
                type="file"
                accept=".csv,text/csv"
                className="hidden"
                onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); }}
              />
              <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-gray-100 dark:bg-gray-800">
                <svg className="h-6 w-6 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
                </svg>
              </div>
              {state.import_file ? (
                <div>
                  <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">{state.import_file.name}</p>
                  <p className="mt-1 text-xs text-gray-500">{state.import_total.toLocaleString()} codes detected</p>
                </div>
              ) : (
                <div>
                  <p className="text-sm font-medium text-gray-700 dark:text-gray-300">
                    Drop your CSV here or <span className="text-brand">browse</span>
                  </p>
                  <p className="mt-1 text-xs text-gray-400">CSV file, one code per row</p>
                </div>
              )}
            </div>

            {state.import_error && (
              <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600 dark:bg-red-900/20 dark:text-red-400">
                {state.import_error}
              </p>
            )}

            {state.import_preview.length > 0 && (
              <div>
                <p className="mb-2 text-xs font-medium uppercase tracking-wide text-gray-400">Preview (first 5 codes)</p>
                <div className="space-y-1">
                  {state.import_preview.map((code, i) => (
                    <div key={i} className="flex items-center gap-2 rounded-md bg-gray-50 px-3 py-1.5 dark:bg-gray-800">
                      <span className="font-mono text-sm text-gray-800 dark:text-gray-200">{code}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </Card>
      )}
    </div>
  );
}

// ─── Step 3: Prizes ───────────────────────────────────────────────────────────

function Step3Prizes({ state, update }: { state: WizardState; update: (p: Partial<WizardState>) => void }) {
  const totalWinners = state.prizes.reduce((sum, p) => sum + (Number(p.quantity) || 0), 0);
  const totalCodes = state.code_source === 'generate' ? state.code_count : state.import_total;
  const tryAgain = Math.max(0, totalCodes - totalWinners);
  const overAllocated = totalWinners > totalCodes && totalCodes > 0;

  function addPrize() {
    update({
      prizes: [
        ...state.prizes,
        {
          _key: makeKey(),
          name: '',
          prize_type: 'cash',
          quantity: 1,
          value: '',
          currency: 'NGN',
          fulfillment_instructions: '',
        },
      ],
    });
  }

  function updatePrize(key: string, patch: Partial<PrizeTier>) {
    update({
      prizes: state.prizes.map((p) => (p._key === key ? { ...p, ...patch } : p)),
    });
  }

  function removePrize(key: string) {
    update({ prizes: state.prizes.filter((p) => p._key !== key) });
  }

  return (
    <div className="space-y-5">
      {/* Allocation Summary */}
      <Card>
        <SectionTitle>Allocation Preview</SectionTitle>
        <div className="grid grid-cols-3 gap-3">
          {[
            { label: 'Total Codes', value: totalCodes.toLocaleString(), color: 'text-gray-900 dark:text-gray-100' },
            { label: 'Winning Codes', value: totalWinners.toLocaleString(), color: 'text-brand' },
            { label: 'Try Again', value: tryAgain.toLocaleString(), color: 'text-gray-500' },
          ].map((stat) => (
            <div key={stat.label} className="rounded-lg bg-gray-50 px-3 py-3 text-center dark:bg-gray-800">
              <p className={`text-lg font-bold tabular-nums ${stat.color}`}>{stat.value}</p>
              <p className="mt-0.5 text-xs text-gray-400">{stat.label}</p>
            </div>
          ))}
        </div>
        {overAllocated && (
          <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600 dark:bg-red-900/20 dark:text-red-400">
            Winner count ({totalWinners.toLocaleString()}) exceeds total codes ({totalCodes.toLocaleString()}). Reduce prize quantities.
          </p>
        )}
        {totalCodes === 0 && (
          <p className="mt-3 text-xs text-gray-400">
            Go back to Step 2 to configure your codes — allocation preview will update automatically.
          </p>
        )}
      </Card>

      {/* Prize Tiers */}
      <div className="space-y-3">
        {state.prizes.map((prize, idx) => (
          <Card key={prize._key}>
            <div className="mb-3 flex items-center justify-between">
              <h4 className="text-sm font-semibold text-gray-800 dark:text-gray-200">Prize Tier {idx + 1}</h4>
              <button
                type="button"
                onClick={() => removePrize(prize._key)}
                className="rounded-md px-2 py-1 text-xs text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20"
              >
                Remove
              </button>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <FieldLabel required>Prize Name</FieldLabel>
                <Input
                  value={prize.name}
                  onChange={(v) => updatePrize(prize._key, { name: v })}
                  placeholder="e.g. Grand Prize"
                />
              </div>
              <div>
                <FieldLabel required>Type</FieldLabel>
                <Select
                  value={prize.prize_type}
                  onChange={(v) => updatePrize(prize._key, { prize_type: v })}
                  options={PRIZE_TYPES}
                />
              </div>
              <div>
                <FieldLabel required>Quantity (winners)</FieldLabel>
                <Input
                  type="number"
                  value={prize.quantity}
                  onChange={(v) => updatePrize(prize._key, { quantity: v === '' ? ('' as unknown as number) : Number(v) })}
                  placeholder="1"
                />
              </div>
              <div>
                <FieldLabel>Value (optional)</FieldLabel>
                <div className="flex gap-2">
                  <Input
                    type="number"
                    value={prize.value}
                    onChange={(v) => updatePrize(prize._key, { value: v })}
                    placeholder="e.g. 5000"
                    className="flex-1"
                  />
                  <select
                    value={prize.currency}
                    onChange={(e) => updatePrize(prize._key, { currency: e.target.value })}
                    className="w-24 rounded-lg border border-gray-200 bg-white px-2 py-2.5 text-sm text-gray-900 outline-none focus:border-brand dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100"
                  >
                    {CURRENCIES.map((c) => (
                      <option key={c} value={c}>{c}</option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="sm:col-span-2">
                <FieldLabel>Fulfillment Instructions (optional)</FieldLabel>
                <Textarea
                  value={prize.fulfillment_instructions}
                  onChange={(v) => updatePrize(prize._key, { fulfillment_instructions: v })}
                  placeholder="Internal notes on how to deliver this prize to winners..."
                  rows={2}
                />
              </div>
            </div>
          </Card>
        ))}

        <button
          type="button"
          onClick={addPrize}
          className="flex w-full items-center justify-center gap-2 rounded-xl border-2 border-dashed border-gray-200 px-4 py-4 text-sm font-medium text-gray-500 transition hover:border-brand hover:text-brand dark:border-gray-700 dark:text-gray-400"
        >
          <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          Add Prize Tier
        </button>

        {state.prizes.length === 0 && (
          <p className="text-center text-xs text-gray-400">
            No prizes added — all codes will result in &quot;try again&quot;.
          </p>
        )}
      </div>
    </div>
  );
}

// ─── Step 4: WhatsApp ─────────────────────────────────────────────────────────

function WhatsAppBubble({ message }: { message: string }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[80%] rounded-2xl rounded-br-sm bg-[#25D366] px-4 py-3 shadow-sm">
        <p className="whitespace-pre-wrap text-sm text-white">{message || '(message preview)'}</p>
        <p className="mt-1 text-right text-[10px] text-white/70">12:00</p>
      </div>
    </div>
  );
}

function Step4WhatsApp({ state, update }: { state: WizardState; update: (p: Partial<WizardState>) => void }) {
  const [previewMsg, setPreviewMsg] = useState<string>('winner');

  const previewText =
    previewMsg === 'winner' ? state.winner_message
      : previewMsg === 'try_again' ? state.try_again_message
      : previewMsg === 'invalid' ? state.invalid_message
      : previewMsg === 'already_used' ? state.already_used_message
      : state.expired_message;

  return (
    <div className="space-y-5">
      <Card>
        <SectionTitle>Entry Configuration</SectionTitle>
        <div className="space-y-4">
          <div>
            <FieldLabel>Keyword</FieldLabel>
            <Input
              value={state.keyword}
              onChange={(v) => update({ keyword: v.toUpperCase() })}
              placeholder="e.g. WIN"
            />
            <p className="mt-1 text-xs text-gray-400">
              Customers send this keyword to start the campaign flow. Leave blank if using bare code mode only.
            </p>
          </div>

          <div>
            <FieldLabel>Entry Mode</FieldLabel>
            <div className="space-y-2">
              {ENTRY_MODES.map((mode) => (
                <label
                  key={mode.value}
                  className={`flex cursor-pointer items-start gap-3 rounded-xl border-2 p-3 transition ${
                    state.code_entry_mode === mode.value
                      ? 'border-brand bg-brand/5 dark:bg-brand/10'
                      : 'border-gray-200 hover:border-gray-300 dark:border-gray-700'
                  }`}
                >
                  <input
                    type="radio"
                    name="entry_mode"
                    value={mode.value}
                    checked={state.code_entry_mode === mode.value}
                    onChange={() => update({ code_entry_mode: mode.value })}
                    className="mt-0.5 accent-brand"
                  />
                  <div>
                    <p className="text-sm font-medium text-gray-900 dark:text-gray-100">{mode.label}</p>
                    <p className="text-xs text-gray-500 dark:text-gray-400">{mode.description}</p>
                  </div>
                </label>
              ))}
            </div>
          </div>
        </div>
      </Card>

      <Card>
        <SectionTitle>Response Messages</SectionTitle>
        <p className="mb-4 text-xs text-gray-400">
          Available tokens: <code className="rounded bg-gray-100 px-1 dark:bg-gray-800">{'{prize_name}'}</code>{' '}
          <code className="rounded bg-gray-100 px-1 dark:bg-gray-800">{'{claim_ref}'}</code>
        </p>
        <div className="space-y-4">
          {(
            [
              { key: 'winner_message', label: 'Winner Message', field: 'winner_message' },
              { key: 'try_again_message', label: 'Try Again Message', field: 'try_again_message' },
              { key: 'invalid_message', label: 'Invalid Code Message', field: 'invalid_message' },
              { key: 'already_used_message', label: 'Already Used Message', field: 'already_used_message' },
              { key: 'expired_message', label: 'Inactive / Expired Message', field: 'expired_message' },
            ] as const
          ).map((item) => (
            <div key={item.key}>
              <FieldLabel>{item.label}</FieldLabel>
              <Textarea
                value={state[item.field]}
                onChange={(v) => update({ [item.field]: v })}
                rows={3}
              />
            </div>
          ))}
        </div>
      </Card>

      {/* WhatsApp Preview */}
      <Card>
        <SectionTitle>Message Preview</SectionTitle>
        <div className="mb-3 flex flex-wrap gap-1.5">
          {(
            [
              { key: 'winner', label: 'Winner' },
              { key: 'try_again', label: 'Try Again' },
              { key: 'invalid', label: 'Invalid' },
              { key: 'already_used', label: 'Already Used' },
              { key: 'expired', label: 'Expired' },
            ] as const
          ).map((tab) => (
            <button
              key={tab.key}
              type="button"
              onClick={() => setPreviewMsg(tab.key)}
              className={`rounded-full px-3 py-1 text-xs font-medium transition ${
                previewMsg === tab.key
                  ? 'bg-brand text-white'
                  : 'bg-gray-100 text-gray-600 hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-400'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
        <div className="rounded-xl bg-[url('/whatsapp-bg.png')] bg-gray-100 p-4 dark:bg-gray-800">
          <WhatsAppBubble message={previewText} />
        </div>
      </Card>
    </div>
  );
}

// ─── Step 5: Eligibility & Fraud ──────────────────────────────────────────────

function Step5Eligibility({ state, update }: { state: WizardState; update: (p: Partial<WizardState>) => void }) {
  return (
    <div className="space-y-5">
      <Card>
        <SectionTitle>Fraud Prevention</SectionTitle>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <FieldLabel>Max attempts per phone number</FieldLabel>
            <Input
              type="number"
              value={state.max_attempts_per_phone}
              onChange={(v) => update({ max_attempts_per_phone: v === '' ? ('' as unknown as number) : Number(v) })}
              placeholder="50"
            />
            <p className="mt-1 text-xs text-gray-400">A participant will be blocked after this many total attempts.</p>
          </div>
          <div>
            <FieldLabel>Rate limit: max attempts per window</FieldLabel>
            <Input
              type="number"
              value={state.rate_limit_max_attempts}
              onChange={(v) => update({ rate_limit_max_attempts: v === '' ? ('' as unknown as number) : Number(v) })}
              placeholder="10"
            />
          </div>
          <div>
            <FieldLabel>Rate limit window (minutes)</FieldLabel>
            <Input
              type="number"
              value={state.rate_limit_window_minutes}
              onChange={(v) => update({ rate_limit_window_minutes: v === '' ? ('' as unknown as number) : Number(v) })}
              placeholder="60"
            />
            <p className="mt-1 text-xs text-gray-400">
              Default: 10 attempts per 60-minute window.
            </p>
          </div>
        </div>
      </Card>

      <Card>
        <SectionTitle>Eligibility Check</SectionTitle>
        <div className="space-y-3">
          {(
            [
              { value: 'none', label: 'None', desc: 'Anyone can participate without any eligibility check' },
              { value: 'age_confirmation', label: 'Age Confirmation', desc: 'Participant must confirm they meet the minimum age requirement' },
              { value: 'custom', label: 'Custom Prompt', desc: 'Participant must respond to a custom eligibility question' },
            ] as const
          ).map((opt) => (
            <label
              key={opt.value}
              className={`flex cursor-pointer items-start gap-3 rounded-xl border-2 p-3 transition ${
                state.eligibility_mode === opt.value
                  ? 'border-brand bg-brand/5 dark:bg-brand/10'
                  : 'border-gray-200 hover:border-gray-300 dark:border-gray-700'
              }`}
            >
              <input
                type="radio"
                name="eligibility_mode"
                value={opt.value}
                checked={state.eligibility_mode === opt.value}
                onChange={() => update({ eligibility_mode: opt.value })}
                className="mt-0.5 accent-brand"
              />
              <div>
                <p className="text-sm font-medium text-gray-900 dark:text-gray-100">{opt.label}</p>
                <p className="text-xs text-gray-500 dark:text-gray-400">{opt.desc}</p>
              </div>
            </label>
          ))}
        </div>

        {state.eligibility_mode === 'age_confirmation' && (
          <div className="mt-4 space-y-3 rounded-xl border border-gray-100 bg-gray-50 p-4 dark:border-gray-700 dark:bg-gray-800/50">
            <div>
              <FieldLabel>Minimum Age</FieldLabel>
              <Input
                type="number"
                value={state.eligibility_min_age}
                onChange={(v) => update({ eligibility_min_age: v === '' ? ('' as unknown as number) : Number(v) })}
                placeholder="18"
              />
            </div>
            <div>
              <FieldLabel>Eligibility Prompt</FieldLabel>
              <Textarea
                value={state.eligibility_prompt}
                onChange={(v) => update({ eligibility_prompt: v })}
                placeholder="e.g. Are you 18 years of age or older? Reply YES or NO."
                rows={2}
              />
            </div>
          </div>
        )}

        {state.eligibility_mode === 'custom' && (
          <div className="mt-4 rounded-xl border border-gray-100 bg-gray-50 p-4 dark:border-gray-700 dark:bg-gray-800/50">
            <FieldLabel>Custom Eligibility Prompt</FieldLabel>
            <Textarea
              value={state.eligibility_prompt}
              onChange={(v) => update({ eligibility_prompt: v })}
              placeholder="e.g. Are you a resident of Nigeria? Reply YES to continue."
              rows={3}
            />
          </div>
        )}
      </Card>
    </div>
  );
}

// ─── Step 6: Review ───────────────────────────────────────────────────────────

function ReviewRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between py-2.5 border-b border-gray-50 dark:border-gray-800 last:border-0">
      <span className="min-w-[140px] text-sm text-gray-500 dark:text-gray-400">{label}</span>
      <span className="text-right text-sm font-medium text-gray-900 dark:text-gray-100">{value || <span className="text-gray-300 dark:text-gray-600">—</span>}</span>
    </div>
  );
}

function Step6Review({
  state,
  submitting,
  submitError,
  onSubmit,
}: {
  state: WizardState;
  submitting: boolean;
  submitError: string;
  onSubmit: () => void;
}) {
  const warnings: string[] = [];
  if (!state.name.trim()) warnings.push('Campaign name is required.');
  if (!state.start_at) warnings.push('Start date is not set.');
  if (!state.end_at) warnings.push('End date is not set.');
  if (state.code_source === 'generate' && state.code_count < 1) warnings.push('Code count must be at least 1.');
  if (state.code_source === 'import' && !state.import_file) warnings.push('No CSV file selected for import.');
  const totalWinners = state.prizes.reduce((sum, p) => sum + (Number(p.quantity) || 0), 0);
  const totalCodes = state.code_source === 'generate' ? state.code_count : state.import_total;
  if (totalWinners > totalCodes && totalCodes > 0) warnings.push('Prize allocation exceeds total codes.');
  if (state.prizes.some((p) => !p.name.trim())) warnings.push('One or more prizes are missing a name.');
  if (!state.keyword && state.code_entry_mode !== 'bare_code') warnings.push('No keyword set — required for keyword or both entry modes.');

  return (
    <div className="space-y-5">
      {warnings.length > 0 && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 dark:border-amber-800 dark:bg-amber-900/20">
          <p className="mb-2 text-sm font-semibold text-amber-800 dark:text-amber-300">
            Review the following before creating:
          </p>
          <ul className="space-y-1">
            {warnings.map((w, i) => (
              <li key={i} className="flex items-center gap-2 text-sm text-amber-700 dark:text-amber-400">
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400" />
                {w}
              </li>
            ))}
          </ul>
        </div>
      )}

      <Card>
        <SectionTitle>Basics</SectionTitle>
        <ReviewRow label="Name" value={state.name} />
        <ReviewRow label="Description" value={state.description} />
        <ReviewRow label="Start" value={state.start_at ? new Date(state.start_at).toLocaleString() : null} />
        <ReviewRow label="End" value={state.end_at ? new Date(state.end_at).toLocaleString() : null} />
        <ReviewRow label="Timezone" value={state.timezone} />
      </Card>

      <Card>
        <SectionTitle>Codes</SectionTitle>
        <ReviewRow
          label="Source"
          value={state.code_source === 'generate' ? 'Generate with Waaiio' : 'Import from CSV'}
        />
        {state.code_source === 'generate' && (
          <>
            <ReviewRow label="Count" value={state.code_count.toLocaleString()} />
            <ReviewRow label="Length" value={`${state.code_length} characters`} />
            <ReviewRow label="Prefix" value={state.code_prefix || 'None'} />
          </>
        )}
        {state.code_source === 'import' && (
          <>
            <ReviewRow label="File" value={state.import_file?.name} />
            <ReviewRow label="Total codes" value={state.import_total.toLocaleString()} />
          </>
        )}
        {warnings.some((w) => w.includes('Code')) && (
          <p className="mt-2 text-xs text-amber-600 dark:text-amber-400">Note: Code generation will begin after creation.</p>
        )}
        {!warnings.length && (
          <p className="mt-2 text-xs text-gray-400">Code generation will begin after creation.</p>
        )}
      </Card>

      <Card>
        <SectionTitle>Prizes ({state.prizes.length})</SectionTitle>
        {state.prizes.length === 0 ? (
          <p className="text-sm text-gray-400">No prizes — all codes result in &quot;try again&quot;.</p>
        ) : (
          <div className="space-y-2">
            {state.prizes.map((p, i) => (
              <div key={p._key} className="flex items-center justify-between rounded-lg bg-gray-50 px-3 py-2 dark:bg-gray-800">
                <div>
                  <span className="text-sm font-medium text-gray-900 dark:text-gray-100">{p.name || `Prize ${i + 1}`}</span>
                  <span className="ml-2 text-xs text-gray-400">{PRIZE_TYPES.find((t) => t.value === p.prize_type)?.label}</span>
                </div>
                <div className="text-right">
                  <span className="text-sm font-medium text-gray-900 dark:text-gray-100">{Number(p.quantity).toLocaleString()} winners</span>
                  {p.value && (
                    <span className="ml-1 text-xs text-gray-400">@ {p.currency} {p.value}</span>
                  )}
                </div>
              </div>
            ))}
            <div className="flex items-center justify-between rounded-lg border border-dashed border-gray-200 px-3 py-2 dark:border-gray-700">
              <span className="text-sm text-gray-500">Try Again</span>
              <span className="text-sm font-medium text-gray-500">
                {Math.max(0, totalCodes - totalWinners).toLocaleString()}
              </span>
            </div>
          </div>
        )}
      </Card>

      <Card>
        <SectionTitle>WhatsApp</SectionTitle>
        <ReviewRow label="Keyword" value={state.keyword || 'None'} />
        <ReviewRow label="Entry Mode" value={ENTRY_MODES.find((m) => m.value === state.code_entry_mode)?.label} />
      </Card>

      <Card>
        <SectionTitle>Eligibility &amp; Fraud</SectionTitle>
        <ReviewRow label="Max attempts / phone" value={state.max_attempts_per_phone.toString()} />
        <ReviewRow label="Rate limit" value={`${state.rate_limit_max_attempts} per ${state.rate_limit_window_minutes} min`} />
        <ReviewRow
          label="Eligibility"
          value={
            state.eligibility_mode === 'none' ? 'None' :
            state.eligibility_mode === 'age_confirmation' ? `Age ${state.eligibility_min_age}+` :
            'Custom prompt'
          }
        />
      </Card>

      {submitError && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-900/20 dark:text-red-400">
          {submitError}
        </div>
      )}

      <button
        type="button"
        onClick={onSubmit}
        disabled={submitting || warnings.some((w) => w.includes('required') || w.includes('exceeds') || w.includes('No CSV'))}
        className="w-full rounded-xl bg-brand py-3.5 text-sm font-semibold text-white transition hover:bg-brand-600 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {submitting ? (
          <span className="flex items-center justify-center gap-2">
            <svg className="h-4 w-4 animate-spin" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
            </svg>
            Creating campaign...
          </span>
        ) : (
          'Create Campaign'
        )}
      </button>
      <p className="text-center text-xs text-gray-400">
        Code generation is started from the campaign detail page after creation.
      </p>
    </div>
  );
}

// ─── Step Indicator ───────────────────────────────────────────────────────────

function StepIndicator({ current, total, labels }: { current: number; total: number; labels: string[] }) {
  return (
    <div className="mb-8">
      {/* Desktop: numbered steps */}
      <ol className="hidden items-center sm:flex">
        {labels.map((label, i) => {
          const step = i + 1;
          const done = step < current;
          const active = step === current;
          return (
            <li key={label} className="flex flex-1 items-center last:flex-none">
              <div className="flex flex-col items-center">
                <div
                  className={`flex h-8 w-8 items-center justify-center rounded-full border-2 text-xs font-bold transition ${
                    done
                      ? 'border-brand bg-brand text-white'
                      : active
                      ? 'border-brand bg-brand/10 text-brand'
                      : 'border-gray-200 bg-white text-gray-400 dark:border-gray-700 dark:bg-gray-900'
                  }`}
                >
                  {done ? (
                    <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                    </svg>
                  ) : step}
                </div>
                <span
                  className={`mt-1.5 hidden whitespace-nowrap text-xs font-medium lg:block ${
                    active ? 'text-brand' : done ? 'text-gray-500' : 'text-gray-400'
                  }`}
                >
                  {label}
                </span>
              </div>
              {i < total - 1 && (
                <div
                  className={`mx-2 h-0.5 flex-1 rounded transition ${
                    done ? 'bg-brand' : 'bg-gray-200 dark:bg-gray-700'
                  }`}
                />
              )}
            </li>
          );
        })}
      </ol>

      {/* Mobile: progress bar */}
      <div className="sm:hidden">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-sm font-semibold text-gray-900 dark:text-gray-100">
            Step {current} of {total}: {labels[current - 1]}
          </span>
          <span className="text-xs text-gray-400">{Math.round(((current - 1) / (total - 1)) * 100)}%</span>
        </div>
        <div className="h-1.5 overflow-hidden rounded-full bg-gray-100 dark:bg-gray-800">
          <div
            className="h-full rounded-full bg-brand transition-all duration-300"
            style={{ width: `${((current - 1) / (total - 1)) * 100}%` }}
          />
        </div>
      </div>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

const INITIAL_STATE: WizardState = {
  name: '',
  description: '',
  start_at: '',
  end_at: '',
  timezone: 'Africa/Lagos',
  code_source: 'generate',
  code_count: 10_000,
  code_length: 12,
  code_prefix: '',
  import_file: null,
  import_preview: [],
  import_error: '',
  import_total: 0,
  prizes: [],
  keyword: '',
  code_entry_mode: 'keyword',
  accept_bare_codes: false,
  winner_message: DEFAULT_WINNER_MESSAGE,
  try_again_message: DEFAULT_TRY_AGAIN_MESSAGE,
  invalid_message: DEFAULT_INVALID_MESSAGE,
  already_used_message: DEFAULT_ALREADY_USED_MESSAGE,
  expired_message: DEFAULT_EXPIRED_MESSAGE,
  max_attempts_per_phone: 50,
  rate_limit_max_attempts: 10,
  rate_limit_window_minutes: 60,
  eligibility_mode: 'none',
  eligibility_min_age: 18,
  eligibility_prompt: '',
};

function validateStep(step: number, state: WizardState): string[] {
  const errors: string[] = [];
  if (step === 1) {
    if (!state.name.trim()) errors.push('Campaign name is required.');
    if (state.start_at && state.end_at && state.end_at <= state.start_at) {
      errors.push('End date must be after start date.');
    }
  }
  if (step === 2) {
    if (state.code_source === 'generate') {
      const count = Number(state.code_count);
      if (!count || count < 1 || !Number.isInteger(count)) errors.push('Code count must be a positive integer.');
      else if (count > 50_000) errors.push('Code count must be at most 50,000.');
      const len = Number(state.code_length);
      if (!len || !Number.isInteger(len)) {
        errors.push('Code length is required.');
      } else if (len > 24) {
        errors.push('Code length must be at most 24.');
      } else {
        const entropyCheck = validateGeneratedEntropy(len, state.code_prefix || null);
        if (!entropyCheck.valid) errors.push(entropyCheck.error!);
      }
    } else {
      if (!state.import_file) errors.push('Please upload a CSV file.');
      if (state.import_error) errors.push(state.import_error);
    }
  }
  if (step === 3) {
    const totalWinners = state.prizes.reduce((sum, p) => sum + (Number(p.quantity) || 0), 0);
    const totalCodes = state.code_source === 'generate' ? Number(state.code_count) : state.import_total;
    if (totalWinners > totalCodes && totalCodes > 0) {
      errors.push('Prize allocation exceeds total codes.');
    }
    if (state.prizes.some((p) => !p.name.trim())) errors.push('All prizes require a name.');
    if (state.prizes.some((p) => !Number(p.quantity) || Number(p.quantity) < 1)) errors.push('Each prize must have a quantity of at least 1.');
  }
  if (step === 5) {
    const phone = Number(state.max_attempts_per_phone);
    if (!phone || phone < 1 || !Number.isInteger(phone)) errors.push('Max attempts per phone must be a positive integer.');
    const rlMax = Number(state.rate_limit_max_attempts);
    if (!rlMax || rlMax < 1 || !Number.isInteger(rlMax)) errors.push('Rate limit max attempts must be a positive integer.');
    const rlWin = Number(state.rate_limit_window_minutes);
    if (!rlWin || rlWin < 1 || !Number.isInteger(rlWin)) errors.push('Rate limit window must be a positive integer.');
    if (state.eligibility_mode !== 'none' && state.eligibility_min_age !== null) {
      const age = Number(state.eligibility_min_age);
      if (age !== 0 && (!age || age < 1)) errors.push('Minimum age must be a positive number.');
    }
  }
  return errors;
}

export default function CreatePromotionPage() {
  const business = useBusiness();
  const router = useRouter();
  const [step, setStep] = useState(1);
  const [state, setState] = useState<WizardState>(INITIAL_STATE);
  const [stepErrors, setStepErrors] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const isDirtyRef = useRef(false);

  // Track dirty state for beforeunload warning
  useEffect(() => {
    const hasData = state.name.trim() || state.prizes.length > 0 || state.import_file !== null;
    isDirtyRef.current = !!hasData;
  }, [state]);

  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (isDirtyRef.current) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, []);

  const update = useCallback((patch: Partial<WizardState>) => {
    setState((prev) => ({ ...prev, ...patch }));
  }, []);

  function goNext() {
    const errors = validateStep(step, state);
    if (errors.length > 0) {
      setStepErrors(errors);
      return;
    }
    setStepErrors([]);
    setStep((s) => Math.min(6, s + 1));
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function goBack() {
    setStepErrors([]);
    setStep((s) => Math.max(1, s - 1));
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  async function handleSubmit() {
    setSubmitting(true);
    setSubmitError('');

    try {
      const supabase = createClient();
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated. Please sign in again.');

      const payload = {
        business_id: business.id,
        name: state.name.trim(),
        description: state.description.trim() || null,
        status: 'draft',
        start_at: state.start_at || null,
        end_at: state.end_at || null,
        timezone: state.timezone,
        keyword: state.keyword.trim() || null,
        code_entry_mode: state.code_entry_mode,
        accept_bare_codes: state.code_entry_mode === 'bare_code' || state.code_entry_mode === 'both',
        code_length: state.code_length,
        code_prefix: state.code_prefix.trim() || null,
        max_attempts_per_phone: state.max_attempts_per_phone,
        rate_limit_window_minutes: state.rate_limit_window_minutes,
        rate_limit_max_attempts: state.rate_limit_max_attempts,
        eligibility_mode: state.eligibility_mode,
        eligibility_prompt: state.eligibility_prompt.trim() || null,
        eligibility_min_age: state.eligibility_mode === 'age_confirmation' ? state.eligibility_min_age : null,
        winner_message: state.winner_message,
        try_again_message: state.try_again_message,
        invalid_message: state.invalid_message,
        already_used_message: state.already_used_message,
        expired_message: state.expired_message,
        created_by: user.id,
      };

      const prizes = state.prizes.map((p, i) => ({
        name: p.name.trim(),
        prize_type: p.prize_type,
        quantity: Number(p.quantity),
        value: p.value ? Number(p.value) : null,
        currency: p.value ? p.currency : null,
        fulfillment_instructions: p.fulfillment_instructions.trim() || null,
        sort_order: i,
      }));

      const codeConfig =
        state.code_source === 'generate'
          ? { source: 'generated' as const, count: state.code_count }
          : { source: 'imported' as const, count: state.import_total };

      const res = await fetch('/api/promotions/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ campaign: payload, prizes, code_config: codeConfig }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `Server error (${res.status})`);
      }

      const data = await res.json();
      isDirtyRef.current = false;

      // If import mode, upload the CSV file using the campaign ID
      if (state.code_source === 'import' && state.import_file && data.id) {
        try {
          const importRes = await fetch('/api/promotions/import-codes', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              businessId: business.id,
              campaignId: data.id,
              csvText: await state.import_file.text(),
            }),
          });
          if (!importRes.ok) {
            const importData = await importRes.json().catch(() => ({}));
            // Campaign created but import failed — show recoverable error
            router.push(`/dashboard/promotions/${data.id}`);
            alert(`Campaign created, but code import failed: ${importData.error || 'Unknown error'}. You can retry the import from the campaign detail page.`);
            return;
          }
        } catch {
          // Import failed — campaign exists, user can retry from detail page
          router.push(`/dashboard/promotions/${data.id}`);
          alert('Campaign created, but code import failed. You can retry from the campaign detail page.');
          return;
        }
      }

      router.push(`/dashboard/promotions/${data.id}`);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Something went wrong. Please try again.');
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-auto max-w-2xl">
      {/* Page header */}
      <div className="mb-6 flex items-center gap-3">
        <button
          type="button"
          onClick={() => router.back()}
          className="rounded-lg p-2 text-gray-400 transition hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-800"
        >
          <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
        </button>
        <div>
          <h1 className="text-xl font-bold text-gray-900 dark:text-gray-100">New Instant Win Campaign</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400">Configure your WhatsApp instant win campaign</p>
        </div>
      </div>

      {/* Step indicator */}
      <StepIndicator current={step} total={STEP_LABELS.length} labels={STEP_LABELS} />

      {/* Step content */}
      <div>
        {step === 1 && <Step1Basics state={state} update={update} />}
        {step === 2 && <Step2Codes state={state} update={update} />}
        {step === 3 && <Step3Prizes state={state} update={update} />}
        {step === 4 && <Step4WhatsApp state={state} update={update} />}
        {step === 5 && <Step5Eligibility state={state} update={update} />}
        {step === 6 && (
          <Step6Review
            state={state}
            submitting={submitting}
            submitError={submitError}
            onSubmit={handleSubmit}
          />
        )}
      </div>

      {/* Step validation errors */}
      {stepErrors.length > 0 && (
        <div className="mt-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 dark:border-red-800 dark:bg-red-900/20">
          <ul className="space-y-1">
            {stepErrors.map((e, i) => (
              <li key={i} className="flex items-center gap-2 text-sm text-red-700 dark:text-red-400">
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-red-400" />
                {e}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Navigation footer */}
      {step < 6 && (
        <div className="mt-6 flex items-center justify-between border-t border-gray-100 pt-5 dark:border-gray-800">
          <button
            type="button"
            onClick={goBack}
            disabled={step === 1}
            className="rounded-lg border border-gray-200 px-5 py-2.5 text-sm font-medium text-gray-600 transition hover:bg-gray-50 disabled:opacity-30 dark:border-gray-700 dark:text-gray-400 dark:hover:bg-gray-800"
          >
            Back
          </button>
          <button
            type="button"
            onClick={goNext}
            className="rounded-lg bg-brand px-6 py-2.5 text-sm font-semibold text-white transition hover:bg-brand-600"
          >
            {step === 5 ? 'Review' : 'Next'}
          </button>
        </div>
      )}

      {step === 6 && (
        <div className="mt-6 border-t border-gray-100 pt-5 dark:border-gray-800">
          <button
            type="button"
            onClick={goBack}
            className="rounded-lg border border-gray-200 px-5 py-2.5 text-sm font-medium text-gray-600 transition hover:bg-gray-50 dark:border-gray-700 dark:text-gray-400 dark:hover:bg-gray-800"
          >
            Back
          </button>
        </div>
      )}
    </div>
  );
}
