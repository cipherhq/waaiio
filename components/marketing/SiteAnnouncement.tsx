'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { usePathname } from 'next/navigation';
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

const MODAL_SHOWN_KEY = 'waaiio_launch_modal_shown';

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

// ── Launch strip (compact bar for launch_countdown) ──

function LaunchStrip({
  config,
  timeLeft,
  onOpenModal,
  onDismiss,
}: {
  config: AnnouncementConfig;
  timeLeft: TimeLeft | null;
  onOpenModal: () => void;
  onDismiss: () => void;
}) {
  const launchDateDisplay = config.target_date
    ? formatLaunchDate(config.target_date)
    : null;

  const stripRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = stripRef.current;
    if (el) {
      const h = el.offsetHeight;
      document.documentElement.style.setProperty('--announcement-h', `${h}px`);
    }
    return () => {
      document.documentElement.style.setProperty('--announcement-h', '0px');
    };
  }, []);

  return (
    <div ref={stripRef} data-testid="launch-strip" className="fixed left-0 right-0 top-0 z-50 bg-brand-900 text-white">
      <div className="mx-auto max-w-6xl px-4 py-2.5 sm:py-3">
        <div className="flex items-center justify-center gap-3 text-center sm:gap-4">
          <p className="text-sm font-medium sm:text-base">
            {launchDateDisplay ? (
              <>Waaiio launches <strong>{launchDateDisplay}</strong></>
            ) : (
              <strong>Waaiio is coming soon</strong>
            )}
          </p>

          {timeLeft && (
            <div className="hidden sm:flex gap-1.5">
              {[
                { value: timeLeft.days, label: 'd' },
                { value: timeLeft.hours, label: 'h' },
                { value: timeLeft.minutes, label: 'm' },
              ].map(({ value, label }) => (
                <span key={label} className="rounded bg-white/15 px-1.5 py-0.5 text-xs font-bold tabular-nums">
                  {String(value).padStart(2, '0')}{label}
                </span>
              ))}
            </div>
          )}

          <button
            onClick={onOpenModal}
            className="shrink-0 rounded-lg bg-accent px-3.5 py-1.5 text-xs font-bold text-gray-900 transition hover:bg-accent-400"
          >
            Get notified
          </button>
        </div>
      </div>

      <button
        onClick={onDismiss}
        className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full p-1 opacity-60 transition hover:opacity-100"
        aria-label="Dismiss announcement"
      >
        <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </div>
  );
}

// ── Launch modal ──

