/**
 * Waaiio Brand Source of Truth
 *
 * Single canonical definition for all Waaiio-owned platform branding.
 * Every Waaiio logo reference, dimension, alt text, and brand color
 * should resolve through this module.
 *
 * Business/tenant logos and white-label branding are separate concerns
 * and are NOT managed here.
 */

// ── Brand Identity ──

export const BRAND_NAME = 'Waaiio';
export const BRAND_URL = 'https://www.waaiio.com';

// ── Canonical Wordmark Asset ──
// Owner-provided PNG: 1387×307, RGBA, transparent background.
// Located at public/logo.png — the single source of truth.
// admin/public/logo.png is a required duplicate (Vite serves from its own public/).

export const WORDMARK_PATH = '/logo.png';
export const WORDMARK_WIDTH = 1387;
export const WORDMARK_HEIGHT = 307;
export const WORDMARK_ASPECT_RATIO = WORDMARK_WIDTH / WORDMARK_HEIGHT; // ~4.52
export const WORDMARK_ALT = 'Waaiio';

// ── Canonical Square Icon Asset ──
// Purple Waaiio O/Q mark used for favicon, PWA icons, and apple-touch-icon.
// Located at public/apple-touch-icon.png (and sized variants).

export const ICON_PATH = '/apple-touch-icon.png';
export const FAVICON_PATH = ICON_PATH;

// ── Common Display Sizes ──
// Intrinsic width/height hints for Next.js Image component.
// CSS class (e.g. h-8) controls rendered size; these prevent layout shift.

export const WORDMARK_DISPLAY = {
  /** Standard: navbar, sidebar, auth header (renders at h-8 / 32px tall) */
  standard: { width: 145, height: 32 } as const,
  /** Small: mobile onboarding header (renders at h-7 / 28px tall) */
  small: { width: 127, height: 28 } as const,
  /** Watermark: ticket images, PDF watermarks */
  watermark: { width: 72, height: 16 } as const,
} as const;

// ── OG / Social Metadata ──
// Use the canonical asset dimensions for OpenGraph image metadata.

export const OG_IMAGE = {
  url: WORDMARK_PATH,
  width: WORDMARK_WIDTH,
  height: WORDMARK_HEIGHT,
  alt: WORDMARK_ALT,
} as const;

// ── Brand Colors (official visual identity) ──
// green "Wa" + orange "ai" + lavender/purple "io" with circular chat/phone mark

export const BRAND_COLORS = {
  /** Green used for "Wa" */
  green: '#25D366',
  /** Orange used for "ai" */
  orange: '#E5993E',
  /** Lavender/purple used for "io" */
  lavender: '#B5A3E0',
} as const;
