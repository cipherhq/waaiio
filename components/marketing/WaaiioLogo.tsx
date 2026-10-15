/**
 * Waaiio brand logo components.
 * Used in Navbar (dark/light variants) and Footer (light variant).
 *
 * All dimensions and paths resolve from lib/brand.ts — the single source of truth.
 */

import Image from 'next/image';
import { WORDMARK_PATH, WORDMARK_ALT, WORDMARK_DISPLAY } from '@/lib/brand';

export function WaaiioMark({ className = 'h-8' }: { className?: string }) {
  return (
    <Image
      src={WORDMARK_PATH}
      alt={WORDMARK_ALT}
      width={WORDMARK_DISPLAY.standard.width}
      height={WORDMARK_DISPLAY.standard.height}
      className={className}
      priority
    />
  );
}

export function WaaiioWordmark({ variant = 'dark' }: { variant?: 'dark' | 'light' }) {
  // The logo.png already contains the full wordmark, so WaaiioMark alone is sufficient.
  // This component is kept for backward compatibility but renders nothing.
  return null;
}
