'use client';

import { useEffect, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';

// ── Types ──

interface Region {
  phone: string;
  code: string;
  name: string;
  flag: string;
}

interface TimeLeft {
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
}

interface AnnouncementConfig {
  enabled: boolean;
  type: string;
  headline: string;
  message: string;
  target_date: string | null;
}

// ── Constants ──

const OPT_IN_MESSAGE = 'Notify me when Waaiio launches';

const WAAIIO_101 = [
  { emoji: '\u{1F4C5}', text: 'Book appointments & reservations' },
  { emoji: '\u{1F4B3}', text: 'Accept payments on WhatsApp' },
  { emoji: '\u{1F6D2}', text: 'Take orders & sell products' },
  { emoji: '\u{1F3AB}', text: 'Sell event tickets' },
  { emoji: '\u{1F49D}', text: 'Receive donations & giving' },
  { emoji: '\u{1F916}', text: 'AI-powered automation for 89+ business types' },
];

// ── Helpers ──

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

function buildWhatsAppLink(phone: string, source: 'button' | 'qr') {
  const msg = encodeURIComponent(`${OPT_IN_MESSAGE} (${source})`);
  return `https://wa.me/${phone.replace(/\D/g, '')}?text=${msg}`;
}

/** Format an international phone number for display. Handles variable-length numbers. */
function formatPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  // Group: country code (1-3 digits) then remaining in chunks of 3-4
  if (digits.length <= 4) return digits;
  // Try common patterns
  if (digits.startsWith('1') && digits.length === 11) {
    // NANP: 1-XXX-XXX-XXXX
    return `${digits.slice(0, 1)} ${digits.slice(1, 4)} ${digits.slice(4, 7)} ${digits.slice(7)}`;
  }
  if (digits.startsWith('44') && digits.length >= 12) {
    // UK: 44 XXXX XXXXXX
    return `${digits.slice(0, 2)} ${digits.slice(2, 6)} ${digits.slice(6)}`;
  }
  if (digits.startsWith('234') && digits.length >= 13) {
    // Nigeria: 234 XXX XXX XXXX
    return `${digits.slice(0, 3)} ${digits.slice(3, 6)} ${digits.slice(6, 9)} ${digits.slice(9)}`;
  }
  if (digits.startsWith('233') && digits.length >= 12) {
    // Ghana: 233 XX XXX XXXX
    return `${digits.slice(0, 3)} ${digits.slice(3, 5)} ${digits.slice(5, 8)} ${digits.slice(8)}`;
  }
  // Generic fallback: country code (1-3 digits) + groups of 3
  const cc = digits.length > 10 ? digits.slice(0, digits.length - 10) : digits.slice(0, 1);
  const rest = digits.slice(cc.length);
  const groups = rest.match(/.{1,3}/g) || [];
  return `${cc} ${groups.join(' ')}`;
}

/** Format a target date for display in the hero heading */
function formatLaunchDate(isoDate: string): string {
  try {
    const d = new Date(isoDate);
    return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
  } catch {
    return '';
  }
}

// ── Geo detection (best-effort from timezone) ──

function detectCountryFromTimezone(): string | null {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (tz.startsWith('Africa/Lagos') || tz.startsWith('Africa/Abuja')) return 'NG';
    if (tz.startsWith('Africa/Accra')) return 'GH';
    if (tz.startsWith('America/New_York') || tz.startsWith('America/Chicago') || tz.startsWith('America/Denver') || tz.startsWith('America/Los_Angeles')) return 'US';
    if (tz.startsWith('Europe/London')) return 'GB';
    if (tz.startsWith('America/Toronto') || tz.startsWith('America/Vancouver')) return 'CA';
    return null;
  } catch {
    return null;
  }
}

// ── Component ──

