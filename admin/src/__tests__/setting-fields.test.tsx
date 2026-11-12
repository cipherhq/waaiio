import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
vi.mock('@/lib/supabase', () => ({ adminDb: { from: () => ({ select: () => ({ order: async () => ({ data: [{ id: 'business-1', name: 'Test Church', country_code: 'US' }] }) }) }) } }));
import { DirectoryBusinessEditor, KeywordPayloadEditor, SettingSummary } from '@/components/SettingFields';
afterEach(cleanup);
it('edits the reply while retaining unknown payload keys', () => {
 const change = vi.fn(); render(<KeywordPayloadEditor action="reply" value='{"message":"Hello","extra":{"retained":true}}' onChange={change} />);
 fireEvent.change(screen.getByLabelText('Reply message'), { target: { value: 'Welcome' } });
 expect(JSON.parse(change.mock.calls[0][0])).toEqual({ message: 'Welcome', extra: { retained: true } });
});
it('retains unsupported and malformed payloads in advanced editor', () => {
 const change = vi.fn(); render(<KeywordPayloadEditor action="url" value="legacy payload" onChange={change} />);
 expect(screen.getByLabelText('Advanced keyword payload')).toHaveValue('legacy payload');
 expect(change).not.toHaveBeenCalled();
});
it('shows nested settings without serialized JSON', () => {
 render(<SettingSummary value={{ USD: { growth: 490, enabled: true } }} />);
 expect(screen.getByText('USD')).toBeInTheDocument(); expect(screen.getByText('490')).toBeInTheDocument(); expect(screen.getByText('Enabled')).toBeInTheDocument();
});
it('selects businesses by name and retains saved identifiers', async () => {
 const change = vi.fn(); render(<DirectoryBusinessEditor value={['unknown-id']} onChange={change} />);
 await screen.findByRole('option', { name: 'Test Church (US)' });
 fireEvent.change(screen.getByLabelText('Add business'), { target: { value: 'business-1' } });
 expect(change).toHaveBeenCalledWith(['unknown-id', 'business-1']);
});
import { renderSettingEditor } from '@/pages/PlatformSettings';
function editor(key: string, value: unknown, change: (value: string) => void) {
 return renderSettingEditor({ key, value, description: null, updated_by: null, updated_at: null, created_at: '' }, JSON.stringify(value), false, change);
}
it('preserves number and boolean types in flat setting edits', () => {
 const change = vi.fn(); render(editor('test', { count: 5, enabled: false }, change));
 fireEvent.change(screen.getByLabelText('count'), { target: { value: '7' } });
 expect(JSON.parse(change.mock.calls[0][0])).toEqual({ count: 7, enabled: false });
 fireEvent.click(screen.getByLabelText('enabled'));
 expect(JSON.parse(change.mock.calls[1][0])).toEqual({ count: 5, enabled: true });
});
it('adds textual launch parameters and numeric reminder hours', () => {
 const change = vi.fn(); const view = render(editor('launch_notification_config', { params: ['Waaiio'] }, change));
 const input = screen.getByLabelText('Add params');
 fireEvent.change(input, { target: { value: 'Launch day' } }); fireEvent.keyDown(input, { key: 'Enter' });
 expect(JSON.parse(change.mock.calls[0][0])).toEqual({ params: ['Waaiio', 'Launch day'] });
 view.unmount(); render(editor('booking_defaults', { reminderHours: [] }, change));
 const hours = screen.getByLabelText('Add reminder Hours');
 fireEvent.change(hours, { target: { value: '24' } }); fireEvent.keyDown(hours, { key: 'Enter' });
 expect(JSON.parse(change.mock.calls[1][0])).toEqual({ reminderHours: [24] });
});
it('presents unlimited as a checkbox while retaining the sentinel', () => {
 const change = vi.fn(); render(editor('broadcast_limits', { free: { maxRecipients: 5 } }, change));
 fireEvent.click(screen.getByLabelText('free Max Recipients/mo unlimited'));
 expect(JSON.parse(change.mock.calls[0][0])).toEqual({ free: { maxRecipients: 999999999 } });
});
it('routes site announcement editing to its canonical visual editor', () => {
 render(editor('site_announcement', { enabled: false }, vi.fn()));
 expect(screen.getByRole('link', { name: 'Edit announcement and preview' })).toHaveAttribute('href', '/site-announcement');
});
import { hasTierLimitErrors } from '@/pages/PlatformSettings';
function limitEditor(key: string, stored: unknown, current: unknown, change: (value: string) => void) {
 return renderSettingEditor({ key, value: stored, description: null, updated_by: null, updated_at: null, created_at: '' }, JSON.stringify(current), true, change);
}
it('unticking Unlimited restores the stored finite limit instead of writing 0', () => {
 const change = vi.fn(); render(limitEditor('pricing_tiers', { growth: { maxBookings: 1000 } }, { growth: { maxBookings: 999999999 } }, change));
 fireEvent.click(screen.getByLabelText('growth Max Bookings/mo unlimited'));
 expect(JSON.parse(change.mock.calls[0][0])).toEqual({ growth: { maxBookings: 1000 } });
});
it('unticking Unlimited with no stored finite limit leaves it empty and blocks saving', () => {
 const change = vi.fn(); render(limitEditor('pricing_tiers', { business: { maxBookings: 999999999 } }, { business: { maxBookings: 999999999 } }, change));
 fireEvent.click(screen.getByLabelText('business Max Bookings/mo unlimited'));
 const draft = change.mock.calls[0][0];
 expect(JSON.parse(draft)).toEqual({ business: { maxBookings: null } });
 expect(hasTierLimitErrors('pricing_tiers', draft, { business: { maxBookings: 999999999 } })).toBe(true);
 cleanup(); render(limitEditor('pricing_tiers', { business: { maxBookings: 999999999 } }, JSON.parse(draft), vi.fn()));
 expect(screen.getByRole('alert')).toHaveTextContent('Enter a whole number above 0, or tick Unlimited.');
});
it('clearing a limit field writes empty, not 0', () => {
 const change = vi.fn(); render(limitEditor('broadcast_limits', { growth: { maxBroadcasts: 10 } }, { growth: { maxBroadcasts: 10 } }, change));
 fireEvent.change(screen.getByLabelText('growth Max Broadcasts/mo'), { target: { value: '' } });
 expect(JSON.parse(change.mock.calls[0][0])).toEqual({ growth: { maxBroadcasts: null } });
});
it('rejects new zero, negative, fractional or empty limits but keeps an existing zero policy', () => {
 const stored = { free: { maxBroadcasts: 0, maxRecipients: 0 }, growth: { maxBookings: 1000 } };
 const check = (value: unknown) => hasTierLimitErrors('pricing_tiers', JSON.stringify(value), stored);
 expect(check({ growth: { maxBookings: 0 } })).toBe(true);
 expect(check({ growth: { maxBookings: -5 } })).toBe(true);
 expect(check({ growth: { maxBookings: 2.5 } })).toBe(true);
 expect(check({ growth: { maxBookings: null } })).toBe(true);
 expect(check({ growth: { maxBookings: 1500 } })).toBe(false);
 expect(check({ growth: { maxBookings: 999999999 } })).toBe(false);
 expect(hasTierLimitErrors('broadcast_limits', JSON.stringify(stored), stored)).toBe(false);
 expect(hasTierLimitErrors('broadcast_limits', JSON.stringify({ free: { maxBroadcasts: 5, maxRecipients: 50 } }), stored)).toBe(false);
 expect(hasTierLimitErrors('trial_days', '0', 14)).toBe(false);
});
import { hasFlatNumberErrors } from '@/pages/PlatformSettings';
it('clearing a flat number field writes empty, not 0, and blocks saving', () => {
 const stored = { free: 200, growth: 1000, business: 999999999 };
 const change = vi.fn(); render(limitEditor('conversation_limits', stored, stored, change));
 fireEvent.change(screen.getByLabelText('growth'), { target: { value: '' } });
 const draft = change.mock.calls[0][0];
 expect(JSON.parse(draft)).toEqual({ free: 200, growth: null, business: 999999999 });
 expect(hasFlatNumberErrors('conversation_limits', draft, stored)).toBe(true);
 cleanup(); render(limitEditor('conversation_limits', stored, JSON.parse(draft), vi.fn()));
 expect(screen.getByLabelText('growth')).toHaveValue(null);
 expect(screen.getByRole('alert')).toHaveTextContent('Enter a whole number above 0.');
});
it('conversation limits follow the plan-limit rule; other flat numbers only need a number', () => {
 const stored = { free: 0, growth: 1000, business: 999999999 };
 const check = (value: unknown) => hasFlatNumberErrors('conversation_limits', JSON.stringify(value), stored);
 expect(check({ ...stored, growth: 0 })).toBe(true);
 expect(check({ ...stored, growth: -1 })).toBe(true);
 expect(check({ ...stored, growth: 1.5 })).toBe(true);
 expect(check({ ...stored, growth: 1500 })).toBe(false);
 expect(check(stored)).toBe(false);
 expect(hasFlatNumberErrors('test', JSON.stringify({ count: 0, label: '' }), { count: 5, label: 'x' })).toBe(false);
 expect(hasFlatNumberErrors('test', JSON.stringify({ count: null }), { count: 5 })).toBe(true);
 expect(hasFlatNumberErrors('pricing_tiers', JSON.stringify({ growth: { maxBookings: 1000 } }), { growth: { maxBookings: 1000 } })).toBe(false);
});
