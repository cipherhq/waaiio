// @vitest-environment jsdom

/**
 * Setup Guide (Ace) page — rendered tests for image reading and Confirm.
 *
 * Renders the real page, drives it through user events and intercepts fetch.
 * Covers: routing Ace items by kind, null-price blocking, server error
 * display, partial apply failure not shown as success, and product photos
 * uploaded only after Confirm.
 */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

const state = vi.hoisted(() => ({
  business: { id: 'biz-1', name: 'Ada Store', category: 'other' } as Record<string, unknown>,
}));

vi.mock('@/components/dashboard/DashboardProvider', () => ({
  useBusiness: () => state.business,
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

import SetupAssistantPage from '../page';

type FetchMock = ReturnType<typeof vi.fn>;
let fetchMock: FetchMock;

function jsonResponse(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function pngFile(name = 'menu.png') {
  return new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0, 0, 0, 0])], name, { type: 'image/png' });
}

function callsTo(path: string) {
  return fetchMock.mock.calls.filter(([url]) => url === path);
}

async function chooseType(label: RegExp) {
  render(<SetupAssistantPage />);
  fireEvent.click(screen.getByRole('button', { name: label }));
}

async function uploadMenu(files: File[] = [pngFile()]) {
  fireEvent.change(screen.getByLabelText('Upload photos of a menu or price list'), { target: { files } });
  await waitFor(() => expect(screen.queryByText('Ace is reading your image...')).toBeNull());
}

function goToReview() {
  fireEvent.click(screen.getByRole('button', { name: 'Next: Hours' }));
  fireEvent.click(screen.getByRole('button', { name: 'Next: Greeting' }));
  fireEvent.click(screen.getByRole('button', { name: 'Review' }));
}

beforeEach(() => {
  fetchMock = vi.fn();
  global.fetch = fetchMock as unknown as typeof fetch;
  state.business = { id: 'biz-1', name: 'Ada Store', category: 'other' };
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('routing Ace image items', () => {
  it('sends services to Services and products to Products when the business offers both', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, {
      mode: 'menu',
      items: [
        { kind: 'service', name: 'Haircut', price: 15, description: '', category: '' },
        { kind: 'product', name: 'Hair oil', price: 20, description: '', category: '' },
      ],
    }));
    await chooseType(/Both — services and products/);
    await uploadMenu();

    const services = screen.getByRole('region', { name: 'Services' });
    const products = screen.getByRole('region', { name: 'Products' });
    expect(within(services).getByDisplayValue('Haircut')).toBeTruthy();
    expect(within(services).queryByDisplayValue('Hair oil')).toBeNull();
    expect(within(products).getByDisplayValue('Hair oil')).toBeTruthy();
    expect(within(products).queryByDisplayValue('Haircut')).toBeNull();

    const [, init] = callsTo('/api/ai-setup/parse-image')[0];
    const body = init.body as FormData;
    expect(body.get('mode')).toBe('menu');
    expect(body.get('business_id')).toBe('biz-1');
  });

  it('processes several images one at a time', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { items: [{ kind: 'product', name: 'Jollof Rice', price: 2500 }] }))
      .mockResolvedValueOnce(jsonResponse(200, { items: [{ kind: 'product', name: 'Chapman', price: 800 }] }));
    await chooseType(/We sell products/);
    await uploadMenu([pngFile('a.png'), pngFile('b.png')]);
    expect(callsTo('/api/ai-setup/parse-image')).toHaveLength(2);
    expect(screen.getByDisplayValue('Jollof Rice')).toBeTruthy();
    expect(screen.getByDisplayValue('Chapman')).toBeTruthy();
  });
});

describe('items without a visible price', () => {
  it('highlights the item and blocks Confirm until the owner types a price', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { items: [{ kind: 'product', name: 'Zobo', price: null }] }));
    await chooseType(/We sell products/);
    await uploadMenu();

    const priceInput = screen.getByLabelText('Price for Zobo') as HTMLInputElement;
    expect(priceInput.getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByText(/1 item needs a price\. Type a price in the highlighted box \(0 if it.s free\) before you confirm\./)).toBeTruthy();

    goToReview();
    expect(screen.getByText('Price needed')).toBeTruthy();
    const confirm = screen.getByRole('button', { name: 'Confirm & Create' }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.click(confirm);
    expect(callsTo('/api/ai-setup/apply')).toHaveLength(0);

    // Go back, price it, and confirm
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    fireEvent.change(screen.getByLabelText('Price for Zobo'), { target: { value: '500' } });
    goToReview();

    fetchMock.mockResolvedValueOnce(jsonResponse(200, { success: true, results: { products: { created: 1, skipped: 0 } } }));
    const enabled = screen.getByRole('button', { name: 'Confirm & Create' }) as HTMLButtonElement;
    expect(enabled.disabled).toBe(false);
    fireEvent.click(enabled);
    await waitFor(() => expect(screen.getByText('Setup Complete!')).toBeTruthy());
    const payload = JSON.parse(callsTo('/api/ai-setup/apply')[0][1].body as string);
    expect(payload.products).toEqual([{ name: 'Zobo', price: 500, description: '', category: '' }]);
  });
});

