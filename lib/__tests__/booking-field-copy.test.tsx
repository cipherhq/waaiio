// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ writes: vi.fn() }));
vi.mock('@/components/dashboard/DashboardProvider', () => ({ useBusiness: () => ({ id: 'tenant', name: 'Demo', country_code: 'NG', category: 'salon', flow_type: 'scheduling', subscription_tier: 'free' }) }));
vi.mock('@/hooks/useCategoryConfig', () => ({ useCategoryConfig: () => ({ labels: { defaultHasPrice: true, serviceName: 'Service', serviceNamePlural: 'Services', personLabelPlural: 'Customers' } }) }));
vi.mock('@/components/dashboard/PageHelp', () => ({ PageHelp: () => null }));
vi.mock('@/components/dashboard/ServiceIntakeSettings', () => ({ ServiceIntakeSettings: () => null }));
vi.mock('@/components/dashboard/ItemTaxFields', () => ({ ItemTaxFields: () => null }));
vi.mock('@/lib/supabase/client', () => ({ createClient: () => ({ from: (table: string) => {
  const row = { id: 'service', name: 'Demo service', duration_minutes: 30, buffer_minutes: 10, is_active: true, status: 'active', price: 100, metadata: {}, class_schedule: [], available_days: [], gallery_urls: [], staff_ids: [], billing_type: 'one_time' };
  const query: any = {};
  for (const method of ['select', 'eq', 'is', 'neq', 'order', 'or', 'gte', 'in', 'limit']) query[method] = () => query;
  query.update = state.writes; query.insert = state.writes;
  query.then = (resolve: any) => Promise.resolve({ data: table === 'services' ? [row] : [], error: null }).then(resolve);
  return query;
} }) }));
import ServicesPage from '@/app/dashboard/services/page';
import AppointmentsPage from '@/app/dashboard/appointments-management/page';
afterEach(() => { cleanup(); vi.clearAllMocks(); });
describe('booking field units and label associations', () => {
  it('appointments distinguish minute inputs from monetary amounts and retain numeric constraints', async () => {
    render(<AppointmentsPage />);
    fireEvent.click(await screen.findByRole('button', { name: /^\+ Add/ }));
    const duration = screen.getByRole('spinbutton', { name: 'Duration (minutes)' }) as HTMLInputElement;
    const buffer = screen.getByRole('spinbutton', { name: /^Buffer time \(minutes\)/ }) as HTMLInputElement;
    const capacity = screen.getByRole('spinbutton', { name: /^Max bookings per time slot/ }) as HTMLInputElement;
    expect(duration.value).toBe('30'); expect(duration.min).toBe('5'); expect(duration.step).toBe('5');
    expect(buffer.placeholder).toBe('Enter minutes'); expect(buffer.min).toBe('0'); expect(buffer.step).toBe('5');
    expect(document.getElementById(buffer.getAttribute('aria-describedby')!)?.textContent).toBe('Minutes between appointments for cleanup or breaks');
    expect(capacity.value).toBe('1'); expect(capacity.min).toBe('1');
    expect(screen.getByPlaceholderText('Enter amount')).not.toBe(buffer);
    fireEvent.change(buffer, { target: { value: '15' } }); expect(buffer.value).toBe('15');
    expect(state.writes).not.toHaveBeenCalled();
  });
  it('services associate duration and buffer labels with their minute inputs without changing values', async () => {
    render(<ServicesPage />); fireEvent.click(await screen.findByText('Demo service'));
    const duration = screen.getByRole('spinbutton', { name: 'Duration (minutes)' }) as HTMLInputElement;
    const buffer = screen.getByRole('spinbutton', { name: /^Buffer time \(minutes\)/ }) as HTMLInputElement;
    expect(duration.value).toBe('30'); expect(duration.min).toBe('5'); expect(duration.step).toBe('5');
    expect(buffer.value).toBe('10'); expect(buffer.min).toBe('0'); expect(buffer.step).toBe('5');
    expect(buffer.placeholder).toBe('e.g. 10');
    fireEvent.change(duration, { target: { value: '45' } }); expect(duration.value).toBe('45');
    expect(state.writes).not.toHaveBeenCalled();
  });
});
