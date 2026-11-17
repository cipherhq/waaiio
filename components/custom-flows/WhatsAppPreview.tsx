'use client';

import type { ReactNode, RefObject } from 'react';
import type { PreviewMessage } from '@/lib/custom-flow-builder/preview';
import type { LivePreview, LiveMessage } from '@/lib/custom-flow-builder/live-preview';

/**
 * Presentational WhatsApp-style phone for the Custom Flow draft preview.
 * FlowBuilder owns every request and all state; this component only renders
 * the transcript it is given and reports clicks back. Nothing here sends a
 * WhatsApp message. With no test chat running it shows the live preview
 * (#1079 polish): what the draft sends, worked out in the browser.
 */
export function WhatsAppPreview({
  title, messages, live, lastInputIndex, busy, previewBusy, canRestart, reply, transcriptRef, feedback,
  onRestart, onOption, onReplyChange, onReplySubmit,
}: {
  title: string;
  messages: PreviewMessage[];
  /** Shown while no test chat is running; updates as the draft changes. */
  live?: LivePreview | null;
  /** Index of the latest customer input; option buttons at or before it are history. */
  lastInputIndex: number;
  /** Any builder request is running: preview inputs stay disabled. */
  busy: boolean;
  /** A preview request is running: announced on the preview region only. */
  previewBusy: boolean;
  canRestart: boolean;
  reply: string;
  transcriptRef: RefObject<HTMLDivElement | null>;
  feedback?: ReactNode;
  onRestart: () => void;
  onOption: (messageIndex: number, value: string) => void;
  onReplyChange: (value: string) => void;
  onReplySubmit: () => void;
}) {
  const initial = title.trim().charAt(0).toUpperCase() || 'W';
  const showLive = messages.length === 0 && !!live;
  return <aside aria-busy={previewBusy} className="h-fit space-y-3 rounded-2xl border border-brand-100 bg-brand-50 p-4 shadow-sm dark:border-brand-900 dark:bg-brand-900/30">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h2 className="flex items-center gap-2 font-semibold text-gray-900 dark:text-gray-100">
        What people see on WhatsApp
        {previewBusy && <span aria-hidden="true" className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-current border-r-transparent motion-reduce:animate-none" />}
      </h2>
      <button type="button" disabled={!canRestart} onClick={onRestart}
        className="min-h-11 rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium text-gray-800 hover:bg-gray-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand dark:focus-visible:outline-brand-300 disabled:opacity-40 dark:border-gray-600 dark:text-gray-100 dark:hover:bg-gray-700">
        Restart preview
      </button>
    </div>
    <p className="text-sm text-gray-600 dark:text-gray-400">Only you see this. Nothing is sent.</p>
    <p className="text-xs font-semibold uppercase tracking-wide text-brand-700 dark:text-brand-200">{showLive ? live!.label : 'Test chat'}</p>
    {feedback}
    <div className="mx-auto max-w-sm overflow-hidden rounded-[2rem] border-[6px] border-gray-900 bg-gray-900 shadow-xl ring-1 ring-brand-200 dark:border-gray-950 dark:ring-brand-800">
      <div aria-hidden="true" className="flex justify-center bg-gray-900 pb-1"><span className="h-1.5 w-16 rounded-full bg-gray-700" /></div>
      <div className="flex items-center gap-3 bg-[#075E54] px-4 py-3">
        <div aria-hidden="true" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white/20 text-sm font-bold text-white">{initial}</div>
        <div className="min-w-0">
          <p className="break-words text-sm font-semibold text-white">{title}</p>
          <p className="text-xs text-green-100">{previewBusy ? 'typing…' : showLive ? 'Live preview' : 'Test chat'}</p>
        </div>
      </div>
      {/* Only this transcript scrolls; FlowBuilder sets scrollTop without moving focus. */}
      <div ref={transcriptRef} aria-live="polite"
        className="h-96 space-y-2 overflow-y-auto overscroll-contain bg-[#ECE5DD] p-3 dark:bg-[#0B141A] xl:h-[28rem]">
        {/* Live preview changes on every keystroke: kept out of the polite announcements. */}
        {showLive && <div aria-live="off" data-testid="live-preview" className="space-y-2">
          {live!.messages.length === 0 && <p className="mx-auto mt-6 max-w-[16rem] rounded-lg bg-[#FFF5C4] px-3 py-2 text-center text-xs text-gray-800 dark:bg-[#1F2C33] dark:text-gray-200">Add a step to see it here.</p>}
          {live!.messages.map((message, index) => <LiveBubble key={index} message={message} />)}
          <p className="mx-auto max-w-[16rem] rounded-lg bg-[#FFF5C4] px-3 py-2 text-center text-xs text-gray-800 dark:bg-[#1F2C33] dark:text-gray-200">Select Try it to chat with it.</p>
        </div>}
        {messages.length === 0 && !live && <p className="mx-auto mt-6 max-w-[16rem] rounded-lg bg-[#FFF5C4] px-3 py-2 text-center text-xs text-gray-800 dark:bg-[#1F2C33] dark:text-gray-200">Select Try it to chat with your flow like a customer.</p>}
        {messages.map((message, index) => {
          const history = index <= lastInputIndex;
          // A builder note (#1086): where a handoff step passes people on. Not a chat bubble.
          if (message.note) return <p key={index} className="mx-auto max-w-[90%] rounded-lg bg-[#FFF5C4] px-3 py-2 text-center text-xs font-medium text-gray-900 dark:bg-[#1F2C33] dark:text-gray-100">{message.text}</p>;
          return <div key={index} className={`flex ${message.input ? 'justify-end' : 'justify-start'}`}>
            <div className="max-w-[85%] min-w-0">
              <div className={`rounded-lg px-3 py-2 text-sm shadow-sm ${message.input
                ? 'rounded-tr-none bg-[#DCF8C6] text-gray-900 dark:bg-[#005C4B] dark:text-gray-50'
                : 'rounded-tl-none bg-white text-gray-900 dark:bg-[#202C33] dark:text-gray-100'}`}>
                {/* Merchant-provided preview image; avoid a server-side image fetch. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                {message.image && <img src={message.image} alt="" className="mb-2 max-h-64 w-full rounded-md object-contain" />}
                <p className="whitespace-pre-wrap break-words">{message.text}</p>
              </div>
              {message.options && message.options.length > 0 && <div className="mt-1 space-y-1">
                {message.options.map(option => <button key={option.value} type="button" disabled={busy || history}
                  onClick={() => onOption(index, option.value)}
                  className="block min-h-11 w-full rounded-lg bg-white px-3 py-2 text-center text-sm font-medium text-[#00796B] shadow-sm hover:bg-emerald-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[#00796B] disabled:cursor-not-allowed disabled:opacity-50 dark:bg-[#202C33] dark:text-[#53BDEB] dark:hover:bg-[#2A3942]">
                  {option.label}
                </button>)}
              </div>}
            </div>
          </div>;
        })}
      </div>
      <form className="flex items-end gap-2 bg-[#F0F2F5] px-2 py-2 dark:bg-[#1F2C33]"
        onSubmit={event => { event.preventDefault(); if (reply.trim()) onReplySubmit(); }}>
        <label className="min-w-0 flex-1">
          <span className="sr-only">Message</span>
          <input value={reply} onChange={event => onReplyChange(event.target.value)} disabled={busy || !messages.length}
            placeholder="Type a message"
            className="min-h-11 w-full rounded-full border border-transparent bg-white px-4 py-2 text-sm text-gray-900 placeholder:text-gray-500 focus:border-[#00796B] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#00796B] disabled:opacity-60 dark:bg-[#2A3942] dark:text-gray-100 dark:placeholder:text-gray-400" />
        </label>
        <button disabled={busy || !messages.length || !reply.trim()}
          className="flex min-h-11 shrink-0 items-center gap-1 rounded-full bg-[#00796B] px-4 text-sm font-semibold text-white hover:bg-[#00695C] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#00796B] disabled:opacity-40">
          Send
        </button>
      </form>
    </div>
  </aside>;
}

const chipClass = 'min-h-11 w-full rounded-lg bg-white px-3 py-2 text-center text-sm font-medium text-[#00796B] shadow-sm break-words dark:bg-[#202C33] dark:text-[#53BDEB]';

/** One bot message of the live preview. Options are shown, not tappable: Try it is the interactive chat. */
function LiveBubble({ message }: { message: LiveMessage }) {
  // The arrow marks a builder note (where people are passed on), not a WhatsApp message.
  if (message.note) return <p className="mx-auto max-w-[90%] rounded-lg bg-[#FFF5C4] px-3 py-2 text-center text-xs font-medium text-gray-900 dark:bg-[#1F2C33] dark:text-gray-100">{`↪ ${message.text}`}</p>;
  const options = message.options ?? [];
  return <div className="flex justify-start">
    <div className="max-w-[85%] min-w-0">
      <div className="rounded-lg rounded-tl-none bg-white px-3 py-2 text-sm text-gray-900 shadow-sm dark:bg-[#202C33] dark:text-gray-100">
        {/* Merchant-provided picture link, as in the test chat. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        {message.image && <img src={message.image} alt="" className="mb-2 max-h-64 w-full rounded-md object-contain" />}
        {message.text.trim()
          ? <p className="whitespace-pre-wrap break-words">{message.text}</p>
          : <p className="italic text-gray-600 dark:text-gray-300">No text yet</p>}
      </div>
      {message.listButton && <p className={`mt-1 ${chipClass}`}><span aria-hidden="true">☰ </span>{message.listButton}</p>}
      {options.length > 0 && <ul aria-label={message.listButton ? 'List choices' : 'Buttons'} className={`mt-1 space-y-1 ${message.listButton ? 'rounded-lg bg-white/60 p-1 dark:bg-black/20' : ''}`}>
        {options.map((option, index) => <li key={index} className={chipClass}>
          {option.label.trim() || <span className="italic">Untitled button</span>}
        </li>)}
      </ul>}
      {message.shortenedTo && <p className="mt-1 rounded-lg bg-[#FFF5C4] px-3 py-1.5 text-xs text-gray-900 dark:bg-[#1F2C33] dark:text-gray-100">WhatsApp shows the first {message.shortenedTo} letters of each choice.</p>}
    </div>
  </div>;
}