function LaunchModal({
  config,
  timeLeft,
  onClose,
}: {
  config: AnnouncementConfig;
  timeLeft: TimeLeft | null;
  onClose: () => void;
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
        setSelectedCode(match ? match.code : null);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  const selectedRegion = selectedCode ? regions.find((r) => r.code === selectedCode) : null;
  const waLink = selectedRegion ? buildWhatsAppLink(selectedRegion.phone) : '';
  const launchDateDisplay = config.target_date ? formatLaunchDate(config.target_date) : null;

  return (
    <div
      data-testid="launch-modal-backdrop"
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        data-testid="launch-modal"
        className="relative w-full max-w-lg rounded-2xl bg-white shadow-2xl overflow-y-auto max-h-[90vh]"
        role="dialog"
        aria-modal="true"
        aria-label="Launch notification signup"
      >
        {/* Header */}
        <div className="bg-brand-900 px-6 py-6 text-white text-center rounded-t-2xl">
          <h2 className="text-xl font-bold sm:text-2xl">
            {launchDateDisplay ? (
              <>Waaiio launches <span className="text-accent">{launchDateDisplay}</span></>
            ) : (
              <>Waaiio is <span className="text-accent">coming soon</span></>
            )}
          </h2>
          {config.message && (
            <p className="mt-2 text-sm text-brand-200">{config.message}</p>
          )}

          {timeLeft && (
            <div className="mt-4 flex justify-center gap-2">
              {[
                { value: timeLeft.days, label: 'Days' },
                { value: timeLeft.hours, label: 'Hrs' },
                { value: timeLeft.minutes, label: 'Min' },
                { value: timeLeft.seconds, label: 'Sec' },
              ].map(({ value, label }) => (
                <div key={label} className="flex flex-col items-center rounded-xl bg-white/10 px-3 py-2 min-w-[52px]">
                  <span className="text-xl font-bold tabular-nums">{String(value).padStart(2, '0')}</span>
                  <span className="mt-0.5 text-[9px] uppercase tracking-wide text-brand-300">{label}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Body */}
        <div className="px-6 py-6">
          <p className="text-center text-sm text-gray-600">
            Get a WhatsApp message when we go live. No spam.
          </p>

          {/* Region selector */}
          {!loading && regions.length > 1 && (
            <div className="mt-4 flex items-center justify-center gap-2">
              <label htmlFor="modal-country-select" className="text-xs text-gray-500">Your region:</label>
              <select
                id="modal-country-select"
                data-testid="country-selector"
                value={selectedCode || ''}
                onChange={(e) => setSelectedCode(e.target.value || null)}
                className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm focus:border-brand focus:ring-2 focus:ring-brand-100"
              >
                <option value="">Select a country…</option>
                {regions.map((r) => (
                  <option key={r.code} value={r.code}>{r.flag} {r.name}</option>
                ))}
              </select>
            </div>
          )}

          {loading ? (
            <div className="mt-6 flex justify-center">
              <div className="h-8 w-8 animate-spin rounded-full border-4 border-brand border-t-transparent" />
            </div>
          ) : selectedRegion ? (
            <div className="mt-6 flex flex-col items-center gap-5">
              {/* QR code */}
              <div className="flex flex-col items-center gap-2">
                <div className="rounded-2xl border-2 border-gray-100 bg-white p-3">
                  <QRCodeSVG value={waLink} size={140} level="M" bgColor="#ffffff" fgColor="#1a1a2e" />
                </div>
                <span className="text-[10px] text-gray-400">Scan with phone camera</span>
              </div>

              {/* OR divider */}
              <div className="flex items-center gap-3 w-full max-w-[200px]">
                <div className="h-px flex-1 bg-gray-200" />
                <span className="text-xs font-medium text-gray-400">OR</span>
                <div className="h-px flex-1 bg-gray-200" />
              </div>

              {/* WhatsApp button */}
              <a
                href={waLink}
                target="_blank"
                rel="noopener noreferrer"
                data-testid="whatsapp-button"
                className="inline-flex items-center gap-2.5 rounded-xl bg-[#25D366] px-6 py-3 text-sm font-bold text-white shadow-lg transition hover:bg-[#25D366]/85"
              >
                <svg aria-hidden="true" className="h-5 w-5" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347z" />
                </svg>
                Notify Me on WhatsApp
              </a>
              <span className="text-xs text-gray-500">via +{formatPhone(selectedRegion.phone)}</span>
            </div>
          ) : !loading && regions.length > 0 ? (
            <p data-testid="cta-disabled" className="mt-6 text-center text-sm text-gray-500">
              Select a country above to enable notifications.
            </p>
          ) : !loading && regions.length === 0 ? (
            <p className="mt-6 text-center text-sm text-gray-500">
              WhatsApp launch alerts are not available for any region yet.
            </p>
          ) : null}

          <p className="mt-6 text-center text-[11px] text-gray-400">
            One message when we launch. No spam, unsubscribe anytime.
          </p>
        </div>

        {/* Close button */}
        <button
          onClick={onClose}
          className="absolute right-3 top-3 rounded-full bg-white/20 p-1.5 text-white transition hover:bg-white/30"
          aria-label="Close modal"
        >
          <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
    </div>
  );
}

// ── Main component ──

export default function SiteAnnouncement() {
  const pathname = usePathname();
  const [config, setConfig] = useState<AnnouncementConfig | null>(null);
  const [timeLeft, setTimeLeft] = useState<TimeLeft | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);

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

  // Auto-open modal once per session for launch_countdown
  useEffect(() => {
    if (!config || config.type !== 'launch_countdown') return;
    // Suppress on /launch page (it IS the launch experience)
    if (pathname === '/launch') return;
    try {
      if (!sessionStorage.getItem(MODAL_SHOWN_KEY)) {
        setModalOpen(true);
        sessionStorage.setItem(MODAL_SHOWN_KEY, '1');
      }
    } catch {
      // sessionStorage unavailable (SSR/private browsing) — skip auto-open
    }
  }, [config, pathname]);

  useEffect(() => {
    if (!config?.target_date || config.type !== 'launch_countdown') return;
    const tick = () => setTimeLeft(computeTimeLeft(config.target_date!));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [config?.target_date, config?.type]);

  const handleCloseModal = useCallback(() => setModalOpen(false), []);
  const handleOpenModal = useCallback(() => setModalOpen(true), []);
  const handleDismiss = useCallback(() => {
    setDismissed(true);
    document.documentElement.style.setProperty('--announcement-h', '0px');
  }, []);

  if (!config?.enabled) return null;

  // Suppress launch treatment on /launch page — it IS the launch experience
  if (config.type === 'launch_countdown' && pathname === '/launch') return null;

  // Non-launch types keep the original compact behavior
  if (config.type !== 'launch_countdown') {
    if (dismissed) return null;
    return <CompactAnnouncement config={config} timeLeft={timeLeft} onDismiss={handleDismiss} />;
  }

  // Launch countdown: compact strip + dismissible modal
  return (
    <>
      {!dismissed && (
        <LaunchStrip
          config={config}
          timeLeft={timeLeft}
          onOpenModal={handleOpenModal}
          onDismiss={handleDismiss}
        />
      )}
      {modalOpen && (
        <LaunchModal config={config} timeLeft={timeLeft} onClose={handleCloseModal} />
      )}
    </>
  );
}
