/**
 * Waaiio brand logo components.
 * Used in Navbar (dark/light variants) and Footer (light variant).
 */

/* eslint-disable @next/next/no-img-element */

export function WaaiioMark({ className = 'h-8' }: { className?: string }) {
  return (
    <img src="/logo.png" alt="Waaiio" className={className} />
  );
}

export function WaaiioWordmark({ variant = 'dark' }: { variant?: 'dark' | 'light' }) {
  // The logo.png already contains the full wordmark, so WaaiioMark alone is sufficient.
  // This component is kept for backward compatibility but renders nothing
  // since the full logo image is now used in WaaiioMark.
  return null;
}
