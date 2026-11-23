// @vitest-environment jsdom
/**
 * "Upload this week's menu" screen (Owner decisions 2026-11-23, M556) —
 * rendered tests: reads-left line, upload → review grouped by day, edit /
 * remove / add, a missing price blocks Save, nothing saved before "Save menu",
 * used-up reads with the Free upgrade hint.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

vi.mock('@/lib/ai-setup/client-image', () => ({
  CLIENT_IMAGE_ACCEPT: 'image/*',
  ImagePrepError: class extends Error {},
  prepareImageForUpload: async (f: File) => f,
}));

import WeeklyMenuUpload from '@/app/dashboard/products/components/WeeklyMenuUpload';

type Call = [string, RequestInit | undefined];
let fetchMock: ReturnType<typeof vi.fn>;
const json = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const allowance = (over: Record<string, unknown> = {}) =>
  ({ limit: 5, used: 3, left: 2, on_free_plan: false, week_start: '2026-11-23', week_end: '2026-11-29', ...over });
const calls = (path: string) => (fetchMock.mock.calls as Call[]).filter(([url]) => url.startsWith(path));

function renderScreen() {
  const setView = vi.fn();
  const onSaved = vi.fn();
  render(<WeeklyMenuUpload businessId="biz-1" curr="₦" setView={setView} onSaved={onSaved} />);
  return { setView, onSaved };
}

async function upload() {
  fireEvent.change(screen.getByLabelText('Menu photos'), { target: { files: [new File(['x'], 'menu.png', { type: 'image/png' })] } });
  await waitFor(() => expect(screen.queryByText('Ace is reading your menu...')).toBeNull());
}

beforeEach(() => {
  fetchMock = vi.fn();
  global.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('weekly menu upload screen', () => {
  it('shows reads left, then the dishes grouped by day; a missing price blocks Save until typed; Save sends one request', async () => {
    fetchMock
      .mockResolvedValueOnce(json(200, allowance()))
      .mockResolvedValueOnce(json(200, { mode: 'weekly_menu', reads_left: 1, items: [
        { name: 'Rice platter', price: 4000, days: [1] },
        { name: 'Salmon', price: 5000, days: [2] },
        { name: 'Zobo', price: null, days: null },
      ] }))
      .mockResolvedValueOnce(json(200, { success: true, created: 3, updated: 0, hidden: 2, skipped: [] }));
    const { onSaved } = renderScreen();

    expect(await screen.findByText('2 of 5 menu reads left today')).toBeTruthy();
    await upload();
    expect(screen.getByText('1 of 5 menu reads left today')).toBeTruthy();
    expect(calls('/api/ai-setup/parse-image')).toHaveLength(1);
    const sent = calls('/api/ai-setup/parse-image')[0][1]!.body as FormData;
    expect(sent.get('mode')).toBe('weekly_menu');

    const headings = screen.getAllByRole('heading', { level: 2 }).map(h => h.textContent);
    expect(headings).toEqual(['Every day this week (1)', 'Mon (1)', 'Tue (1)']);

    const save = screen.getByRole('button', { name: 'Save menu' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(screen.getByText(/1 dish needs a price/)).toBeTruthy();
    expect(calls('/api/products/weekly-menu').filter(([, init]) => init?.method === 'POST')).toHaveLength(0);

    fireEvent.change(screen.getByLabelText('Price for Zobo'), { target: { value: '500' } });
    // Move Salmon to Thursday too.
    fireEvent.click(within(screen.getByRole('group', { name: 'Days for Salmon' })).getByRole('button', { name: 'Thu' }));
    await waitFor(() => expect(document.activeElement?.textContent).toBe('Thu')); // focus stays on the chip after the dish moves group
    fireEvent.change(screen.getByLabelText('Price for Zobo'), { target: { value: '-5' } });
    expect((screen.getByRole('button', { name: 'Save menu' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Price for Zobo'), { target: { value: '500' } });
    expect(screen.getAllByRole('heading', { level: 2 }).map(h => h.textContent)).toEqual(['Every day this week (1)', 'Mon (1)', 'Tue, Thu (1)']);
    expect(save.disabled).toBe(false);
    fireEvent.click(save);

    await screen.findByText('Menu saved for 23 Nov – 29 Nov.');
    const posts = calls('/api/products/weekly-menu').filter(([, init]) => init?.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(JSON.parse(posts[0][1]!.body as string)).toEqual({
      business_id: 'biz-1',
      items: [
        { name: 'Rice platter', price: 4000, days: [1], category: '', description: '' },
        { name: 'Salmon', price: 5000, days: [2, 4], category: '', description: '' },
        { name: 'Zobo', price: 500, days: [], category: '', description: '' },
      ],
    });
    expect(screen.getByText(/2 dishes from your last menu are now hidden from customers \(not deleted\)/)).toBeTruthy();
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it('remove a dish and add a missing one by hand', async () => {
    fetchMock
      .mockResolvedValueOnce(json(200, allowance()))
      .mockResolvedValueOnce(json(200, { mode: 'weekly_menu', reads_left: 1, items: [{ name: 'Salmon', price: 5000, days: [2] }, { name: 'Typo', price: 1, days: [2] }] }))
      .mockResolvedValueOnce(json(200, { success: true, created: 2, updated: 0, hidden: 0, skipped: ['Egusi'] }));
    renderScreen();
    await screen.findByText('2 of 5 menu reads left today');
    await upload();

    fireEvent.click(screen.getByRole('button', { name: 'Remove Typo' }));
    fireEvent.click(screen.getByRole('button', { name: '+ Add a dish' }));
    const save = screen.getByRole('button', { name: 'Save menu' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true); // the new dish has no name or price yet
    const names = screen.getAllByLabelText('Dish name');
    fireEvent.change(names[0], { target: { value: 'Bass fish' } });
    fireEvent.change(screen.getByLabelText('Price for Bass fish'), { target: { value: '7000' } });
    fireEvent.click(within(screen.getByRole('group', { name: 'Days for Bass fish' })).getByRole('button', { name: 'Wed' }));
    fireEvent.click(save);
    await screen.findByText(/Menu saved/);
    const body = JSON.parse(calls('/api/products/weekly-menu').find(([, i]) => i?.method === 'POST')![1]!.body as string);
    expect(body.items.map((i: { name: string; days: number[] }) => [i.name, i.days])).toEqual([['Salmon', [2]], ['Bass fish', [3]]]);
    expect(screen.getByText(/Not added, because you already have an item with this name \(left exactly as it is\): Egusi/)).toBeTruthy();
  });

  it('no reads left on Free: upload is off, "upload again tomorrow" and an upgrade hint', async () => {
    fetchMock.mockResolvedValueOnce(json(200, allowance({ limit: 1, used: 1, left: 0, on_free_plan: true })));
    renderScreen();
    expect(await screen.findByText('0 of 1 menu read left today')).toBeTruthy();
    expect(screen.getByText(/You can upload again tomorrow/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Upgrade to Pro' }).getAttribute('href')).toBe('/dashboard/billing');
    expect((screen.getByLabelText('Menu photos') as HTMLInputElement).disabled).toBe(true);
  });

  it('no upgrade hint on a paid plan; a server refusal is shown and no dish is added', async () => {
    fetchMock
      .mockResolvedValueOnce(json(200, allowance({ left: 1 })))
      .mockResolvedValueOnce(json(403, { error: "You have used today's 5 menu reads. You can upload again tomorrow.", reads_left: 0 }));
    renderScreen();
    await screen.findByText('1 of 5 menu reads left today');
    await upload();
    expect(screen.getByRole('alert').textContent).toContain('You can upload again tomorrow.');
    expect(screen.queryByRole('link', { name: 'Upgrade to Pro' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save menu' })).toBeNull();
  });
});
