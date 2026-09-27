import { useEffect, useMemo, useState } from 'react';
import { adminDb } from '@/lib/supabase';
import { useAdminSession } from '@/components/AdminLayout';
import { logAudit } from '@/lib/auditLog';
import { getAdminApiBase } from '@/lib/adminApi';
import {
  EMPTY_SITE_ANNOUNCEMENT,
  SITE_ANNOUNCEMENT_EXPIRY_POLICY,
  getBrowserTimeZone,
  localDateTimeInputToIso,
  resolveSiteAnnouncementCtaUrl,
  toLocalDateTimeInputValue,
  validateSiteAnnouncementConfig,
  type SiteAnnouncementConfig,
  type SiteAnnouncementStyle,
  type SiteAnnouncementType,
} from '@shared/site-announcement';
import { WhatsAppLinkGenerator } from '@/components/WhatsAppLinkGenerator';
import { Clock3, ExternalLink, Eye, EyeOff, Megaphone, Save } from 'lucide-react';

const TYPES: Array<{ value: SiteAnnouncementType; label: string }> = [
  { value: 'launch_countdown', label: 'Launch Countdown' },
  { value: 'maintenance_notice', label: 'Maintenance Notice' },
  { value: 'general', label: 'General Announcement' },
];

const STYLES: Array<{ value: SiteAnnouncementStyle; label: string }> = [
  { value: 'brand', label: 'Brand (Purple)' },
  { value: 'warning', label: 'Warning (Amber)' },
  { value: 'info', label: 'Info (Blue)' },
];

const PREVIEW_STYLE_CLASSES: Record<SiteAnnouncementStyle, { bg: string; text: string; cta: string }> = {
  brand: { bg: 'bg-violet-950', text: 'text-white', cta: 'bg-white text-violet-900' },
  warning: { bg: 'bg-amber-600', text: 'text-white', cta: 'bg-white text-amber-700' },
  info: { bg: 'bg-blue-600', text: 'text-white', cta: 'bg-white text-blue-700' },
};

interface TimeLeft {
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
}

function computeTimeLeft(target: string | null): TimeLeft | null {
  if (!target) return null;
  const diff = new Date(target).getTime() - Date.now();
  if (!Number.isFinite(diff) || diff <= 0) return null;
  return {
    days: Math.floor(diff / 86_400_000),
    hours: Math.floor((diff / 3_600_000) % 24),
    minutes: Math.floor((diff / 60_000) % 60),
    seconds: Math.floor((diff / 1_000) % 60),
  };
}

