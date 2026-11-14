'use client';

import { createChange, createReorder, definePrimitive, type ReorderDraft } from '@ui-sdk/core';
import { createParts } from '@ui-sdk/react/primitive';

interface OrderOptions {
  value: string[];
  onValueChange: (value: string[]) => void;
}

// Keep the beta SDK boundary here. The parent owns draft graph changes.
const blockOrder = definePrimitive({
  name: 'flow-block-order',
  options: { value: 'list', onValueChange: 'callback' },
  controlled: ['value'],
  state: (options: OrderOptions) => ({ value: options.value, moving: null as ReorderDraft | null }),
  sync: (options) => ({ value: options.value }),
  api: (context) => {
    const change = createChange(context);
    return { reorder: createReorder(context, {
      slot: 'item', key: 'value', draft: 'moving',
      set: (value, details) => change('value', value, details),
    }) };
  },
  slots: (slot) => ({
    root: slot({ state: (state, { api }) => ({ order: api.reorder.order(state) }) }),
    item: slot<{ value: string }>({
      props: { value: 'string' },
      attrs: (state, { key }) => ({ type: 'button', 'data-grabbed': state.moving?.key === key ? '' : undefined }),
      on: {
        keydown: (event, { api, key }) => { api.reorder.keydown(event, key); },
        pointerdown: (event, { api, key }) => { api.reorder.pointerdown(event, key); },
      },
      bind: (element, part) => part.api.reorder.bind(element, part),
    }),
    move: slot<{ value: string; nodeId: string; offset: number }>({
      props: { value: 'string', nodeId: 'string', offset: 'number' },
      attrs: (state, { props }) => ({
        type: 'button',
        disabled: state.moving !== null || state.value.indexOf(props.nodeId) + props.offset < 0 || state.value.indexOf(props.nodeId) + props.offset >= state.value.length ? '' : undefined,
      }),
      press: ({ api, props, store, el }) => {
        const destination = store.get().value.indexOf(props.nodeId) + props.offset;
        if (destination < 0 || destination >= store.get().value.length) return;
        if (api.reorder.grab(props.nodeId)) {
          const row = el?.parentElement;
          api.reorder.moveTo(destination);
          api.reorder.drop();
          // A boundary move disables its own control. Keep keyboard focus on
          // the moved block after React has applied the new order.
          requestAnimationFrame(() => row?.querySelector<HTMLButtonElement>('[data-slot="flow-block-order-item"]')?.focus());
        }
      },
    }),
  }),
});

const parts = createParts(blockOrder, { root: 'div', item: 'button', move: 'button' });

export function BlockOrder({ value, onValueChange, labels, instructionsId, upLabel, downLabel }: OrderOptions & {
  labels: Record<string, string>;
  instructionsId: string;
  upLabel: string;
  downLabel: string;
}) {
  return <parts.Root value={value} onValueChange={onValueChange}>
    {({ order }) => order.map((id) => <div key={id} className="mb-2 flex items-center gap-2">
      <parts.Item value={id} aria-describedby={instructionsId}
        className="min-h-12 flex-1 rounded-lg border bg-white p-3 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-purple-600 dark:bg-gray-900"
        style={{ touchAction: 'none', userSelect: 'none', transform: 'translate(var(--drag-x, 0px), var(--drag-y, 0px))' }}>
        {labels[id] ?? id}
      </parts.Item>
      <parts.Move value={`${id}:up`} nodeId={id} offset={-1} className="min-h-12 min-w-12 px-2" aria-label={`${upLabel}: ${labels[id] ?? id}`}>{upLabel}</parts.Move>
      <parts.Move value={`${id}:down`} nodeId={id} offset={1} className="min-h-12 min-w-12 px-2" aria-label={`${downLabel}: ${labels[id] ?? id}`}>{downLabel}</parts.Move>
    </div>)}
  </parts.Root>;
}
