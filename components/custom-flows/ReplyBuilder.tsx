'use client';

import { useLayoutEffect, useRef, type KeyboardEvent } from 'react';
import type { DataColumn } from '@/lib/bot/custom-flow/data';
import { fieldLabel, fieldToken, fillExample, parseReply } from '@/lib/custom-flow-builder/reply-template';

/**
 * Reply text with details shown as chips ("Name", "Day") instead of
 * {{column}} tokens (#1079). The stored value is still the same template
 * text: every chip keeps its token's original spelling, so an unedited
 * reply saves back byte for byte. DOM is built with text nodes only; the
 * merchant's text is never parsed as HTML.
 */
function chip(key: string, raw: string, columns: DataColumn[]) {
  const element = document.createElement('span');
  element.contentEditable = 'false';
  element.dataset.raw = raw;
  element.dataset.key = key;
  element.textContent = fieldLabel(key, columns);
  element.className = 'mx-0.5 inline-block rounded-full bg-brand-100 px-2 py-0.5 text-xs font-semibold text-brand-800 dark:bg-brand-800 dark:text-brand-50';
  return element;
}
function filler() { const br = document.createElement('br'); br.dataset.filler = ''; return br; }

/** Read the template back from the editor. */
export function serializeReply(root: Node): string {
  let out = '';
  root.childNodes.forEach((child, index) => {
    if (child.nodeType === Node.TEXT_NODE) { out += (child as Text).data; return; }
    if (!(child instanceof HTMLElement)) return;
    if (child.dataset.raw !== undefined) out += child.dataset.raw;
    else if (child.tagName === 'BR') {
      // Our own end-of-text filler, or the browser's placeholder line break, adds nothing.
      if (child.dataset.filler === undefined && !(root === child.parentNode && index === root.childNodes.length - 1)) out += '\n';
    } else {
      if ((child.tagName === 'DIV' || child.tagName === 'P') && index > 0) out += '\n';
      out += serializeReply(child);
    }
  });
  return out;
}

function render(root: HTMLElement, value: string, columns: DataColumn[]) {
  const nodes: Node[] = parseReply(value).map(segment => segment.kind === 'text' ? document.createTextNode(segment.text) : chip(segment.key, segment.raw, columns));
  if (value.endsWith('\n')) nodes.push(filler());
  root.replaceChildren(...nodes);
}

export function ReplyBuilder({ id, labelId, describedBy, value, columns, example, placeholder, disabled = false, onChange }: {
  id: string;
  labelId: string;
  describedBy: string;
  value: string;
  columns: DataColumn[];
  /** Values from the first real row of the list; null when the list has none yet. */
  example: Record<string, unknown> | null;
  placeholder: string;
  /** While a request runs, like the disabled fieldset around the other fields. */
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  const editor = useRef<HTMLDivElement>(null);
  const shown = useRef<string | null>(null);
  const saved = useRef<Range | null>(null);
  const labels = columns.map(column => `${column.name}:${column.label ?? ''}`).join('|');

  useLayoutEffect(() => {
    // Rebuild only when the value changed outside this editor (or labels did).
    const key = `${value}\u0000${labels}`;
    if (!editor.current || shown.current === key) return;
    render(editor.current, value, columns);
    shown.current = key;
  }, [value, labels, columns]);

  function emit() {
    const root = editor.current!;
    if (root.lastChild?.nodeType === Node.TEXT_NODE && (root.lastChild as Text).data.endsWith('\n')) root.appendChild(filler());
    const next = serializeReply(root);
    shown.current = `${next}\u0000${labels}`;
    if (next !== value) onChange(next);
  }
  function remember() {
    const selection = typeof window.getSelection === 'function' ? window.getSelection() : null;
    if (selection?.rangeCount && editor.current?.contains(selection.getRangeAt(0).commonAncestorContainer)) saved.current = selection.getRangeAt(0).cloneRange();
  }
  function insert(node: Node) {
    const root = editor.current!;
    let range = saved.current && root.contains(saved.current.commonAncestorContainer) ? saved.current : null;
    if (!range) {
      range = document.createRange();
      const last = root.lastChild as HTMLElement | null;
      // Insert before the end-of-text filler so it stays last.
      if (last?.dataset?.filler !== undefined && last?.tagName === 'BR') range.setStartBefore(last); else range.selectNodeContents(root);
      range.collapse(false);
    }
    range.deleteContents();
    range.insertNode(node);
    range.setStartAfter(node);
    range.collapse(true);
    saved.current = range.cloneRange();
    const selection = typeof window.getSelection === 'function' ? window.getSelection() : null;
    if (selection && document.activeElement === root) { selection.removeAllRanges(); selection.addRange(range); }
    emit();
  }
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Enter') { event.preventDefault(); remember(); insert(document.createTextNode('\n')); }
  }
  const keys = columns.map(column => column.name);
  const filled = example ? fillExample(value, example).trim() : '';

  return <div className="space-y-2">
    <div ref={editor} id={id} role="textbox" aria-multiline="true" aria-labelledby={labelId} aria-describedby={describedBy}
      contentEditable={!disabled} aria-disabled={disabled || undefined} suppressContentEditableWarning data-placeholder={placeholder}
      onInput={emit} onKeyDown={onKeyDown} onKeyUp={remember} onMouseUp={remember} onBlur={remember}
      onDrop={event => event.preventDefault()}
      onPaste={event => { event.preventDefault(); remember(); insert(document.createTextNode(event.clipboardData.getData('text/plain'))); }}
      className="mt-1 min-h-[5.5rem] w-full whitespace-pre-wrap break-words rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm leading-7 text-gray-900 empty:before:text-gray-500 empty:before:content-[attr(data-placeholder)] focus:border-brand focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/30 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100 dark:empty:before:text-gray-400" />
    <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Insert a detail from your list">
      <span className="text-xs font-semibold text-gray-700 dark:text-gray-300">Insert:</span>
      {keys.length === 0 && <span className="text-xs text-gray-600 dark:text-gray-400">Choose a list above to insert its details.</span>}
      {keys.map(key => <button key={key} type="button" aria-label={`Insert ${fieldLabel(key, columns)}`}
        onMouseDown={event => event.preventDefault()} onClick={() => insert(chip(key, fieldToken(key), columns))}
        className="min-h-11 rounded-full border border-brand-200 bg-white px-3 text-xs font-semibold text-brand-700 transition-colors duration-150 hover:bg-brand-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand dark:focus-visible:outline-brand-300 motion-reduce:transition-none dark:border-brand-700 dark:bg-gray-900 dark:text-brand-100 dark:hover:bg-brand-900/50">
        + {fieldLabel(key, columns)}
      </button>)}
    </div>
    <div className="rounded-lg bg-[#DCF8C6] px-3 py-2 text-sm text-gray-900 dark:bg-[#005C4B] dark:text-gray-50">
      <p className="text-xs font-semibold text-gray-700 dark:text-gray-200">Example reply</p>
      <p data-testid="reply-example" className="whitespace-pre-wrap break-words">{example ? filled || 'Your reply is empty so far.' : 'Add a row to this list to see an example reply.'}</p>
    </div>
  </div>;
}