function AnnouncementPreview({ config }: { config: SiteAnnouncementConfig }) {
  const [timeLeft, setTimeLeft] = useState<TimeLeft | null>(() => computeTimeLeft(config.target_date));

  useEffect(() => {
    if (config.type !== 'launch_countdown' || !config.target_date) {
      setTimeLeft(null);
      return;
    }
    const tick = () => setTimeLeft(computeTimeLeft(config.target_date));
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [config.target_date, config.type]);

  const styles = PREVIEW_STYLE_CLASSES[config.style] || PREVIEW_STYLE_CLASSES.brand;
  const targetReached = config.type === 'launch_countdown'
    && !!config.target_date
    && new Date(config.target_date).getTime() <= Date.now();

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-gray-800">Preview before live</h2>
        <span className="rounded-full bg-gray-100 px-2.5 py-1 text-[11px] font-semibold text-gray-600">
          {config.enabled ? 'Current draft of live banner' : 'Draft preview — not live'}
        </span>
      </div>

      <div className={`rounded-2xl px-4 py-4 ${styles.bg} ${styles.text}`}>
        <div className="flex flex-col items-center gap-3 text-center lg:flex-row lg:justify-center">
          <div className="min-w-0 flex-1">
            <p className="text-sm font-bold sm:text-base">
              {config.headline.trim() || 'Your announcement headline will appear here'}
            </p>
            {config.message.trim() && (
              <p className="mt-1 text-xs opacity-90 sm:text-sm">{config.message}</p>
            )}
          </div>

          {config.type === 'launch_countdown' && timeLeft && (
            <div className="flex gap-2">
              {[
                { value: timeLeft.days, label: 'D' },
                { value: timeLeft.hours, label: 'H' },
                { value: timeLeft.minutes, label: 'M' },
                { value: timeLeft.seconds, label: 'S' },
              ].map(({ value, label }) => (
                <div key={label} className="min-w-[38px] rounded-lg bg-white/15 px-2 py-1.5">
                  <div className="text-base font-bold tabular-nums">{String(value).padStart(2, '0')}</div>
                  <div className="text-[9px] uppercase opacity-75">{label}</div>
                </div>
              ))}
            </div>
          )}

          {config.type === 'launch_countdown' && !timeLeft && (
            <div className="rounded-lg bg-white/15 px-3 py-2 text-xs font-semibold">
              {targetReached ? 'Countdown complete' : 'Set a future target to preview countdown'}
            </div>
          )}

          {config.cta_text && config.cta_link && (
            <span className={`shrink-0 rounded-lg px-4 py-2 text-xs font-bold ${styles.cta}`}>
              {config.cta_text}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

export default function SiteAnnouncementPage() {
  const session = useAdminSession();
  const [config, setConfig] = useState<SiteAnnouncementConfig>(EMPTY_SITE_ANNOUNCEMENT);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const browserTimeZone = useMemo(() => getBrowserTimeZone(), []);

  useEffect(() => {
    (async () => {
      const { data } = await adminDb
        .from('platform_settings')
        .select('value')
        .eq('key', 'site_announcement')
        .single();
      if (data?.value) {
        setConfig({
          ...EMPTY_SITE_ANNOUNCEMENT,
          ...(data.value as Partial<SiteAnnouncementConfig>),
        });
      }
      setLoading(false);
    })();
  }, []);

  function validationError(next: SiteAnnouncementConfig): string | null {
    const errors = validateSiteAnnouncementConfig(next);
    return errors[0] || null;
  }

  async function persist(next: SiteAnnouncementConfig) {
    return adminDb
      .from('platform_settings')
      .update({
        value: next,
        updated_by: session?.userId ?? null,
        updated_at: new Date().toISOString(),
      })
      .eq('key', 'site_announcement');
  }

  async function handleSave() {
    setError(null);
    setSaved(false);

    const validation = validationError(config);
    if (validation) {
      setError(validation);
      return;
    }

    setSaving(true);
    const { error: dbError } = await persist(config);

    if (dbError) {
      setError(dbError.message);
    } else {
      setSaved(true);
      await logAudit('site_announcement_updated', {
        enabled: config.enabled,
        type: config.type,
        headline: config.headline,
      });
      window.setTimeout(() => setSaved(false), 3000);
    }
    setSaving(false);
  }

  async function handleToggle() {
    setError(null);
    const next = { ...config, enabled: !config.enabled };

    const validation = validationError(next);
    if (validation) {
      setError(validation);
      return;
    }

    setToggling(true);
    const { error: dbError } = await persist(next);

    if (dbError) {
      // Do not leave the UI claiming "Live" when persistence failed.
      setError(dbError.message);
      setToggling(false);
      return;
    }

    setConfig(next);
    await logAudit(next.enabled ? 'site_announcement_enabled' : 'site_announcement_disabled', {
      type: next.type,
      headline: next.headline,
    });
    setToggling(false);
  }

  function handleTestCta() {
    setError(null);
    const link = config.cta_link?.trim();
    if (!link) {
      setError('Add a CTA link before testing it.');
      return;
    }

    try {
      const url = resolveSiteAnnouncementCtaUrl(link, getAdminApiBase());
      window.open(url, '_blank', 'noopener,noreferrer');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to test CTA link.');
    }
  }

  if (loading) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-brand border-t-transparent" />
      </div>
    );
  }

  const targetDisplay = config.target_date
    ? new Date(config.target_date).toLocaleString(undefined, { timeZoneName: 'short' })
    : null;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <Megaphone className="h-6 w-6 text-brand" />
          <div>
            <h1 className="text-xl font-bold text-gray-900">Site Announcement</h1>
            <p className="text-sm text-gray-500">
              Display an informational banner on the public marketing site.
              This does NOT affect WhatsApp, payments, or any runtime capability.
            </p>
          </div>
        </div>
        <button
          onClick={handleToggle}
          disabled={toggling || saving}
          className={`flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-bold transition disabled:opacity-50 ${
            config.enabled
              ? 'bg-green-100 text-green-700 hover:bg-green-200'
              : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
          }`}
        >
          {config.enabled ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
          {toggling ? 'Updating...' : config.enabled ? 'Live' : 'Off'}
        </button>
      </div>

      <AnnouncementPreview config={config} />

      <div className="rounded-2xl border border-gray-200 bg-white p-6 space-y-5">
        <div>
          <label className="mb-1 block text-sm font-medium text-gray-700">Type</label>
          <select
            value={config.type}
            onChange={(e) => setConfig({ ...config, type: e.target.value as SiteAnnouncementType })}
            className="w-full rounded-xl border border-gray-300 px-3 py-2 text-sm"
          >
            {TYPES.map((t) => (
              <option key={t.value} value={t.value}>{t.label}</option>
            ))}
          </select>
        </div>

        <div>
          <label className="mb-1 block text-sm font-medium text-gray-700">Style</label>
          <select
            value={config.style}
            onChange={(e) => setConfig({ ...config, style: e.target.value as SiteAnnouncementStyle })}
            className="w-full rounded-xl border border-gray-300 px-3 py-2 text-sm"
          >
            {STYLES.map((s) => (
              <option key={s.value} value={s.value}>{s.label}</option>
            ))}
          </select>
        </div>

        <div>
          <label className="mb-1 block text-sm font-medium text-gray-700">
            Headline <span className="text-gray-400">(required before live, max 200 chars)</span>
          </label>
          <input
            type="text"
            maxLength={200}
            value={config.headline}
            onChange={(e) => setConfig({ ...config, headline: e.target.value })}
            placeholder="e.g. Waaiio launches soon!"
            className="w-full rounded-xl border border-gray-300 px-3 py-2 text-sm"
          />
        </div>

        <div>
          <label className="mb-1 block text-sm font-medium text-gray-700">
            Message <span className="text-gray-400">(optional, max 500 chars)</span>
          </label>
          <textarea
            maxLength={500}
            rows={2}
            value={config.message}
            onChange={(e) => setConfig({ ...config, message: e.target.value })}
            placeholder="Optional supporting text"
            className="w-full rounded-xl border border-gray-300 px-3 py-2 text-sm"
          />
        </div>

        {config.type === 'launch_countdown' && (
          <div className="space-y-2">
            <label className="block text-sm font-medium text-gray-700">
              Target Date/Time <span className="text-gray-400">(required before live)</span>
            </label>
            <input
              type="datetime-local"
              value={toLocalDateTimeInputValue(config.target_date)}
              onChange={(e) => setConfig({
                ...config,
                target_date: localDateTimeInputToIso(e.target.value),
              })}
              className="w-full rounded-xl border border-gray-300 px-3 py-2 text-sm"
            />
            <div className="flex items-start gap-2 rounded-xl bg-blue-50 px-3 py-2 text-xs text-blue-800">
              <Clock3 className="mt-0.5 h-4 w-4 shrink-0" />
              <div>
                <div>
                  Times are shown in your browser timezone: <strong>{browserTimeZone}</strong>. They are stored as UTC.
                </div>
                {targetDisplay && <div className="mt-0.5">Selected target: {targetDisplay}</div>}
              </div>
            </div>
            <div className="rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-800">
              Current expiry behavior: after the target time, the countdown disappears but the banner
              remains visible until an admin turns it off or changes it.
              {SITE_ANNOUNCEMENT_EXPIRY_POLICY === 'manual_disable' ? ' Automatic expiry is not enabled.' : ''}
            </div>
          </div>
        )}

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">
              CTA Text <span className="text-gray-400">(optional)</span>
            </label>
            <input
              type="text"
              maxLength={50}
              value={config.cta_text || ''}
              onChange={(e) => setConfig({ ...config, cta_text: e.target.value || null })}
              placeholder="e.g. Get Started"
              className="w-full rounded-xl border border-gray-300 px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">
              CTA Link <span className="text-gray-400">(optional)</span>
            </label>
            <div className="flex gap-2">
              <input
                type="text"
                value={config.cta_link || ''}
                onChange={(e) => setConfig({ ...config, cta_link: e.target.value || null })}
                placeholder="/get-started or https://..."
                className="min-w-0 flex-1 rounded-xl border border-gray-300 px-3 py-2 text-sm"
              />
              <button
                type="button"
                onClick={handleTestCta}
                disabled={!config.cta_link}
                className="flex shrink-0 items-center gap-1.5 rounded-xl border border-gray-300 px-3 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-40"
              >
                <ExternalLink className="h-4 w-4" />
                Test CTA
              </button>
            </div>
            <p className="mt-1 text-xs text-gray-400">
              CTA text and link must be provided together.
            </p>
            <WhatsAppLinkGenerator
              onUseLink={(url) => setConfig({ ...config, cta_link: url })}
            />
          </div>
        </div>

        {error && (
          <div className="rounded-xl bg-red-50 px-4 py-2 text-sm text-red-700">{error}</div>
        )}

        <div className="flex items-center gap-3">
          <button
            onClick={handleSave}
            disabled={saving || toggling}
            className="flex items-center gap-2 rounded-xl bg-brand px-5 py-2.5 text-sm font-bold text-white transition hover:bg-brand-600 disabled:opacity-50"
          >
            <Save className="h-4 w-4" />
            {saving ? 'Saving...' : 'Save Changes'}
          </button>
          {saved && <span className="text-sm font-medium text-green-600">Saved!</span>}
        </div>
      </div>
    </div>
  );
}
