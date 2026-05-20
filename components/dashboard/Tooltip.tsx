'use client';

import { useState } from 'react';

interface TooltipProps {
  text: string;
  children?: React.ReactNode;
}

/**
 * Simple hover tooltip — wraps a question mark icon or custom children.
 * Shows a floating tooltip on hover with helpful text.
 */
export function Tooltip({ text, children }: TooltipProps) {
  const [show, setShow] = useState(false);

  return (
    <span
      className="relative inline-flex"
      onMouseEnter={() => setShow(true)}
      onMouseLeave={() => setShow(false)}
      onFocus={() => setShow(true)}
      onBlur={() => setShow(false)}
      onClick={() => setShow(!show)}
      tabIndex={0}
      role="button"
      aria-label="Show help tooltip"
    >
      {children || (
        <span className="inline-flex h-4 w-4 cursor-help items-center justify-center rounded-full bg-gray-200 text-[10px] font-bold text-gray-500 dark:bg-gray-700 dark:text-gray-400">
          ?
        </span>
      )}
      {show && (
        <span role="tooltip" className="absolute bottom-full left-1/2 z-50 mb-2 -translate-x-1/2 whitespace-normal rounded-lg bg-gray-900 px-3 py-2 text-xs leading-relaxed text-white shadow-lg dark:bg-gray-700" style={{ minWidth: '200px', maxWidth: '280px' }}>
          {text}
          <span className="absolute left-1/2 top-full -translate-x-1/2 border-4 border-transparent border-t-gray-900 dark:border-t-gray-700" />
        </span>
      )}
    </span>
  );
}
