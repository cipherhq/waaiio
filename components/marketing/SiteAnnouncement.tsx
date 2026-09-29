'use client';

import { useEffect, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import {
  type LaunchRegion,
  type TimeLeft,
  computeTimeLeft,
  buildWhatsAppLink,
  formatPhone,
  formatLaunchDate,
  detectCountryFromTimezone,
} from '@/lib/launch/shared';

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

const STYLE_CLASSES: Record<string, { bg: string; text: string; accent: string }> = {
  brand: { bg: 'bg-brand-900', text: 'text-white', accent: 'bg-accent text-gray-900' },
  warning: { bg: 'bg-amber-600', text: 'text-white', accent: 'bg-white text-amber-700' },
  info: { bg: 'bg-blue-600', text: 'text-white', accent: 'bg-white text-blue-700' },
};

// ── Compact announcement (non-launch types) ──

function CompactAnnouncement({
  config,
  timeLeft,
  onDismiss,
}: {
  config: AnnouncementConfig;
  timeLeft: TimeLeft | null;
  onDismiss: () => void;
}) {
  const styles = STYLE_CLASSES[config.style] || STYLE_CLASSES.brand;

  return (
    <div data-testid="compact-announcement" className={`relative ${styles.bg} ${styles.text}`}>
      <div className="mx-auto max-w-6xl px-4 py-3 sm:py-4">
        <div className="flex flex-col items-center gap-3 text-center sm:flex-row sm:justify-center sm:gap-4">
          <div className="flex-1 min-w-0">
            {config.headline && (
              <p className="text-sm font-bold sm:text-base">{config.headline}</p>
            )}
            {config.message && (
              <p className="mt-0.5 text-xs opacity-90 sm:text-sm">{config.message}</p>
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
                <div key={label} className="flex flex-col items-center rounded-lg bg-white/15 px-2.5 py-1.5 min-w-[40px]">
                  <span className="text-lg font-bold leading-none tabular-nums">{String(value).padStart(2, '0')}</span>
                  <span className="mt-0.5 text-[10px] uppercase opacity-75">{label}</span>
                </div>
              ))}
            </div>
          )}

          {config.cta_text && config.cta_link && (
            <a
              href={config.cta_link}
              className={`shrink-0 rounded-lg px-4 py-2 text-xs font-bold transition hover:opacity-90 sm:text-sm ${styles.accent}`}
            >
              {config.cta_text}
            </a>
          )}
        </div>
      </div>

      <button
        onClick={onDismiss}
        className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full p-1 opacity-60 transition hover:opacity-100"
        aria-label="Dismiss announcement"
      >
        <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </div>
  );
}

// ── Launch banner (launch_countdown type) ──

