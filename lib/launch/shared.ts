/**
 * Shared launch helpers used by both the /launch page and the site announcement banner.
 * Single source of truth for region types, WhatsApp link building,
 * phone formatting, country detection, and countdown computation.
 */

// ── Types ──

export interface LaunchRegion {
  phone: string;
  code: string;
  name: string;
  flag: string;
}

export interface TimeLeft {
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
}

// ── Constants ──

export const LAUNCH_OPT_IN_MESSAGE = 'Notify me when Waaiio launches';

// ── Countdown ──

export function computeTimeLeft(target: string): TimeLeft | null {
  const diff = new Date(target).getTime() - Date.now();
  if (diff <= 0) return null;
  return {
    days: Math.floor(diff / (1000 * 60 * 60 * 24)),
    hours: Math.floor((diff / (1000 * 60 * 60)) % 24),
    minutes: Math.floor((diff / (1000 * 60)) % 60),
    seconds: Math.floor((diff / 1000) % 60),
  };
}

// ── WhatsApp link ──

export function buildWhatsAppLink(phone: string, source: 'button' | 'qr'): string {
  const msg = encodeURIComponent(`${LAUNCH_OPT_IN_MESSAGE} (${source})`);
  return `https://wa.me/${phone.replace(/\D/g, '')}?text=${msg}`;
}

// ── Phone formatting ──

export function formatPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.length <= 4) return digits;
  if (digits.startsWith('1') && digits.length === 11) {
    return `${digits.slice(0, 1)} ${digits.slice(1, 4)} ${digits.slice(4, 7)} ${digits.slice(7)}`;
  }
  if (digits.startsWith('44') && digits.length >= 12) {
    return `${digits.slice(0, 2)} ${digits.slice(2, 6)} ${digits.slice(6)}`;
  }
  if (digits.startsWith('234') && digits.length >= 13) {
    return `${digits.slice(0, 3)} ${digits.slice(3, 6)} ${digits.slice(6, 9)} ${digits.slice(9)}`;
  }
  if (digits.startsWith('233') && digits.length >= 12) {
    return `${digits.slice(0, 3)} ${digits.slice(3, 5)} ${digits.slice(5, 8)} ${digits.slice(8)}`;
  }
  const cc = digits.length > 10 ? digits.slice(0, digits.length - 10) : digits.slice(0, 1);
  const rest = digits.slice(cc.length);
  const groups = rest.match(/.{1,3}/g) || [];
  return `${cc} ${groups.join(' ')}`;
}

// ── Date formatting ──

export function formatLaunchDate(isoDate: string): string {
  try {
    const d = new Date(isoDate);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
  } catch {
    return '';
  }
}

// ── Country detection (best-effort from timezone) ──

export function detectCountryFromTimezone(): string | null {
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