describe('clearing a price Ace found (Owner decision 2026-11-04)', () => {
  it('a cleared Ace price becomes "price needed" and blocks Confirm; typing 0 saves it as Free', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { items: [{ kind: 'product', name: 'Chapman', price: 800 }] }));
    await chooseType(/We sell products/);
    await uploadMenu();

    const box = screen.getByLabelText('Price for Chapman') as HTMLInputElement;
    expect(box.value).toBe('800');
    fireEvent.change(box, { target: { value: '' } });
    expect(screen.getByLabelText('Price for Chapman').getAttribute('aria-invalid')).toBe('true');

    goToReview();
    const blocked = screen.getByRole('button', { name: 'Confirm & Create' }) as HTMLButtonElement;
    expect(blocked.disabled).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    fireEvent.change(screen.getByLabelText('Price for Chapman'), { target: { value: '0' } });
    // Free is shown as 0, not as an empty box
    expect((screen.getByLabelText('Price for Chapman') as HTMLInputElement).value).toBe('0');
    goToReview();

    fetchMock.mockResolvedValueOnce(jsonResponse(200, { success: true, results: { products: { created: 1, skipped: 0 } } }));
    const confirm = screen.getByRole('button', { name: 'Confirm & Create' }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    await waitFor(() => expect(screen.getByText('Setup Complete!')).toBeTruthy());
    const payload = JSON.parse(callsTo('/api/ai-setup/apply')[0][1].body as string);
    expect(payload.products).toEqual([{ name: 'Chapman', price: 0, description: '', category: '' }]);
  });
});

describe('price-needed message and highlight', () => {
  it('says how many items need a price and that 0 means free, after the owner clears an Ace price', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { items: [
      { kind: 'product', name: 'Chapman', price: 800 },
      { kind: 'product', name: 'Zobo', price: null },
    ] }));
    await chooseType(/We sell products/);
    await uploadMenu();
    fireEvent.change(screen.getByLabelText('Price for Chapman'), { target: { value: '' } });
    expect(screen.getByText(/2 items need a price\. Type a price in the highlighted boxes \(0 if it.s free\) before you confirm\./)).toBeTruthy();
    expect(screen.queryByText(/couldn.t see a price/i)).toBeNull();
  });

  it('does not highlight a row with no name, since it will not be created', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { items: [{ kind: 'product', name: 'Zobo', price: null }] }));
    await chooseType(/We sell products/);
    await uploadMenu();
    expect(screen.getByLabelText('Price for Zobo').getAttribute('aria-invalid')).toBe('true');
    fireEvent.change(screen.getByDisplayValue('Zobo'), { target: { value: '' } });
    // Unnamed rows are skipped on save, so no red box and no "price needed" message
    expect(screen.getByLabelText('Price for product').getAttribute('aria-invalid')).toBe('false');
    expect(screen.queryByText(/need(s)? a price/)).toBeNull();
  });
});

describe('pasted text', () => {
  it('marks text items without a price as "price needed" instead of Free; keeps 0 and real prices', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { suggestion: { products: [
      { name: 'Zobo' },
      { name: 'Chapman', price: 800 },
      { name: 'Water', price: 0 },
      { name: 'Kunu', price: '' },
    ] } }));
    await chooseType(/We sell products/);
    fireEvent.change(screen.getByPlaceholderText(/Paste your product list here/), { target: { value: 'Zobo\nChapman - 800\nWater - free\nKunu' } });
    fireEvent.click(screen.getByRole('button', { name: 'Extract with Ace' }));
    await waitFor(() => expect(screen.getByLabelText('Price for Zobo')).toBeTruthy());

    expect(screen.getByLabelText('Price for Zobo').getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByLabelText('Price for Kunu').getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByLabelText('Price for Chapman').getAttribute('aria-invalid')).not.toBe('true');
    expect(screen.getByLabelText('Price for Water').getAttribute('aria-invalid')).not.toBe('true');

    goToReview();
    const confirm = screen.getByRole('button', { name: 'Confirm & Create' }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.click(confirm);
    expect(callsTo('/api/ai-setup/apply')).toHaveLength(0);
  });
});

