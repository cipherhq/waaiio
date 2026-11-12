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
