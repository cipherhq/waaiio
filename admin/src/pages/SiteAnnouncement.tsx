import { useEffect, useState } from 'react';
import { adminDb } from '@/lib/supabase';
import { useAdminSession } from '@/components/AdminLayout';
import { logAudit } from '@/lib/auditLog';
import { Megaphone, Save, Eye, EyeOff } from 'lucide-react';

const TYPES = [
  { value: 'launch_countdown', label: 'Launch Countdown' },
  { value: 'maintenance_notice', label: 'Maintenance Notice' },
  { value: 'general', label: 'General Announcement' },
] as const;

const STYLES = [
  { value: 'brand', label: 'Brand (Purple)' },
  { value: 'warning', label: 'Warning (Amber)' },
  { value: 'info', label: 'Info (Blue)' },
] as const;

interface AnnouncementConfig {
  enabled: boolean;
  type: string;
  headline: string;
  message: string;
  target_date: string | null;
  cta_text: string | null;
  cta_link: string | null;
  style: string;
}

const EMPTY: AnnouncementConfig = {
  enabled: false,
  type: 'general',
  headline: '',
  message: '',
  target_date: null,
  cta_text: null,
  cta_link: null,
  style: 'brand',
};

export default function SiteAnnouncementPage() {
  const session = useAdminSession();
  const [config, setConfig] = useState<AnnouncementConfig>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const { data } = await adminDb
        .from('platform_settings')
        .select('value')
        .eq('key', 'site_announcement')
        .single();
      if (data?.value) {
        setConfig({ ...EMPTY, ...(data.value as AnnouncementConfig) });
      }
      setLoading(false);
    })();
  }, []);

  async function handleSave() {
    setError(null);
    setSaving(true);
    setSaved(false);

    // Validate CTA link
    if (config.cta_link) {
      if (!config.cta_link.startsWith('/') && !config.cta_link.startsWith('https://')) {
        setError('CTA link must start with / or https://');
        setSaving(false);
        return;
      }
      if (config.cta_link.startsWith('//')) {
        setError('Invalid CTA link');
        setSaving(false);
        return;
      }
    }

    const { error: dbError } = await adminDb
      .from('platform_settings')
      .update({
        value: config,
        updated_by: session?.userId ?? null,
        updated_at: new Date().toISOString(),
      })
      .eq('key', 'site_announcement');

    if (dbError) {
      setError(dbError.message);
    } else {
      setSaved(true);
      await logAudit('site_announcement_updated', {
        enabled: config.enabled,
        type: config.type,
        headline: config.headline,
      });
      setTimeout(() => setSaved(false), 3000);
    }
    setSaving(false);
  }

  async function handleToggle() {
    const next = { ...config, enabled: !config.enabled };
    setConfig(next);

    const { error: dbError } = await adminDb
      .from('platform_settings')
      .update({
        value: next,
        updated_by: session?.userId ?? null,
        updated_at: new Date().toISOString(),
      })
      .eq('key', 'site_announcement');

    if (!dbError) {
      await logAudit(next.enabled ? 'site_announcement_enabled' : 'site_announcement_disabled', {
        type: next.type,
        headline: next.headline,
      });
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[40vh]">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-brand border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
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
          className={`flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-bold transition ${
            config.enabled
              ? 'bg-green-100 text-green-700 hover:bg-green-200'
              : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
          }`}
        >
          {config.enabled ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
          {config.enabled ? 'Live' : 'Off'}
        </button>
      </div>

      <div className="rounded-2xl border border-gray-200 bg-white p-6 space-y-5">
        {/* Type */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Type</label>
          <select
            value={config.type}
            onChange={(e) => setConfig({ ...config, type: e.target.value })}
            className="w-full rounded-xl border border-gray-300 px-3 py-2 text-sm"
          >
            {TYPES.map((t) => (
              <option key={t.value} value={t.value}>{t.label}</option>
            ))}
          </select>
        </div>

        {/* Style */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Style</label>
          <select
            value={config.style}
            onChange={(e) => setConfig({ ...config, style: e.target.value })}
            className="w-full rounded-xl border border-gray-300 px-3 py-2 text-sm"
          >
            {STYLES.map((s) => (
              <option key={s.value} value={s.value}>{s.label}</option>
            ))}
          </select>
        </div>

        {/* Headline */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Headline <span className="text-gray-400">(max 200 chars)</span>
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

        {/* Message */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Message <span className="text-gray-400">(max 500 chars)</span>
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

        {/* Target date (for countdown) */}
        {config.type === 'launch_countdown' && (
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Target Date/Time (countdown)
            </label>
            <input
              type="datetime-local"
              value={config.target_date?.slice(0, 16) || ''}
              onChange={(e) =>
                setConfig({ ...config, target_date: e.target.value ? new Date(e.target.value).toISOString() : null })
              }
              className="w-full rounded-xl border border-gray-300 px-3 py-2 text-sm"
            />
          </div>
        )}

        {/* CTA */}
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
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
            <label className="block text-sm font-medium text-gray-700 mb-1">
              CTA Link <span className="text-gray-400">(optional)</span>
            </label>
            <input
              type="text"
              value={config.cta_link || ''}
              onChange={(e) => setConfig({ ...config, cta_link: e.target.value || null })}
              placeholder="/get-started or https://..."
              className="w-full rounded-xl border border-gray-300 px-3 py-2 text-sm"
            />
          </div>
        </div>

        {error && (
          <div className="rounded-xl bg-red-50 px-4 py-2 text-sm text-red-700">{error}</div>
        )}

        <div className="flex items-center gap-3">
          <button
            onClick={handleSave}
            disabled={saving}
            className="flex items-center gap-2 rounded-xl bg-brand px-5 py-2.5 text-sm font-bold text-white transition hover:bg-brand-600 disabled:opacity-50"
          >
            <Save className="h-4 w-4" />
            {saving ? 'Saving...' : 'Save Changes'}
          </button>
          {saved && <span className="text-sm text-green-600 font-medium">Saved!</span>}
        </div>
      </div>
    </div>
  );
}
