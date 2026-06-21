'use client';

import { useState, useEffect } from 'react';
import AnimatedSection from '@/components/marketing/AnimatedSection';

// ── Category options (mirrors reseller accounts page) ─────────────
const CATEGORY_OPTIONS = [
  { group: 'Beauty & Wellness', items: ['salon', 'barber', 'spa', 'tattoo', 'nail_tech', 'mua', 'lash_tech', 'medspa', 'waxing'] },
  { group: 'Health & Medical', items: ['clinic', 'dental', 'veterinary', 'therapy', 'optician', 'physiotherapy'] },
  { group: 'Food & Dining', items: ['restaurant', 'cafe', 'bar', 'lounge', 'bakery', 'catering', 'food_truck'] },
  { group: 'Delivery & Retail', items: ['shop', 'food_delivery', 'pharmacy', 'supermarket', 'tailor', 'printing'] },
  { group: 'Home & Auto Services', items: ['laundry', 'car_wash', 'mechanic', 'cleaning', 'plumber', 'pest_control', 'handyman', 'hvac', 'landscaping', 'electrician'] },
  { group: 'Professional Services', items: ['consultant', 'legal', 'accounting', 'travel_agency', 'coworking', 'security'] },
  { group: 'Hospitality', items: ['hotel', 'shortlet', 'car_rental'] },
  { group: 'Events & Entertainment', items: ['events', 'event_services', 'cinema', 'music_studio'] },
  { group: 'Faith & Community', items: ['church', 'mosque', 'ngo', 'crowdfunding_org'] },
  { group: 'Fitness', items: ['gym', 'yoga', 'pilates', 'dance', 'martial_arts', 'bootcamp'] },
  { group: 'Transport & Logistics', items: ['taxi', 'transport', 'logistics', 'courier', 'moving', 'bus'] },
  { group: 'Education & Training', items: ['school', 'tutor', 'driving_school', 'language_school', 'training_academy', 'daycare'] },
];

const COUNTRY_OPTIONS = [
  { value: 'US', label: 'United States' },
  { value: 'CA', label: 'Canada' },
  { value: 'NG', label: 'Nigeria' },
  { value: 'GH', label: 'Ghana' },
  { value: 'GB', label: 'United Kingdom' },
];

