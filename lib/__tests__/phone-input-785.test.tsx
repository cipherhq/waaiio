// @vitest-environment jsdom
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { PhoneInput } from '@/components/auth/PhoneInput';
const countries = vi.hoisted(() => [
  { code: 'NG', dialing_code: '+234', phone_digits: 10, phone_placeholder: 'NG number', flag: 'NG' },
  { code: 'US', dialing_code: '+1', phone_digits: 10, phone_placeholder: 'US number', flag: 'US' },
  { code: 'CA', dialing_code: '+1', phone_digits: 10, phone_placeholder: 'CA number', flag: 'CA' },
]);
vi.mock('@/lib/countries', () => ({ getCountry: (cc: string) => countries.find(c => c.code === cc), loadCountries: async () => countries }));
afterEach(cleanup);
describe('selected phone display', () => {
  it('updates number and country on selection, replacement, and reset', async () => {
    const change = vi.fn();
    const { rerender } = render(<PhoneInput value="" onChange={change} />);
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(3));
    rerender(<PhoneInput value="+12025550123" onChange={change} />);
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('2025550123');
    expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('US');
    rerender(<PhoneInput value="+2348012345678" onChange={change} />);
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('8012345678');
    expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('NG');
    rerender(<PhoneInput value="" onChange={change} />);
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('');
    expect(change).not.toHaveBeenCalled();
  });
  it('preserves partial typing, including after deleting a complete number', async () => {
    function Harness() { const [value, setValue] = useState(''); return <PhoneInput value={value} onChange={setValue} />; }
    render(<Harness />);
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(3));
    const input = screen.getByRole('textbox') as HTMLInputElement;
    for (const value of ['8', '80123', '8012345678', '801234567']) {
      fireEvent.change(input, { target: { value } });
      expect(input.value).toBe(value);
    }
  });
  it('preserves Canadian country selection for shared +1 prefix', async () => {
    render(<PhoneInput value="+14165550123" countryCode="CA" onChange={vi.fn()} />);
    await waitFor(() => expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('CA'));
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('4165550123');
  });
  it('clears after partial typing, external customer selection, and parent reset', async () => {
    const change = vi.fn();
    const { rerender } = render(<PhoneInput value="" onChange={change} />);
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(3));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '801' } });
    rerender(<PhoneInput value="+12025550123" onChange={change} />);
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('2025550123');
    rerender(<PhoneInput value="" onChange={change} />);
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('');
  });
});
