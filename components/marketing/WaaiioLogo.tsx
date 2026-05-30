/**
 * Waaiio brand logo components.
 * Used in Navbar (dark/light variants) and Footer (light variant).
 */

import Image from 'next/image';

export function WaaiioMark({ className = 'h-8' }: { className?: string }) {
  return (
    <Image src="/logo.png" alt="Waaiio" width={120} height={32} className={className} priority />
  );
}

export function WaaiioWordmark({ variant = 'dark' }: { variant?: 'dark' | 'light' }) {
  // The logo.png already contains the full wordmark, so WaaiioMark alone is sufficient.
  // This component is kept for backward compatibility but renders nothing
  // since the full logo image is now used in WaaiioMark.
  return null;
}