function formatCategory(key: string): string {
  return key
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

// ── Types ─────────────────────────────────────────────────────────
interface ResellerInfo {
  reseller_id: string;
  company_name: string;
  tier: string;
  branding: { logo_url?: string; primary_color?: string; accent_color?: string } | null;
}

interface BrandForm {
  company_name: string;
  logo_url: string;
  primary_color: string;
  accent_color: string;
}

interface AccountForm {
  name: string;
  category: string;
  email: string;
  country_code: string;
}

// ── Spinner SVG ───────────────────────────────────────────────────
function Spinner() {
  return (
    <svg aria-hidden="true" className="mr-2 h-4 w-4 animate-spin" fill="none" viewBox="0 0 24 24">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  );
}

// ── Color swatch preview ──────────────────────────────────────────
function ColorSwatch({ color }: { color: string }) {
  const isValid = /^#[0-9a-fA-F]{6}$/.test(color);
  return (
    <div
      className="mt-1 h-8 w-8 rounded-lg border border-gray-200 shadow-sm"
      style={{ backgroundColor: isValid ? color : '#e4e4e7' }}
    />
  );
}

// ── Main Component ────────────────────────────────────────────────
export default function SetupWizard({ token }: { token: string }) {
  const [step, setStep] = useState(1);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [reseller, setReseller] = useState<ResellerInfo | null>(null);

  const [brand, setBrand] = useState<BrandForm>({
    company_name: '',
    logo_url: '',
    primary_color: '#6C2BD9',
    accent_color: '#F59E0B',
  });

  const [account, setAccount] = useState<AccountForm>({
    name: '',
    category: '',
    email: '',
    country_code: 'US',
  });

  // ── Validate token on mount ─────────────────────────────────────
  useEffect(() => {
    if (!token) {
      setError('No invite token provided. Please use the link from your invitation email.');
      setLoading(false);
      return;
    }

    fetch(`/api/reseller/setup?token=${encodeURIComponent(token)}`)
      .then(async (res) => {
        if (!res.ok) {
          const data = await res.json();
          throw new Error(data.error || 'Invalid invite link');
        }
        return res.json();
      })
      .then((data: ResellerInfo) => {
        setReseller(data);
        setBrand((prev) => ({
          ...prev,
          company_name: data.company_name || '',
          logo_url: data.branding?.logo_url || '',
          primary_color: data.branding?.primary_color || '#6C2BD9',
          accent_color: data.branding?.accent_color || '#F59E0B',
        }));
      })
      .catch((err) => {
        setError((err as Error).message);
      })
      .finally(() => setLoading(false));
  }, [token]);

  // ── Submit setup ────────────────────────────────────────────────
  const handleSubmit = async (includeAccount: boolean) => {
    setSubmitting(true);
    setError('');

    try {
      const payload: Record<string, unknown> = {
        token,
        company_name: brand.company_name,
        branding: {
          logo_url: brand.logo_url || undefined,
          primary_color: brand.primary_color,
          accent_color: brand.accent_color,
        },
      };

      if (includeAccount && account.name && account.category && account.email) {
        payload.first_account = {
          name: account.name,
          category: account.category,
          email: account.email,
          country_code: account.country_code,
        };
      }

      const res = await fetch('/api/reseller/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Setup failed');
      }

      setStep(3);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  // ── Shared style classes ────────────────────────────────────────
  const inputCls =
    'mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm shadow-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand';
  const labelCls = 'block text-sm font-medium text-gray-700';
  const req = <span className="text-red-500">*</span>;

  // ── Loading state ───────────────────────────────────────────────
  if (loading) {
    return (
      <section className="relative overflow-hidden py-24">
        <div className="absolute inset-0 bg-gradient-to-br from-brand/10 via-transparent to-accent/10" />
        <div className="relative mx-auto flex max-w-lg items-center justify-center px-6">
          <div className="flex items-center gap-3 text-gray-500">
            <Spinner />
            <span className="text-sm">Validating your invite...</span>
          </div>
        </div>
      </section>
    );
  }

  // ── Error state (invalid/missing token) ─────────────────────────
  if (error && !reseller) {
    return (
      <section className="relative overflow-hidden py-24">
        <div className="absolute inset-0 bg-gradient-to-br from-brand/10 via-transparent to-accent/10" />
        <div className="relative mx-auto max-w-lg px-6">
          <AnimatedSection>
            <div className="rounded-2xl border border-red-200 bg-white p-8 text-center shadow-xl">
              <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-red-100">
                <svg className="h-6 w-6 text-red-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </div>
              <h2 className="mt-4 text-lg font-semibold text-gray-900">Invalid Invite</h2>
              <p className="mt-2 text-sm text-gray-600">{error}</p>
              <a
                href="/"
                className="mt-6 inline-block rounded-xl bg-brand px-6 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-brand/90"
              >
                Go to Homepage
              </a>
            </div>
          </AnimatedSection>
        </div>
      </section>
    );
  }

  // ── Progress indicator ──────────────────────────────────────────
  const steps = ['Your Brand', 'First Account', 'All Set'];

  return (
    <section className="relative overflow-hidden py-16 sm:py-24">
      {/* Background gradient */}
      <div className="absolute inset-0 bg-gradient-to-br from-brand/10 via-transparent to-accent/10" />

      <div className="relative mx-auto max-w-xl px-6">
        {/* Hero heading */}
        <AnimatedSection>
          <div className="mb-10 text-center">
            <span className="mb-3 inline-block rounded-full bg-brand/10 px-4 py-1.5 text-xs font-semibold uppercase tracking-wider text-brand">
              Partner Program
            </span>
            <h1 className="text-3xl font-extrabold tracking-tight text-gray-900 sm:text-4xl">
              Welcome to Waaiio
            </h1>
            <p className="mt-3 text-base text-gray-600">
              Let&apos;s get your reseller account set up in just a few steps.
            </p>
          </div>
        </AnimatedSection>

        {/* Step indicator */}
        <AnimatedSection delay={0.1}>
          <div className="mb-8 flex items-center justify-center gap-2">
            {steps.map((label, i) => {
              const stepNum = i + 1;
              const isActive = step === stepNum;
              const isCompleted = step > stepNum;
              return (
                <div key={label} className="flex items-center gap-2">
                  {i > 0 && (
                    <div
                      className={`h-px w-8 ${isCompleted ? 'bg-brand' : 'bg-gray-200'}`}
                    />
                  )}
                  <div className="flex items-center gap-1.5">
                    <div
                      className={`flex h-7 w-7 items-center justify-center rounded-full text-xs font-bold ${
                        isActive
                          ? 'bg-brand text-white'
                          : isCompleted
                            ? 'bg-brand/20 text-brand'
                            : 'bg-gray-100 text-gray-400'
                      }`}
                    >
                      {isCompleted ? (
                        <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                        </svg>
                      ) : (
                        stepNum
                      )}
                    </div>
                    <span
                      className={`hidden text-xs font-medium sm:inline ${
                        isActive ? 'text-gray-900' : 'text-gray-400'
                      }`}
                    >
                      {label}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </AnimatedSection>

        {/* Card */}
        <AnimatedSection delay={0.15}>
          <div className="rounded-2xl border border-gray-100 bg-white p-6 shadow-xl sm:p-8">
            {/* ── Step 1: Your Brand ─────────────────────────────── */}
            {step === 1 && (
              <div className="space-y-5">
                <div>
                  <h2 className="text-xl font-bold text-gray-900">Your Brand</h2>
                  <p className="mt-1 text-sm text-gray-500">
                    Customize how your partner portal looks to your clients.
                  </p>
                </div>

                <div>
                  <label htmlFor="rs-company" className={labelCls}>
                    Company Name {req}
                  </label>
                  <input
                    id="rs-company"
                    type="text"
                    required
                    maxLength={200}
                    value={brand.company_name}
                    onChange={(e) => setBrand((f) => ({ ...f, company_name: e.target.value }))}
                    className={inputCls}
                    placeholder="Your Company Name"
                  />
                </div>

                <div>
                  <label htmlFor="rs-logo" className={labelCls}>
                    Logo URL
                  </label>
                  <input
                    id="rs-logo"
                    type="url"
                    maxLength={500}
                    value={brand.logo_url}
                    onChange={(e) => setBrand((f) => ({ ...f, logo_url: e.target.value }))}
                    className={inputCls}
                    placeholder="https://example.com/logo.png"
                  />
                  {brand.logo_url && (
                    <div className="mt-3 flex items-center gap-3 rounded-lg border border-gray-100 bg-gray-50 p-3">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={brand.logo_url}
                        alt="Logo preview"
                        className="h-10 w-10 rounded-lg object-contain"
                        onError={(e) => {
                          (e.target as HTMLImageElement).style.display = 'none';
                        }}
                      />
                      <span className="text-xs text-gray-500">Logo preview</span>
                    </div>
                  )}
                </div>

                <div className="grid gap-5 sm:grid-cols-2">
                  <div>
                    <label htmlFor="rs-primary" className={labelCls}>
                      Primary Color
                    </label>
                    <div className="flex items-center gap-3">
                      <input
                        id="rs-primary"
                        type="text"
                        maxLength={7}
                        value={brand.primary_color}
                        onChange={(e) => setBrand((f) => ({ ...f, primary_color: e.target.value }))}
                        className={inputCls}
                        placeholder="#6C2BD9"
                      />
                      <ColorSwatch color={brand.primary_color} />
                    </div>
                  </div>
                  <div>
                    <label htmlFor="rs-accent" className={labelCls}>
                      Accent Color
                    </label>
                    <div className="flex items-center gap-3">
                      <input
                        id="rs-accent"
                        type="text"
                        maxLength={7}
                        value={brand.accent_color}
                        onChange={(e) => setBrand((f) => ({ ...f, accent_color: e.target.value }))}
                        className={inputCls}
                        placeholder="#F59E0B"
                      />
                      <ColorSwatch color={brand.accent_color} />
                    </div>
                  </div>
                </div>

                {error && <p className="text-sm text-red-600">{error}</p>}

                <div className="flex justify-end pt-2">
                  <button
                    type="button"
                    disabled={!brand.company_name.trim()}
                    onClick={() => {
                      setError('');
                      setStep(2);
                    }}
                    className="inline-flex items-center rounded-xl bg-brand px-8 py-3 text-sm font-bold text-white shadow-lg shadow-brand/20 transition hover:bg-brand/90 focus:outline-none focus:ring-2 focus:ring-brand focus:ring-offset-2 disabled:opacity-50"
                  >
                    Continue
                  </button>
                </div>
              </div>
            )}

            {/* ── Step 2: Add Your First Account ─────────────────── */}
            {step === 2 && (
              <div className="space-y-5">
                <div>
                  <h2 className="text-xl font-bold text-gray-900">Add Your First Account</h2>
                  <p className="mt-1 text-sm text-gray-500">
                    Create a client account now, or skip and add one later from your dashboard.
                  </p>
                </div>

                <div>
                  <label htmlFor="rs-biz-name" className={labelCls}>
                    Business Name
                  </label>
                  <input
                    id="rs-biz-name"
                    type="text"
                    maxLength={200}
                    value={account.name}
                    onChange={(e) => setAccount((f) => ({ ...f, name: e.target.value }))}
                    className={inputCls}
                    placeholder="Client Business Name"
                  />
                </div>

                <div>
                  <label htmlFor="rs-biz-cat" className={labelCls}>
                    Category
                  </label>
                  <select
                    id="rs-biz-cat"
                    value={account.category}
                    onChange={(e) => setAccount((f) => ({ ...f, category: e.target.value }))}
                    className={inputCls}
                  >
                    <option value="">Select category</option>
                    {CATEGORY_OPTIONS.map((group) => (
                      <optgroup key={group.group} label={group.group}>
                        {group.items.map((item) => (
                          <option key={item} value={item}>
                            {formatCategory(item)}
                          </option>
                        ))}
                      </optgroup>
                    ))}
                  </select>
                </div>

                <div className="grid gap-5 sm:grid-cols-2">
                  <div>
                    <label htmlFor="rs-biz-email" className={labelCls}>
                      Email
                    </label>
                    <input
                      id="rs-biz-email"
                      type="email"
                      maxLength={254}
                      value={account.email}
                      onChange={(e) => setAccount((f) => ({ ...f, email: e.target.value }))}
                      className={inputCls}
                      placeholder="client@example.com"
                    />
                  </div>
                  <div>
                    <label htmlFor="rs-biz-country" className={labelCls}>
                      Country
                    </label>
                    <select
                      id="rs-biz-country"
                      value={account.country_code}
                      onChange={(e) => setAccount((f) => ({ ...f, country_code: e.target.value }))}
                      className={inputCls}
                    >
                      {COUNTRY_OPTIONS.map((c) => (
                        <option key={c.value} value={c.value}>
                          {c.label}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                {error && <p className="text-sm text-red-600">{error}</p>}

                <div className="flex items-center justify-between gap-3 pt-2">
                  <button
                    type="button"
                    onClick={() => {
                      setError('');
                      setStep(1);
                    }}
                    className="text-sm font-medium text-gray-500 hover:text-gray-700"
                  >
                    Back
                  </button>
                  <div className="flex gap-3">
                    <button
                      type="button"
                      disabled={submitting}
                      onClick={() => handleSubmit(false)}
                      className="rounded-xl border border-gray-200 bg-white px-6 py-3 text-sm font-semibold text-gray-700 shadow-sm transition hover:bg-gray-50 disabled:opacity-50"
                    >
                      {submitting ? <Spinner /> : 'Skip'}
                    </button>
                    <button
                      type="button"
                      disabled={submitting || !account.name || !account.category || !account.email}
                      onClick={() => handleSubmit(true)}
                      className="inline-flex items-center rounded-xl bg-brand px-8 py-3 text-sm font-bold text-white shadow-lg shadow-brand/20 transition hover:bg-brand/90 focus:outline-none focus:ring-2 focus:ring-brand focus:ring-offset-2 disabled:opacity-50"
                    >
                      {submitting && <Spinner />}
                      Create Account
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* ── Step 3: All Set ─────────────────────────────────── */}
            {step === 3 && (
              <div className="py-4 text-center">
                <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-green-100">
                  <svg className="h-8 w-8 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                </div>
                <h2 className="mt-5 text-2xl font-bold text-gray-900">You&apos;re All Set!</h2>
                <p className="mt-2 text-sm text-gray-600">
                  Your partner account is ready. Log in to your dashboard to manage accounts,
                  track commissions, and grow your business.
                </p>
                <a
                  href="/login"
                  className="mt-8 inline-flex items-center rounded-xl bg-accent px-8 py-3 text-base font-bold text-gray-900 shadow-lg shadow-accent/20 transition hover:bg-accent-400 focus:outline-none focus:ring-2 focus:ring-accent focus:ring-offset-2"
                >
                  Go to Dashboard
                </a>
              </div>
            )}
          </div>
        </AnimatedSection>
      </div>
    </section>
  );
}