export default function LaunchClient() {
  const [regions, setRegions] = useState<Region[]>([]);
  const [selectedCode, setSelectedCode] = useState<string>('');
  const [announcement, setAnnouncement] = useState<AnnouncementConfig | null>(null);
  const [timeLeft, setTimeLeft] = useState<TimeLeft | null>(null);
  const [loading, setLoading] = useState(true);

  // Fetch regions + announcement config in parallel
  useEffect(() => {
    Promise.all([
      fetch('/api/launch/regions').then(r => r.ok ? r.json() : null).catch(() => null),
      fetch('/api/site-announcement').then(r => r.ok ? r.json() : null).catch(() => null),
    ]).then(([regionsData, announcementData]) => {
      // Regions
      const list: Region[] = regionsData?.regions || [];
      setRegions(list);
      const detected = detectCountryFromTimezone();
      const match = list.find(r => r.code === detected);
      setSelectedCode(match?.code || list[0]?.code || '');

      // Announcement (authoritative source for launch date)
      if (announcementData?.enabled) {
        setAnnouncement(announcementData);
      }

      setLoading(false);
    });
  }, []);

  // Countdown timer — driven by announcement target_date
  useEffect(() => {
    if (!announcement?.target_date) return;
    const tick = () => setTimeLeft(computeTimeLeft(announcement.target_date!));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [announcement?.target_date]);

  const selectedRegion = regions.find(r => r.code === selectedCode);
  const waLink = selectedRegion ? buildWhatsAppLink(selectedRegion.phone, 'button') : '#';
  const qrLink = selectedRegion ? buildWhatsAppLink(selectedRegion.phone, 'qr') : '';

  // Derive display date from announcement
  const launchDateDisplay = announcement?.target_date
    ? formatLaunchDate(announcement.target_date)
    : null;

  return (
    <div className="min-h-screen bg-gradient-to-b from-brand-900 via-brand-800 to-brand-900 text-white">
      <div className="mx-auto max-w-4xl px-4 pt-24 pb-16">

        {/* Hero */}
        <div className="text-center">
          <h1 className="text-4xl font-extrabold tracking-tight sm:text-5xl">
            {launchDateDisplay ? (
              <>
                Waaiio launches{' '}
                <span className="bg-gradient-to-r from-accent to-orange-300 bg-clip-text text-transparent">
                  {launchDateDisplay}
                </span>
              </>
            ) : (
              <>
                Waaiio is{' '}
                <span className="bg-gradient-to-r from-accent to-orange-300 bg-clip-text text-transparent">
                  coming soon
                </span>
              </>
            )}
          </h1>
          <p className="mx-auto mt-4 max-w-xl text-lg text-brand-200">
            {announcement?.headline || 'Your customers book, pay, and order — all on WhatsApp.'}
          </p>
          {announcement?.message && (
            <p className="mx-auto mt-2 max-w-lg text-sm text-brand-300">{announcement.message}</p>
          )}
        </div>

        {/* Countdown — only shown when announcement has a target_date */}
        {timeLeft && (
          <div className="mt-10 flex justify-center gap-3 sm:gap-4">
            {[
              { value: timeLeft.days, label: 'Days' },
              { value: timeLeft.hours, label: 'Hours' },
              { value: timeLeft.minutes, label: 'Min' },
              { value: timeLeft.seconds, label: 'Sec' },
            ].map(({ value, label }) => (
              <div key={label} className="flex flex-col items-center rounded-2xl bg-white/10 backdrop-blur-sm px-4 py-3 min-w-[60px] sm:min-w-[80px]">
                <span className="text-3xl font-bold tabular-nums sm:text-4xl">{String(value).padStart(2, '0')}</span>
                <span className="mt-1 text-xs uppercase tracking-wide text-brand-300">{label}</span>
              </div>
            ))}
          </div>
        )}

        {/* Waaiio 101 */}
        <div className="mt-12 rounded-2xl bg-white/5 backdrop-blur-sm border border-white/10 p-6 sm:p-8">
          <h2 className="text-center text-xl font-bold">What is Waaiio?</h2>
          <p className="mt-2 text-center text-sm text-brand-300">
            WhatsApp automation for any business, any industry, any country.
          </p>
          <div className="mt-6 grid gap-3 sm:grid-cols-2">
            {WAAIIO_101.map(item => (
              <div key={item.text} className="flex items-center gap-3 rounded-xl bg-white/5 px-4 py-3">
                <span className="text-2xl">{item.emoji}</span>
                <span className="text-sm">{item.text}</span>
              </div>
            ))}
          </div>
        </div>

        {/* WhatsApp CTA Section */}
        <div className="mt-12 rounded-2xl bg-white p-6 text-gray-900 sm:p-8">
          <h2 className="text-center text-xl font-bold">Get Notified on WhatsApp</h2>
          <p className="mt-1 text-center text-sm text-gray-500">
            Scan the QR code or tap the button — same action, your choice.
          </p>

          {/* Region selector */}
          {!loading && regions.length > 1 && (
            <div className="mt-4 flex items-center justify-center gap-2">
              <label className="text-xs text-gray-500">Your region:</label>
              <select
                value={selectedCode}
                onChange={(e) => setSelectedCode(e.target.value)}
                className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm focus:border-brand focus:ring-2 focus:ring-brand-100"
              >
                {regions.map(r => (
                  <option key={r.code} value={r.code}>{r.flag} {r.name}</option>
                ))}
              </select>
              <span className="text-[10px] text-gray-400">(auto-detected, change if needed)</span>
            </div>
          )}

          {loading ? (
            <div className="mt-6 flex justify-center">
              <div className="h-8 w-8 animate-spin rounded-full border-4 border-brand border-t-transparent" />
            </div>
          ) : selectedRegion ? (
            <div className="mt-6 flex flex-col items-center gap-6 sm:flex-row sm:justify-center">
              {/* QR Code — locally generated, no external dependency */}
              <div className="flex flex-col items-center gap-2">
                <div className="rounded-2xl border-2 border-gray-100 bg-white p-3">
                  <QRCodeSVG
                    value={qrLink}
                    size={160}
                    level="M"
                    bgColor="#ffffff"
                    fgColor="#1a1a2e"
                  />
                </div>
                <span className="text-[10px] text-gray-400">Scan with phone camera</span>
              </div>

              {/* OR divider */}
              <div className="flex items-center gap-2 sm:flex-col">
                <div className="h-px w-12 bg-gray-200 sm:h-12 sm:w-px" />
                <span className="text-xs font-medium text-gray-400">OR</span>
                <div className="h-px w-12 bg-gray-200 sm:h-12 sm:w-px" />
              </div>

              {/* Button CTA */}
              <div className="flex flex-col items-center gap-3">
                <a
                  href={waLink}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-3 rounded-2xl bg-[#25D366] px-8 py-4 text-base font-bold text-white shadow-lg transition hover:bg-[#25D366]/85 hover:shadow-xl"
                >
                  <svg aria-hidden="true" className="h-6 w-6" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347z"/>
                  </svg>
                  Notify Me on WhatsApp
                </a>
                <span className="text-xs text-gray-500">
                  via +{formatPhone(selectedRegion.phone)}
                </span>
              </div>
            </div>
          ) : (
            <p className="mt-6 text-center text-sm text-gray-500">
              No regional numbers available yet. Check back soon!
            </p>
          )}

          <p className="mt-6 text-center text-[11px] text-gray-400">
            You&apos;ll receive a single WhatsApp message when Waaiio launches. No spam, unsubscribe anytime.
          </p>
        </div>
      </div>
    </div>
  );
}
