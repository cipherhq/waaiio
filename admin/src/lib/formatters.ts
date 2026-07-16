const CURRENCY_LOCALES: Record<string, string> = {
  NGN: 'en-NG',
  GHS: 'en-GH',
  USD: 'en-US',
  GBP: 'en-GB',
  CAD: 'en-CA',
  EUR: 'en-IE',
  INR: 'en-IN',
  ZAR: 'en-ZA',
  KES: 'en-KE',
  AED: 'ar-AE',
};

export function fmtCurrency(amount: number, currency = 'NGN'): string {
  const locale = CURRENCY_LOCALES[currency] || 'en-US';
  const hasCents = amount % 1 !== 0;
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency,
      minimumFractionDigits: hasCents ? 2 : 0,
      maximumFractionDigits: hasCents ? 2 : 0,
    }).format(amount);
  } catch {
    // Fallback for unknown currency codes
    return `${currency} ${amount.toLocaleString()}`;
  }
}

export function fmtDate(date: string | Date): string {
  return new Date(date).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

export function fmtDateTime(date: string | Date): string {
  return new Date(date).toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Mask phone number for admin display — shows only last 4 digits. */
export function maskPhone(phone: string | null | undefined): string {
  if (!phone) return '—';
  if (phone.length <= 4) return phone;
  return '•••• ' + phone.slice(-4);
}

/** Mask email for admin display — shows first 2 chars + domain only. */
export function maskEmail(email: string | null | undefined): string {
  if (!email) return '—';
  const [local, domain] = email.split('@');
  if (!domain) return '—';
  return local.slice(0, 2) + '•••@' + domain;
}

export function fmtRelative(date: string | Date): string {
  const now = Date.now();
  const then = new Date(date).getTime();
  const diff = now - then;

  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return 'just now';

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;

  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;

  return `${Math.floor(months / 12)}y ago`;
}