describe('decimal prices', () => {
  it('keeps a product decimal price, warns only about service rounding', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, {
      items: [
        { kind: 'product', name: 'Latte', price: 12.5 },
        { kind: 'service', name: 'Trim', price: 12.5 },
      ],
    }));
    await chooseType(/Both — services and products/);
    await uploadMenu();
    goToReview();
    expect(screen.getByText(/Services prices are saved as whole numbers/)).toBeTruthy();

    fetchMock.mockResolvedValueOnce(jsonResponse(200, { success: true, results: {} }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm & Create' }));
    await waitFor(() => expect(screen.getByText('Setup Complete!')).toBeTruthy());
    const payload = JSON.parse(callsTo('/api/ai-setup/apply')[0][1].body as string);
    expect(payload.products[0].price).toBe(12.5);
  });

  it('shows no rounding note when only products have decimals', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { items: [{ kind: 'product', name: 'Latte', price: 12.5 }] }));
    await chooseType(/We sell products/);
    await uploadMenu();
    goToReview();
    expect(screen.queryByText(/saved as whole numbers/)).toBeNull();
    expect(screen.getByText('12.5')).toBeTruthy();
  });
});

describe('server messages', () => {
  it('shows the server error when Ace refuses an image', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(403, { error: 'Monthly ace setup limit reached (3). Upgrade for more.' }));
    await chooseType(/We sell products/);
    await uploadMenu();
    expect(screen.getByRole('alert').textContent).toContain('Monthly ace setup limit reached (3). Upgrade for more.');
  });

  it('does not show "Setup Complete" when apply partially fails', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { items: [{ kind: 'product', name: 'Chapman', price: 800 }, { kind: 'product', name: 'Zobo', price: 300 }] }));
    await chooseType(/We sell products/);
    await uploadMenu();
    goToReview();

    fetchMock.mockResolvedValueOnce(jsonResponse(207, {
      success: false,
      results: { products: { created: 1, skipped: 0, errors: [{ name: 'Zobo', error: 'Price is required.' }] } },
    }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm & Create' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Some items were not created'));
    expect(screen.getByRole('alert').textContent).toContain('Zobo');
    expect(screen.queryByText('Setup Complete!')).toBeNull();
  });
});

describe('product photos', () => {
  it('keeps the photo in the browser and uploads it only after Confirm', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, {
      mode: 'product_photo',
      items: [{ kind: 'product', name: 'Red sneakers', price: 30, description: 'Red canvas sneakers', category: 'Shoes' }],
    }));
    await chooseType(/We sell products/);
    fireEvent.change(screen.getByLabelText('Upload photos of single products'), { target: { files: [pngFile('shoe.png')] } });
    await waitFor(() => expect(screen.getByDisplayValue('Red sneakers')).toBeTruthy());
    expect(screen.getByDisplayValue('Shoes')).toBeTruthy();
    expect(screen.getByDisplayValue('Red canvas sneakers')).toBeTruthy();
    expect((callsTo('/api/ai-setup/parse-image')[0][1].body as FormData).get('mode')).toBe('product_photo');
    expect(callsTo('/api/products/upload-image')).toHaveLength(0);

    goToReview();
    const url = 'https://proj.supabase.co/storage/v1/object/public/business-documents/biz-1/products/1.jpg';
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { success: true, url }))
      .mockResolvedValueOnce(jsonResponse(200, { success: true, results: { products: { created: 1, skipped: 0 } } }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm & Create' }));
    await waitFor(() => expect(screen.getByText('Setup Complete!')).toBeTruthy());

    const order = fetchMock.mock.calls.map(([u]) => u);
    expect(order.slice(-2)).toEqual(['/api/products/upload-image', '/api/ai-setup/apply']);
    const payload = JSON.parse(callsTo('/api/ai-setup/apply')[0][1].body as string);
    expect(payload.products[0]).toMatchObject({ name: 'Red sneakers', price: 30, category: 'Shoes', image_url: url });
  });

  it('does not create anything when the photo upload fails', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { items: [{ kind: 'product', name: 'Red sneakers', price: 30 }] }));
    await chooseType(/We sell products/);
    fireEvent.change(screen.getByLabelText('Upload photos of single products'), { target: { files: [pngFile('shoe.png')] } });
    await waitFor(() => expect(screen.getByDisplayValue('Red sneakers')).toBeTruthy());
    goToReview();

    fetchMock.mockResolvedValueOnce(jsonResponse(400, { error: 'Image must be under 5MB' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm & Create' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Image must be under 5MB'));
    expect(callsTo('/api/ai-setup/apply')).toHaveLength(0);
  });

  it('hides the product-photo option for services-only businesses', async () => {
    await chooseType(/We offer services/);
    expect(screen.queryByLabelText('Upload photos of single products')).toBeNull();
    expect(screen.getByLabelText('Upload photos of a menu or price list')).toBeTruthy();
  });
});
