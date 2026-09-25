'use client';

import { useEffect, useState } from 'react';

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

interface TimeLeft {
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
}

function computeTimeLeft(target: string): TimeLeft | null {
  const diff = new Date(target).getTime() - Date.now();
  if (diff <= 0) return null;
  return {
    days: Math.floor(diff / (1000 * 60 * 60 * 24)),
    hours: Math.floor((diff / (1000 * 60 * 60)) % 24),
    minutes: Math.floor((diff / (1000 * 60)) % 60),
    seconds: Math.floor((diff / 1000) % 60),
  };
}

const STYLE_CLASSES: Record<string, { bg: string; text: string; accent: string }> = {
  brand: { bg: 'bg-brand-900', text: 'text-white', accent: 'bg-accent text-gray-900' },
  warning: { bg: 'bg-amber-600', text: 'text-white', accent: 'bg-white text-amber-700' },
  info: { bg: 'bg-blue-600', text: 'text-white', accent: 'bg-white text-blue-700' },
};

export default function SiteAnnouncement() {
  const [config, setConfig] = useState<AnnouncementConfig | null>(null);
  const [timeLeft, setTimeLeft] = useState<TimeLeft | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    let mounted = true;
    fetch('/api/site-announcement')
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (mounted && data?.enabled) setConfig(data);
      })
      .catch(() => {
        // Fail-safe: do nothing on fetch error
      });
    return () => { mounted = false; };
  }, []);

  // Countdown ticker
  useEffect(() => {
    if (!config?.target_date || config.type !== 'launch_countdown') return;
    const tick = () => setTimeLeft(computeTimeLeft(config.target_date!));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [config?.target_date, config?.type]);

  if (!config?.enabled || dismissed) return null;

  const styles = STYLE_CLASSES[config.style] || STYLE_CLASSES.brand;

  return (
    <div className={`relative ${styles.bg} ${styles.text}`}>
      <div className="mx-auto max-w-6xl px-4 py-3 sm:py-4">
        <div className="flex flex-col items-center gap-3 text-center sm:flex-row sm:justify-center sm:gap-4">
          {/* Content */}
          <div className="flex-1 min-w-0">
            {config.headline && (
              <p className="text-sm font-bold sm:text-base">{config.headline}</p>
            )}
            {config.message && (
              <p className="mt-0.5 text-xs opacity-90 sm:text-sm">{config.message}</p>
            )}
          </div>

          {/* Countdown */}
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

          {/* CTA */}
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

      {/* Dismiss button */}
      <button
        onClick={() => setDismissed(true)}
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
