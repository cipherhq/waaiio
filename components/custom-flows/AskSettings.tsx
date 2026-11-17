'use client';

import type { ReactNode } from 'react';
import type { CustomFlowAskNode } from '@/lib/bot/custom-flow/types';
import { DEFAULT_RETRY } from '@/lib/bot/custom-flow/answers';
import { formatFullDate, upcomingDateOptions } from '@/lib/bot/custom-flow/dates';
import { Field, HelpTip, buttonClass, inputClass, type FieldControlProps } from './ui';

/**
 * Settings for an "Ask a question" step (#1085). Every field has a "?" tip
 * and an example. Answers are saved privately on the Flow answers page.
 */
const QUESTION_EXAMPLE: Record<CustomFlowAskNode['answer_type'], string> = {
  yes_no: 'Example: Will you need a room for the night?',
  choice: 'Example: Which meal would you like?',
  date: 'Example: Which day will you arrive?',
  text: 'Example: What is your full name?',
  file: 'Example: Please send a photo of your ID.',
};

export function AskSettings({ node, timezone, country, onChange, destination }: {
  node: CustomFlowAskNode;
  /** The flow's time zone, for the date list preview. */
  timezone: string;
  country?: string | null;
  onChange: (node: CustomFlowAskNode) => void;
  destination: (props: FieldControlProps) => ReactNode;
}) {
  const options = node.options ?? [];
  // Three or fewer choices show as WhatsApp buttons (20 letters); more show as a list (24).
  const choiceMax = options.length <= 3 ? 20 : 24;
  const dateContext = { timezone, language: 'en', country: country ?? 'GB' };
  const dates = node.answer_type === 'date' ? upcomingDateOptions(dateContext) : [];
  return <>
    <Field label="Question" help="What you ask. People's answers are saved on your Flow answers page.">
      {props => <textarea {...props} className={inputClass} rows={2} placeholder={QUESTION_EXAMPLE[node.answer_type]} value={node.question} onChange={event => onChange({ ...node, question: event.target.value })} />}
    </Field>

    {node.answer_type === 'yes_no' && <p className="text-sm text-gray-700 dark:text-gray-300">People get two buttons: <span className="font-semibold">Yes</span> and <span className="font-semibold">No</span>.</p>}

    {node.answer_type === 'choice' && <div className="space-y-2">
      <h4 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Choices</h4>
      <p className="text-xs text-gray-600 dark:text-gray-400">Add 2 to 10. Up to 3 show as buttons; more show as a list people open.</p>
      {options.map((option, index) => <div key={index} className="flex items-end gap-2">
        <div className="min-w-0 flex-1">
          <Field label={`Choice ${index + 1}`} help={`The words people tap. Up to ${choiceMax} letters: buttons hold 20, a list of 4 or more choices holds 24.`}>
            {props => <input {...props} className={inputClass} maxLength={choiceMax} placeholder={index === 0 ? 'Example: Jollof rice' : 'Example: Vegetarian'} value={option}
              onChange={event => onChange({ ...node, options: options.map((item, i) => i === index ? event.target.value : item) })} />}
          </Field>
        </div>
        <button type="button" className={buttonClass} aria-label={`Remove choice ${index + 1}`} onClick={() => onChange({ ...node, options: options.filter((_, i) => i !== index) })}>Remove</button>
      </div>)}
      <button type="button" className={buttonClass} disabled={options.length >= 10} onClick={() => onChange({ ...node, options: [...options, ''] })}>Add a choice</button>
    </div>}

    {node.answer_type === 'date' && <div className="space-y-3">
      <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm text-gray-900 dark:border-emerald-800 dark:bg-emerald-900/20 dark:text-gray-100">
        <p className="font-medium">People pick from the next 7 days:</p>
        <ul aria-label="Date choices people see" className="mt-2 flex flex-wrap gap-1.5">
          {dates.map(row => <li key={row.id} className="rounded-full border border-emerald-300 bg-white px-2.5 py-0.5 text-xs font-medium dark:border-emerald-700 dark:bg-gray-900">{row.title}</li>)}
        </ul>
        <p className="mt-2 text-xs text-gray-700 dark:text-gray-300">“Another date” lets them type one, like 21 Nov 2026. We confirm it in full, for example “✅ {formatFullDate(dates[0]?.id.slice(5) ?? '2026-11-21', dateContext)}”.</p>
      </div>
      <div className="flex items-start gap-1">
        <label className="flex min-h-11 items-start gap-2 text-sm text-gray-800 dark:text-gray-200">
          <input type="checkbox" className="mt-1 h-5 w-5 rounded border-gray-300 text-brand focus:ring-brand" checked={!!node.allow_past} aria-describedby={`allow-past-tip-${node.id}`}
            onChange={event => onChange({ ...node, allow_past: event.target.checked || undefined })} />
          <span>Allow dates before today<span className="block text-xs text-gray-600 dark:text-gray-400">Turn this on for things like a date of birth. Otherwise only today or later is accepted.</span></span>
        </label>
        <HelpTip id={`allow-past-tip-${node.id}`} label="Allow dates before today" text="Example: “When is your birthday?” needs past dates. “Which day will you arrive?” does not." />
      </div>
    </div>}

    {node.answer_type === 'file' && <p className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm text-gray-900 dark:border-emerald-800 dark:bg-emerald-900/20 dark:text-gray-100">
      People can send a photo (JPG, PNG or WebP) or a PDF, up to 10 MB. Files are stored privately and open from your Flow answers page. Try it can’t send files; test this step on WhatsApp.
    </p>}

    {/* A box that wraps, so the example message is never cut off (#1079 polish). */}
    <Field label="If the answer can’t be used (optional)" help="What we send when the answer isn’t one we can save, before asking again. Leave it empty to use our message.">
      {props => <textarea {...props} className={inputClass} rows={2} placeholder={`Example: ${DEFAULT_RETRY[node.answer_type]}`} value={node.retry_message ?? ''}
        onChange={event => onChange({ ...node, retry_message: event.target.value || undefined })} />}
    </Field>
    <Field label="Then go to" help="Where people go after answering. End the chat stops the flow here.">
      {props => destination(props)}
    </Field>
    <p className="text-xs text-gray-600 dark:text-gray-400">Only you and your team can see answers. They are deleted automatically after 12 months. See them on <a className="font-semibold text-brand underline-offset-2 hover:underline dark:text-brand-300" href="/dashboard/custom-flows/responses">Flow answers</a>.</p>
  </>;
}
