/**
 * Waaiio brand logo — WhatsApp-style chat bubble with AI sparkle inside.
 * Used in Navbar (dark text) and Footer (light text).
 */
export function WaaiioMark({ className = 'h-8 w-8' }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 40 40"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
    >
      {/* Chat bubble body */}
      <rect x="2" y="2" width="36" height="30" rx="10" fill="#25D366" />
      {/* Speech tail */}
      <path d="M8 32 L4 39 L14 32" fill="#25D366" />
      {/* AI sparkle — 4-point star */}
      <path
        d="M20 10 L21.8 16.2 L28 18 L21.8 19.8 L20 26 L18.2 19.8 L12 18 L18.2 16.2 Z"
        fill="white"
        opacity="0.95"
      />
    </svg>
  );
}

export function WaaiioWordmark({ variant = 'dark' }: { variant?: 'dark' | 'light' }) {
  return (
    <span className="text-lg font-bold tracking-tight">
      <span className="text-[#25D366]">wa</span>
      <span className={variant === 'dark' ? 'text-accent-600' : 'text-accent'}>ai</span>
      <span className={variant === 'dark' ? 'text-brand' : 'text-brand-300'}>io</span>
    </span>
  );
}
