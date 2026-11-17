'use client';

import { useEffect, useState } from 'react';

/** First-time tour (#1079). Remembered per browser; storage failures just show it again. */
export const WALKTHROUGH_KEY = 'waaiio.customFlows.walkthrough.v1';
const STEPS = [
  { title: 'Add your list', text: 'Put your details, like your program or menu, in a list under Your lists. People search it on WhatsApp.' },
  { title: 'Try it in the phone', text: 'Select Try it and chat with your flow like a customer would. Nothing is sent to anyone.' },
  { title: 'Save, then make it live', text: 'When it looks right, select Save and then Go live. People can then start it with your word.' },
];

function seen(): boolean {
  try { return window.localStorage.getItem(WALKTHROUGH_KEY) === 'done'; } catch { return false; }
}
function remember() {
  try { window.localStorage.setItem(WALKTHROUGH_KEY, 'done'); } catch { /* private mode: show again next time */ }
}

export function Walkthrough() {
  // Read storage after mount so server and first client render match.
  const [show, setShow] = useState(false);
  const [step, setStep] = useState(0);
  useEffect(() => { setShow(!seen()); }, []);
  if (!show) return null;
  const close = () => { remember(); setShow(false); };
  const current = STEPS[step];
  return <section aria-label="Quick tour" className="motion-safe:animate-fade-in-up rounded-2xl border border-brand-200 bg-white p-4 shadow-sm dark:border-brand-800 dark:bg-gray-800">
    <div className="flex flex-wrap items-start gap-4">
      <span aria-hidden="true" className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-brand text-base font-bold text-white">{step + 1}</span>
      <div className="min-w-0 flex-1">
        <p className="text-xs font-semibold uppercase tracking-wide text-brand-700 dark:text-brand-200">Quick tour · Step {step + 1} of {STEPS.length}</p>
        <h2 className="font-semibold text-gray-900 dark:text-gray-100">{current.title}</h2>
        <p className="mt-1 text-sm text-gray-700 dark:text-gray-300">{current.text}</p>
      </div>
      <div className="flex flex-wrap gap-2">
        {step > 0 && <button type="button" onClick={() => setStep(step - 1)} className="min-h-11 rounded-lg border border-gray-300 px-3 text-sm font-medium text-gray-800 hover:bg-gray-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand dark:border-gray-600 dark:text-gray-100 dark:hover:bg-gray-700">Back</button>}
        {step < STEPS.length - 1
          ? <button type="button" onClick={() => setStep(step + 1)} className="min-h-11 rounded-lg bg-brand px-4 text-sm font-semibold text-white hover:bg-brand-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand">Next tip</button>
          : <button type="button" onClick={close} className="min-h-11 rounded-lg bg-brand px-4 text-sm font-semibold text-white hover:bg-brand-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand">Got it</button>}
        <button type="button" onClick={close} className="min-h-11 rounded-lg px-3 text-sm font-medium text-gray-700 underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand dark:text-gray-300">Skip tour</button>
      </div>
    </div>
  </section>;
}
