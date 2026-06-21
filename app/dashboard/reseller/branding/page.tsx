'use client';

import { useEffect, useState, useCallback } from 'react';
import { PageHelp } from '@/components/dashboard/PageHelp';

interface BrandingData {
  branding: {
    logo_url: string | null;
    favicon_url: string | null;
    primary_color: string | null;
    accent_color: string | null;
  };
  company_name: string;
  custom_domain: string | null;
}

export default function ResellerBrandingPage() {
  const [data, setData] = useState<BrandingData | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  // Form state
  const [logoUrl, setLogoUrl] = useState('');
  const [faviconUrl, setFaviconUrl] = useState('');
  const [primaryColor, setPrimaryColor] = useState('#6C2BD9');
  const [accentColor, setAccentColor] = useState('#F59E0B');
  const [companyName, setCompanyName] = useState('');

  const loadBranding = useCallback(async () => {
    try {
      setError(null);
      const res = await fetch('/api/reseller/branding');
      if (!res.ok) {
        const json = await res.json();
        throw new Error(json.error || 'Failed to load branding');
      }
      const json: BrandingData = await res.json();
      setData(json);
      setLogoUrl(json.branding.logo_url || '');
      setFaviconUrl(json.branding.favicon_url || '');
      setPrimaryColor(json.branding.primary_color || '#6C2BD9');
      setAccentColor(json.branding.accent_color || '#F59E0B');
      setCompanyName(json.company_name || '');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load branding');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadBranding();
  }, [loadBranding]);

  async function handleSave() {
    setSaving(true);
    setError(null);
    setSuccess(false);

    try {
      const res = await fetch('/api/reseller/branding', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          logo_url: logoUrl.trim() || null,
          favicon_url: faviconUrl.trim() || null,
          primary_color: primaryColor || null,
          accent_color: accentColor || null,
          company_name: companyName.trim(),
        }),
      });

      if (!res.ok) {
        const json = await res.json();
        throw new Error(json.error || 'Failed to save branding');
      }

      setSuccess(true);
      setTimeout(() => setSuccess(false), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save branding');
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-brand border-t-transparent" />
      </div>
    );
  }

  return (
    <div>
      <div>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Branding</h1>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          Customize the look and feel of your reseller portal for your sub-accounts
        </p>
      </div>

      <PageHelp
        pageKey="reseller-branding"
        title="Reseller Branding"
        description="Upload your logo, set brand colors, and configure your company identity. These settings apply to your reseller portal and sub-account dashboards."
      />

      {error && (
        <div className="mt-4 rounded-lg border border-red-200 bg-red-50 dark:bg-red-900/20 dark:border-red-800 px-4 py-3 text-sm text-red-700 dark:text-red-400">
          {error}
        </div>
      )}

      {success && (
        <div className="mt-4 rounded-lg border border-green-200 bg-green-50 dark:bg-green-900/20 dark:border-green-800 px-4 py-3 text-sm text-green-700 dark:text-green-400">
          Branding updated successfully.
        </div>
      )}

      <div className="mt-6 space-y-6">
        {/* Company Name */}
        <div className="rounded-xl border border-gray-100 dark:border-gray-700 bg-white dark:bg-gray-800 p-5">
          <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Company Name</h2>
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            The name displayed on your reseller portal
          </p>
          <input
            type="text"
            value={companyName}
            onChange={(e) => setCompanyName(e.target.value)}
            maxLength={200}
            placeholder="Your company name"
            className="mt-3 w-full rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2.5 text-sm text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
          />
        </div>

        {/* Logo & Favicon */}
        <div className="rounded-xl border border-gray-100 dark:border-gray-700 bg-white dark:bg-gray-800 p-5">
          <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Logo & Favicon</h2>
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            Provide URLs for your logo and favicon images
          </p>

          <div className="mt-4 space-y-4">
            {/* Logo URL */}
            <div>
              <label htmlFor="logo-url" className="block text-xs font-medium text-gray-700 dark:text-gray-300">
                Logo URL
              </label>
              <div className="mt-1.5 flex items-center gap-3">
                <input
                  id="logo-url"
                  type="url"
                  value={logoUrl}
                  onChange={(e) => setLogoUrl(e.target.value)}
                  maxLength={500}
                  placeholder="https://example.com/logo.png"
                  className="flex-1 rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2.5 text-sm text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
                />
                {logoUrl && /^https?:\/\/.+/.test(logoUrl) && (
                  <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg border border-gray-200 dark:border-gray-600 bg-gray-50 dark:bg-gray-700 overflow-hidden">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={logoUrl}
                      alt="Logo preview"
                      className="h-full w-full object-contain"
                      onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                    />
                  </div>
                )}
              </div>
            </div>

            {/* Favicon URL */}
            <div>
              <label htmlFor="favicon-url" className="block text-xs font-medium text-gray-700 dark:text-gray-300">
                Favicon URL
              </label>
              <div className="mt-1.5 flex items-center gap-3">
                <input
                  id="favicon-url"
                  type="url"
                  value={faviconUrl}
                  onChange={(e) => setFaviconUrl(e.target.value)}
                  maxLength={500}
                  placeholder="https://example.com/favicon.ico"
                  className="flex-1 rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2.5 text-sm text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
                />
                {faviconUrl && /^https?:\/\/.+/.test(faviconUrl) && (
                  <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg border border-gray-200 dark:border-gray-600 bg-gray-50 dark:bg-gray-700 overflow-hidden">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={faviconUrl}
                      alt="Favicon preview"
                      className="h-full w-full object-contain"
                      onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                    />
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Brand Colors */}
        <div className="rounded-xl border border-gray-100 dark:border-gray-700 bg-white dark:bg-gray-800 p-5">
          <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Brand Colors</h2>
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            Set your primary and accent colors using hex values
          </p>

          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            {/* Primary Color */}
            <div>
              <label htmlFor="primary-color" className="block text-xs font-medium text-gray-700 dark:text-gray-300">
                Primary Color
              </label>
              <div className="mt-1.5 flex items-center gap-2">
                <input
                  type="color"
                  value={primaryColor}
                  onChange={(e) => setPrimaryColor(e.target.value)}
                  className="h-10 w-10 flex-shrink-0 cursor-pointer rounded-lg border border-gray-200 dark:border-gray-600 bg-transparent p-0.5"
                  aria-label="Primary color picker"
                />
                <input
                  id="primary-color"
                  type="text"
                  value={primaryColor}
                  onChange={(e) => setPrimaryColor(e.target.value)}
                  maxLength={7}
                  placeholder="#6C2BD9"
                  className="flex-1 rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2.5 text-sm font-mono text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
                />
                <div
                  className="h-10 w-10 flex-shrink-0 rounded-lg border border-gray-200 dark:border-gray-600"
                  style={{ backgroundColor: /^#[0-9A-Fa-f]{6}$/.test(primaryColor) ? primaryColor : '#ccc' }}
                  aria-label="Primary color swatch"
                />
              </div>
            </div>

            {/* Accent Color */}
            <div>
              <label htmlFor="accent-color" className="block text-xs font-medium text-gray-700 dark:text-gray-300">
                Accent Color
              </label>
              <div className="mt-1.5 flex items-center gap-2">
                <input
                  type="color"
                  value={accentColor}
                  onChange={(e) => setAccentColor(e.target.value)}
                  className="h-10 w-10 flex-shrink-0 cursor-pointer rounded-lg border border-gray-200 dark:border-gray-600 bg-transparent p-0.5"
                  aria-label="Accent color picker"
                />
                <input
                  id="accent-color"
                  type="text"
                  value={accentColor}
                  onChange={(e) => setAccentColor(e.target.value)}
                  maxLength={7}
                  placeholder="#F59E0B"
                  className="flex-1 rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2.5 text-sm font-mono text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
                />
                <div
                  className="h-10 w-10 flex-shrink-0 rounded-lg border border-gray-200 dark:border-gray-600"
                  style={{ backgroundColor: /^#[0-9A-Fa-f]{6}$/.test(accentColor) ? accentColor : '#ccc' }}
                  aria-label="Accent color swatch"
                />
              </div>
            </div>
          </div>
        </div>

        {/* Custom Domain */}
        <div className="rounded-xl border border-gray-100 dark:border-gray-700 bg-white dark:bg-gray-800 p-5">
          <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Custom Domain</h2>
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            Use your own domain for the reseller portal
          </p>
          {data?.custom_domain ? (
            <div className="mt-3 flex items-center gap-2">
              <span className="inline-flex items-center rounded-full bg-green-50 dark:bg-green-900/20 px-3 py-1 text-sm font-medium text-green-700 dark:text-green-400">
                {data.custom_domain}
              </span>
            </div>
          ) : (
            <div className="mt-3 rounded-lg border border-dashed border-gray-200 dark:border-gray-600 bg-gray-50 dark:bg-gray-700/30 px-4 py-3">
              <p className="text-sm text-gray-500 dark:text-gray-400">
                No custom domain configured.{' '}
                <a
                  href="mailto:support@waaiio.com?subject=Custom%20Domain%20Setup"
                  className="font-medium text-brand hover:underline"
                >
                  Contact support
                </a>{' '}
                to set one up.
              </p>
            </div>
          )}
        </div>

        {/* Save Button */}
        <div className="flex justify-end">
          <button
            onClick={handleSave}
            disabled={saving || !companyName.trim()}
            className="rounded-lg bg-brand px-5 py-2.5 text-sm font-medium text-white transition hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {saving ? 'Saving...' : 'Save Branding'}
          </button>
        </div>
      </div>
    </div>
  );
}
