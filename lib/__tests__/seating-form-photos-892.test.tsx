// @vitest-environment jsdom
/**
 * #892 — optional photos (max 3) on the Tables & Sections form.
 * Renders the real Seating page; only the Supabase client, the upload fetch
 * and next/image are replaced.
 */
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const U = (n: number) => `https://x.supabase.co/storage/v1/object/public/business-documents/business-1/seating/${n}.jpg`;

const state = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  writes: [] as Array<{ op: 'insert' | 'update'; payload: Record<string, unknown>; id?: unknown }>,
}));

vi.mock('next/image', () => ({
  // eslint-disable-next-line @next/next/no-img-element, jsx-a11y/alt-text
  default: (props: Record<string, unknown>) => <img {...(props as React.ImgHTMLAttributes<HTMLImageElement>)} />,
}));
vi.mock('@/components/dashboard/DashboardProvider', () => ({
  useBusiness: () => ({ id: 'business-1', country_code: 'NG' }),
}));
vi.mock('@/components/dashboard/PageHelp', () => ({ PageHelp: () => null }));
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    from: (table: string) => {
      if (table !== 'seating_resources') throw new Error(`Unexpected table ${table}`);
      let pendingUpdate: Record<string, unknown> | null = null;
      const query = {
        select: () => query,
        eq: (_col: string, val: unknown) => {
          if (pendingUpdate) { state.writes.push({ op: 'update', payload: pendingUpdate, id: val }); pendingUpdate = null; }
          return query;
        },
        order: () => query,
        then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
          Promise.resolve({ data: state.rows, error: null }).then(resolve, reject),
        insert: async (payload: Record<string, unknown>) => {
          state.writes.push({ op: 'insert', payload });
          return { error: null };
        },
        update: (payload: Record<string, unknown>) => { pendingUpdate = payload; return query; },
      };
      return query;
    },
  }),
}));

import SeatingPage from '@/app/dashboard/seating/page';

let uploadCount = 0;
let uploadFails = false;
const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
  if (url !== '/api/seating-resources/upload-image') throw new Error(`Unexpected fetch ${url}`);
  const body = init?.body as FormData;
  expect(body.get('business_id')).toBe('business-1');
  if (uploadFails) return { json: async () => ({ error: 'Image must be under 5MB' }) } as Response;
  uploadCount += 1;
  return { json: async () => ({ success: true, url: U(uploadCount) }) } as Response;
});

const seat = (extra: Record<string, unknown> = {}) => ({
  id: 'seat-1', name: 'VIP Area', resource_type: 'vip_area', capacity: 6, min_party_size: 2, section: 'Rooftop',
  reservation_duration_minutes: 90, deposit_amount: 0, is_active: true, sort_order: 0, description: null,
  available_days: null, available_from: null, available_to: null, ...extra,
});

function photoInput(container: HTMLElement) {
  return container.querySelector<HTMLInputElement>('input[type="file"]')!;
}
async function addPhoto(container: HTMLElement) {
  const file = new File([new Uint8Array([0xff, 0xd8, 0xff])], 'p.jpg', { type: 'image/jpeg' });
  fireEvent.change(photoInput(container), { target: { files: [file] } });
}
const shownPhotos = () => screen.queryAllByRole('img').map(i => i.getAttribute('src'));

beforeEach(() => {
  state.rows = [];
  state.writes = [];
  uploadCount = 0;
  uploadFails = false;
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

async function openAdd() {
  const view = render(<SeatingPage />);
  fireEvent.click(await screen.findByRole('button', { name: '+ Add Seating' }));
  await screen.findByRole('heading', { name: 'Add Seating' });
  fireEvent.change(screen.getByPlaceholderText(/Table 1/), { target: { value: 'VIP Area' } });
  return view;
}

describe('#892 B3 Tables & Sections photos', () => {
  it('photos are optional: a seat saved without photos sends gallery_urls []', async () => {
    await openAdd();
    expect(screen.getByText('Photos (optional)')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Add Seating' }));
    await waitFor(() => expect(state.writes).toHaveLength(1));
    expect(state.writes[0]).toMatchObject({ op: 'insert', payload: { name: 'VIP Area', gallery_urls: [] } });
  });

  it('adds photos through the seating upload route and saves them; the add button goes away at 3', async () => {
    const { container } = await openAdd();
    for (let i = 1; i <= 3; i++) {
      await addPhoto(container);
      await waitFor(() => expect(shownPhotos()).toHaveLength(i));
    }
    expect(shownPhotos()).toEqual([U(1), U(2), U(3)]);
    expect(screen.queryByRole('button', { name: 'Add photo' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Add Seating' }));
    await waitFor(() => expect(state.writes).toHaveLength(1));
    expect(state.writes[0].payload.gallery_urls).toEqual([U(1), U(2), U(3)]);
  });

  it('edit shows the saved photos; removing one saves the rest', async () => {
    state.rows = [seat({ gallery_urls: [U(7), U(8)] })];
    render(<SeatingPage />);
    fireEvent.click(await screen.findByTitle('Edit'));
    await screen.findByRole('heading', { name: 'Edit Seating' });
    expect(shownPhotos()).toEqual([U(7), U(8)]);

    fireEvent.click(screen.getByRole('button', { name: 'Remove photo 1' }));
    expect(shownPhotos()).toEqual([U(8)]);
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    await waitFor(() => expect(state.writes).toHaveLength(1));
    expect(state.writes[0]).toMatchObject({ op: 'update', id: 'seat-1', payload: { gallery_urls: [U(8)] } });
  });

  it('a seat saved before photos existed (no gallery_urls) opens with no photos', async () => {
    state.rows = [seat()];
    render(<SeatingPage />);
    fireEvent.click(await screen.findByTitle('Edit'));
    await screen.findByRole('heading', { name: 'Edit Seating' });
    expect(shownPhotos()).toEqual([]);
    expect(screen.getByRole('button', { name: 'Add photo' })).toBeTruthy();
  });

  it('a failed upload shows the reason and adds nothing', async () => {
    uploadFails = true;
    const { container } = await openAdd();
    await addPhoto(container);
    expect(await screen.findByText('Image must be under 5MB')).toBeTruthy();
    expect(shownPhotos()).toEqual([]);
  });
});
