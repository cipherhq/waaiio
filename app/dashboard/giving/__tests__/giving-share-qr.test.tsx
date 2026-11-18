// @vitest-environment jsdom
/**
 * Giving page — per-category share (Owner request 2026-11-18).
 *
 * Renders the real GivingPage and checks, for an active category: the Share
 * button opens a QR code of the category's permanent link, Download PNG saves
 * that QR, Copy Link copies the link, and Share on WhatsApp carries the link.
 * Inactive categories get no share options.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

const BIZ_ID = '550e8400-e29b-41d4-a716-446655440000';
const TITHE = '3f2a9c1d-1b2c-4d3e-8f40-000000000001';
const PAUSED = 'cc33dd44-1b2c-4d3e-8f40-000000000004';

const state = vi.hoisted(() => ({ impersonating: false }));

vi.mock('@/components/dashboard/DashboardProvider', () => ({
  useBusiness: () => ({ id: '550e8400-e29b-41d4-a716-446655440000', name: 'Grace Chapel', slug: 'grace-chapel', country_code: 'NG',
    recurring_enabled: false, capabilities: ['giving'], selectedCapabilities: ['giving'] }),
  useDashboard: () => ({ isImpersonating: state.impersonating }),
}));
vi.mock('next/link', () => ({ default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a> }));
vi.mock('@/components/dashboard/PageHeader', () => ({ PageHeader: ({ title, children }: { title: string; children?: React.ReactNode }) => <div><h1>{title}</h1>{children}</div> }));
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => {
    const rows = [
      { id: TITHE, name: 'Tithe', description: null, price: 0, price_is_variable: true, is_active: true, sort_order: 0, billing_type: 'one_time', recurring_interval: null },
      { id: PAUSED, name: 'Paused Fund', description: null, price: 0, price_is_variable: true, is_active: false, sort_order: 1, billing_type: 'one_time', recurring_interval: null },
    ];
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'is', 'order', 'update']) chain[m] = () => chain;
    chain.then = (r: (v: unknown) => void) => r({ data: rows, error: null });
    return { from: () => chain };
  },
}));

const { default: GivingPage } = await import('@/app/dashboard/giving/page');
const { buildGivingCategoryLink } = await import('@/lib/giving-category-link');

describe('Giving page — category share options', () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  beforeEach(() => {
    state.impersonating = false;
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    writeText.mockClear();
  });
  afterEach(() => cleanup());

  it('Share opens the QR, Download PNG, Copy Link and Share on WhatsApp for that category', async () => {
    render(<GivingPage />);
    await waitFor(() => expect(screen.getByText('Tithe')).toBeTruthy());

    // One Share button: the inactive category has none.
    const shareButtons = screen.getAllByRole('button', { name: 'Share' });
    expect(shareButtons).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Copy Link' })).toBeNull();

    fireEvent.click(shareButtons[0]);
    const link = buildGivingCategoryLink(BIZ_ID, TITHE);
    expect(link.endsWith(`/m/${BIZ_ID}/giving/${TITHE}`)).toBe(true);

    // QR code rendered for this category's link.
    const qrBox = document.getElementById(`giving-qr-${TITHE}`)!;
    expect(qrBox).toBeTruthy();
    expect(qrBox.querySelector('canvas')).toBeTruthy();
    expect(screen.getByText(link)).toBeTruthy();

    // Copy Link copies the permanent link.
    fireEvent.click(screen.getByRole('button', { name: 'Copy Link' }));
    expect(writeText).toHaveBeenCalledWith(link);
    expect(screen.getByRole('button', { name: 'Copied!' })).toBeTruthy();

    // Share on WhatsApp carries the link.
    const wa = screen.getByRole('link', { name: 'Share on WhatsApp' }) as HTMLAnchorElement;
    expect(wa.href.startsWith('https://wa.me/?text=')).toBe(true);
    expect(decodeURIComponent(wa.href.split('text=')[1])).toBe(`Give to Tithe at Grace Chapel: ${link}`);

    // Download PNG saves the category's QR as a PNG.
    const canvas = qrBox.querySelector('canvas')!;
    const toDataURL = vi.spyOn(canvas, 'toDataURL').mockReturnValue('data:image/png;base64,QR');
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    fireEvent.click(screen.getByRole('button', { name: 'Download PNG' }));
    expect(toDataURL).toHaveBeenCalledWith('image/png');
    const anchor = click.mock.instances[0] as unknown as HTMLAnchorElement;
    expect(anchor.download).toBe('grace-chapel-tithe-qr.png');
    expect(anchor.href).toBe('data:image/png;base64,QR');
    click.mockRestore();

    // Share toggles closed again.
    fireEvent.click(screen.getByRole('button', { name: 'Share' }));
    expect(screen.queryByRole('button', { name: 'Copy Link' })).toBeNull();
  });

  it('share options stay available during admin impersonation (read-only)', async () => {
    state.impersonating = true;
    render(<GivingPage />);
    await waitFor(() => expect(screen.getByText('Tithe')).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Share' }));
    const panel = document.getElementById(`giving-qr-${TITHE}`)!.parentElement!.parentElement!;
    expect(within(panel).getByRole('button', { name: 'Download PNG' })).toBeTruthy();
  });
});
