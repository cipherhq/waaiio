/**
 * Waaiio brand logo — WhatsApp-style chat bubble with three dots inside.
 * Used in Navbar (dark text) and Footer (light text).
 */
export function WaaiioMark({ className = 'h-8 w-8' }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 100 100"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
    >
      {/* Chat bubble circle */}
      <path
        d="M50 5C25.2 5 5 23.4 5 46c0 8.4 2.8 16.2 7.6 22.6L5 95l22.4-8.4C33.6 89.4 41.6 91 50 91c24.8 0 45-18.4 45-41S74.8 5 50 5z"
        fill="#25D366"
      />
      {/* Three dots */}
      <circle cx="30" cy="48" r="6" fill="white" />
      <circle cx="50" cy="48" r="6" fill="white" />
      <circle cx="70" cy="48" r="6" fill="white" />
    </svg>
  );
}

export function WaaiioWordmark({ variant = 'dark' }: { variant?: 'dark' | 'light' }) {
  return (
    <span className="text-lg font-bold tracking-tight">
      <span className="text-[#25D366]">wa</span>
      <span className="text-[#E5993E]">ai</span>
      <span className="text-[#B5A3E0]">io</span>
    </span>
  );
}
