'use client';

import { useId, useState, type ReactNode, type SVGProps } from 'react';

/** Shared look for the Custom Flow builder (#1079). Brand tokens come from tailwind.config.ts. */
export const inputClass = 'mt-1 min-h-11 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 placeholder:text-gray-500 transition-shadow duration-150 focus:border-brand focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/30 read-only:bg-gray-50 motion-reduce:transition-none dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100 dark:placeholder:text-gray-400 dark:read-only:bg-gray-800';
export const buttonClass = 'min-h-11 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-800 transition-colors duration-150 hover:bg-gray-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:opacity-40 motion-reduce:transition-none dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100 dark:hover:bg-gray-700';
export const cardClass = 'rounded-2xl border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-700 dark:bg-gray-800 sm:p-5';
/** Soft lavender panel used by the palette and the preview column. */
export const lavenderClass = 'rounded-2xl border border-brand-100 bg-brand-50 p-4 dark:border-brand-900 dark:bg-brand-900/30 sm:p-5';

/** Drag data types. Only the builder reads them; nothing is stored. */
export const NEW_STEP_TYPE = 'application/x-waaiio-new-step';
export const MOVE_STEP_TYPE = 'application/x-waaiio-move-step';
export function hasDragType(types: ArrayLike<string> | null | undefined, type: string) {
  return !!types && Array.from(types).includes(type);
}

type IconProps = SVGProps<SVGSVGElement>;
function Svg(props: IconProps & { children: ReactNode }) {
  return <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" width={18} height={18} {...props} />;
}
export const Icons = {
  message: (p: IconProps) => <Svg {...p}><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12Z" /></Svg>,
  menu: (p: IconProps) => <Svg {...p}><rect x="4" y="4" width="16" height="5" rx="2" /><rect x="4" y="11" width="16" height="5" rx="2" /><path d="M8 20h8" /></Svg>,
  lookup: (p: IconProps) => <Svg {...p}><circle cx="11" cy="11" r="6" /><path d="m20 20-4.5-4.5" /></Svg>,
  ask: (p: IconProps) => <Svg {...p}><circle cx="12" cy="12" r="9" /><path d="M9.5 9.5a2.5 2.5 0 0 1 4.8 1c0 1.7-2.3 2-2.3 3.5" /><path d="M12 17h.01" /></Svg>,
  choice: (p: IconProps) => <Svg {...p}><circle cx="12" cy="12" r="9" /><path d="m8 12 3 3 5-6" /></Svg>,
  ticket: (p: IconProps) => <Svg {...p}><path d="M4 7h16v3a2 2 0 0 0 0 4v3H4v-3a2 2 0 0 0 0-4Z" /><path d="M14 7v10" strokeDasharray="2 2" /></Svg>,
  giving: (p: IconProps) => <Svg {...p}><path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10Z" /></Svg>,
  payment: (p: IconProps) => <Svg {...p}><rect x="3" y="6" width="18" height="12" rx="2" /><path d="M3 10h18M7 15h3" /></Svg>,
  person: (p: IconProps) => <Svg {...p}><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></Svg>,
  grip: (p: IconProps) => <Svg {...p}><path d="M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01" strokeWidth={3} /></Svg>,
  play: (p: IconProps) => <Svg {...p}><path d="M7 5v14l11-7Z" fill="currentColor" /></Svg>,
};

/**
 * "?" help. The tip stays in the page for screen readers (linked with
 * aria-describedby) and shows on hover, focus or tap; Escape hides it.
 */
export function HelpTip({ id, label, text }: { id: string; label: string; text: string }) {
  const [open, setOpen] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const visible = dismissed ? 'invisible opacity-0' : open ? 'visible opacity-100' : 'invisible opacity-0 group-hover:visible group-hover:opacity-100 group-focus-within:visible group-focus-within:opacity-100';
  return <span className="group relative inline-flex" onMouseEnter={() => setDismissed(false)}
    onKeyDown={event => { if (event.key === 'Escape') { setDismissed(true); setOpen(false); } }}>
    <button type="button" aria-label={`More about ${label}`} aria-describedby={id} onClick={() => { setDismissed(false); setOpen(value => !value); }} onBlur={() => { setOpen(false); setDismissed(false); }}
      className="-my-3 inline-flex min-h-11 min-w-11 items-center justify-center rounded-full focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-4 focus-visible:outline-brand">
      <span aria-hidden="true" className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-brand-100 text-xs font-bold text-brand-700 dark:bg-brand-900 dark:text-brand-100">?</span>
    </button>
    <span role="tooltip" id={id} className={`absolute bottom-full left-1/2 z-30 mb-1 w-64 max-w-[80vw] -translate-x-1/2 rounded-lg bg-gray-900 px-3 py-2 text-xs font-normal leading-relaxed text-white shadow-lg transition-opacity duration-150 motion-reduce:transition-none dark:bg-gray-700 ${visible}`}>{text}</span>
  </span>;
}

export interface FieldControlProps { id: string; 'aria-describedby': string }

/** Label, "?" help and the control. The label stays outside the tip so its accessible name is just the label. */
export function Field({ label, help, children }: { label: string; help: string; children: (props: FieldControlProps, extra: { labelId: string }) => ReactNode }) {
  const id = useId();
  const tipId = `${id}-tip`;
  return <div className="block min-w-0">
    <div className="flex items-center gap-1">
      <label id={`${id}-label`} htmlFor={id} className="text-sm font-medium text-gray-800 dark:text-gray-200">{label}</label>
      <HelpTip id={tipId} label={label} text={help} />
    </div>
    {children({ id, 'aria-describedby': tipId }, { labelId: `${id}-label` })}
  </div>;
}