function LaunchBanner({
  config,
  timeLeft,
  onDismiss,
}: {
  config: AnnouncementConfig;
  timeLeft: TimeLeft | null;
  onDismiss: () => void;
}) {
  const [regions, setRegions] = useState<LaunchRegion[]>([]);
  const [selectedCode, setSelectedCode] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/launch/regions')
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        const list: LaunchRegion[] = data?.regions || [];
        setRegions(list);

        const detected = detectCountryFromTimezone();
        const match = list.find((r) => r.code === detected);
        // Only auto-select if there is a valid match; otherwise leave null
        setSelectedCode(match ? match.code : null);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  const selectedRegion = selectedCode
    ? regions.find((r) => r.code === selectedCode)
    : null;
  const waLink = selectedRegion
    ? buildWhatsAppLink(selectedRegion.phone)
    : '';

  const launchDateDisplay = config.target_date
    ? formatLaunchDate(config.target_date)
    : null;

  return (
    <div
      data-testid="launch-banner"
      className="relative bg-gradient-to-br from-brand-900 via-brand-800 to-brand-900 text-white"
    >
      <div className="mx-auto max-w-6xl px-4 py-8 sm:py-10">
        <div className="flex flex-col gap-8 lg:flex-row lg:items-start lg:gap-12">
          {/* Left: headline, message, countdown, country selector, CTA */}
          <div className="flex-1 min-w-0">
            <h2 className="text-2xl font-extrabold tracking-tight sm:text-3xl">
              {config.headline ||
                (launchDateDisplay
                  ? `Waaiio launches ${launchDateDisplay} \u{1F389}`
                  : 'Waaiio is coming soon \u{1F389}')}
            </h2>
            {config.message && (
              <p className="mt-2 text-sm text-brand-200 sm:text-base">
                {config.message}
              </p>
            )}

            {/* Countdown */}
            {timeLeft && (
              <div className="mt-5 flex gap-2 sm:gap-3">
                {[
                  { value: timeLeft.days, label: 'Days' },
                  { value: timeLeft.hours, label: 'Hrs' },
                  { value: timeLeft.minutes, label: 'Min' },
                  { value: timeLeft.seconds, label: 'Sec' },
                ].map(({ value, label }) => (
                  <div
                    key={label}
                    className="flex flex-col items-center rounded-xl bg-white/10 backdrop-blur-sm px-3 py-2 min-w-[52px] sm:min-w-[64px]"
                  >
                    <span className="text-xl font-bold tabular-nums sm:text-2xl">
                      {String(value).padStart(2, '0')}
                    </span>
                    <span className="mt-0.5 text-[10px] uppercase tracking-wide text-brand-300">
                      {label}
                    </span>
                  </div>
                ))}
              </div>
            )}

            {/* Country selector */}
            {!loading && regions.length > 0 && (
              <div className="mt-5">
                <label
                  htmlFor="banner-country-select"
                  className="block text-xs text-brand-300 mb-1.5"
                >
                  Choose your country
                </label>
                <select
                  id="banner-country-select"
                  data-testid="country-selector"
                  value={selectedCode || ''}
                  onChange={(e) => setSelectedCode(e.target.value || null)}
                  className="rounded-lg border border-white/20 bg-white/10 px-3 py-2 text-sm text-white backdrop-blur-sm focus:border-accent focus:ring-2 focus:ring-accent/40 w-full max-w-xs"
                >
                  <option value="" className="text-gray-900">
                    Select a country\u2026
                  </option>
                  {regions.map((r) => (
                    <option key={r.code} value={r.code} className="text-gray-900">
                      {r.flag} {r.name}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {/* WhatsApp CTA button */}
            {!loading && selectedRegion ? (
              <div className="mt-5">
                <a
                  href={waLink}
                  target="_blank"
                  rel="noopener noreferrer"
                  data-testid="whatsapp-button"
                  className="inline-flex items-center gap-2.5 rounded-xl bg-[#25D366] px-6 py-3 text-sm font-bold text-white shadow-lg transition hover:bg-[#25D366]/85 hover:shadow-xl sm:text-base"
                >
                  <svg
                    aria-hidden="true"
                    className="h-5 w-5"
                    fill="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347z" />
                  </svg>
                  Notify Me on WhatsApp
                </a>
                <p className="mt-1.5 text-xs text-brand-300">
                  via +{formatPhone(selectedRegion.phone)}
                </p>
              </div>
            ) : !loading && !selectedCode && regions.length > 0 ? (
              <p data-testid="cta-disabled" className="mt-5 text-sm text-brand-300">
                Select a country above to enable WhatsApp notifications.
              </p>
            ) : !loading && regions.length === 0 ? (
              <p className="mt-5 text-sm text-brand-300">
                WhatsApp launch alerts are not available for any region yet.
              </p>
            ) : null}
          </div>

          {/* Right: QR code card */}
          <div className="flex-shrink-0 flex justify-center lg:justify-end">
            {!loading && selectedRegion && waLink ? (
              <div
                data-testid="qr-card"
                className="flex flex-col items-center gap-3 rounded-2xl bg-white p-5 shadow-xl"
              >
                <QRCodeSVG
                  value={waLink}
                  size={140}
                  level="M"
                  bgColor="#ffffff"
                  fgColor="#1a1a2e"
                />
                <p className="text-xs font-medium text-gray-600">
                  Scan to get notified on WhatsApp
                </p>
                <p className="text-[10px] text-gray-400">
                  {selectedRegion.flag} +{formatPhone(selectedRegion.phone)}
                </p>
              </div>
            ) : !loading && !selectedCode && regions.length > 0 ? (
              <div
                data-testid="qr-disabled"
                className="flex flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-white/20 p-8 min-w-[180px] min-h-[180px]"
              >
                <p className="text-xs text-brand-300 text-center">
                  Choose a country
                  <br />
                  to see QR code
                </p>
              </div>
            ) : null}
          </div>
        </div>
      </div>

      {/* Dismiss */}
      <button
        onClick={onDismiss}
        className="absolute right-3 top-3 rounded-full p-1.5 opacity-60 transition hover:opacity-100 hover:bg-white/10"
        aria-label="Dismiss announcement"
      >
        <svg
          className="h-4 w-4"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M6 18L18 6M6 6l12 12"
          />
        </svg>
      </button>
    </div>
  );
}

// ── Main component ──

export default function SiteAnnouncement() {
  const [config, setConfig] = useState<AnnouncementConfig | null>(null);
  const [timeLeft, setTimeLeft] = useState<TimeLeft | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    let mounted = true;
    fetch('/api/site-announcement', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (mounted && data?.enabled) setConfig(data);
      })
      .catch(() => {});
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    if (!config?.target_date || config.type !== 'launch_countdown') return;
    const tick = () => setTimeLeft(computeTimeLeft(config.target_date!));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [config?.target_date, config?.type]);

  if (!config?.enabled || dismissed) return null;

  const handleDismiss = () => setDismissed(true);

  if (config.type === 'launch_countdown') {
    return (
      <LaunchBanner
        config={config}
        timeLeft={timeLeft}
        onDismiss={handleDismiss}
      />
    );
  }

  return (
    <CompactAnnouncement
      config={config}
      timeLeft={timeLeft}
      onDismiss={handleDismiss}
    />
  );
}
