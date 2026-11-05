import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AddressAutocomplete from '@/components/AddressAutocomplete';

const provider = vi.hoisted(() => ({ create: vi.fn(), predict: vi.fn(), details: vi.fn(), reset: vi.fn() }));
vi.mock('@/lib/googlePlaces', () => ({ createGooglePlacesServices: provider.create }));
const predictions: Array<(data: unknown, status: string) => void> = [];
const details: Array<(data: unknown, status: string) => void> = [];
const suggestion = { place_id: 'one', description: '10 Main Street, Lagos', structured_formatting: { main_text: '10 Main Street', secondary_text: 'Lagos' } };
const place = { formatted_address: '10 Main Street, Lagos, Nigeria', address_components: [
  { long_name: '10', types: ['street_number'] }, { long_name: 'Main Street', types: ['route'] },
  { long_name: 'Lagos', types: ['locality'] }, { long_name: 'Lagos State', types: ['administrative_area_level_1'] },
  { long_name: '100001', types: ['postal_code'] }, { long_name: 'Nigeria', short_name: 'NG', types: ['country'] },
] };
beforeEach(() => {
  vi.useFakeTimers();
  predictions.length = 0; details.length = 0;
  provider.predict.mockReset().mockImplementation((_request, callback) => predictions.push(callback));
  provider.details.mockReset().mockImplementation((_request, callback) => details.push(callback));
  provider.reset.mockReset();
  provider.create.mockReset().mockResolvedValue({ predictions: { getPlacePredictions: provider.predict }, details: { getDetails: provider.details }, reset: provider.reset });
});
afterEach(() => { cleanup(); vi.useRealTimers(); });
function Controlled({ changed = vi.fn(), country = 'NG' }: { changed?: ReturnType<typeof vi.fn>; country?: string }) {
  const [value, setValue] = useState('');
  return <AddressAutocomplete ariaLabel="Address" required value={value} countryCode={country} onChange={(text, fields) => { setValue(text); changed(text, fields); }} />;
}
async function ready() { await act(async () => { await Promise.resolve(); }); }
async function type(value: string) {
  fireEvent.change(screen.getByRole('combobox'), { target: { value } });
  await act(async () => { await vi.advanceTimersByTimeAsync(300); });
}
function offer(index = 0) { act(() => predictions[index]([suggestion], 'OK')); }
async function select(index = 0) {
  await type('Main ' + index); offer(index); fireEvent.click(screen.getByRole('option'));
}
describe('#751 Admin address input', () => {
  it('selects by keyboard, applies country restriction and returns structured fields', async () => {
    const changed = vi.fn(); render(<Controlled changed={changed} />); await ready();
    await type('Main'); offer();
    expect(provider.predict.mock.calls[0][0]).toEqual({ input: 'Main', componentRestrictions: { country: 'ng' } });
    const input = screen.getByRole('combobox');
    expect(input).toBeRequired();
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(input.getAttribute('aria-activedescendant')).toBe(screen.getByRole('option').id);
    fireEvent.keyDown(input, { key: 'Enter' });
    act(() => details[0](place, 'OK'));
    expect(changed).toHaveBeenLastCalledWith(place.formatted_address, { address: '10 Main Street', city: 'Lagos', state: 'Lagos State', postcode: '100001' });
    expect(screen.queryByRole('listbox')).toBeNull();
  });
  it('keeps pointer-selected text when details fail', async () => {
    render(<Controlled />); await ready(); await type('Main'); offer();
    fireEvent.pointerDown(screen.getByRole('option')); fireEvent.click(screen.getByRole('option'));
    act(() => details[0](null, 'REQUEST_DENIED'));
    expect(screen.getByRole('combobox')).toHaveValue(suggestion.description);
  });
  it.each(['blur', 'outside'])('retains delayed selected details after %s', async mode => {
    const changed = vi.fn(); render(<Controlled changed={changed} />); await ready(); await select();
    if (mode === 'blur') fireEvent.blur(screen.getByRole('combobox')); else fireEvent.pointerDown(document.body);
    act(() => details[0](place, 'OK'));
    expect(changed.mock.calls.at(-1)?.[1]).toMatchObject({ city: 'Lagos', postcode: '100001' });
    expect(screen.queryByRole('listbox')).toBeNull();
  });
  it('keeps manual entry usable while unavailable or loading', async () => {
    provider.create.mockReturnValue(new Promise(() => {}));
    const view = render(<Controlled />); await type('Manual pending'); expect(screen.getByRole('combobox')).toHaveValue('Manual pending');
    view.unmount(); provider.create.mockRejectedValue(new Error('unavailable'));
    render(<Controlled />); await ready(); await type('Manual fallback');
    expect(screen.getByRole('combobox')).toHaveValue('Manual fallback'); expect(provider.predict).not.toHaveBeenCalled();
  });
  it.each(['ZERO_RESULTS', 'REQUEST_DENIED'])('keeps input after prediction status %s', async status => {
    render(<Controlled />); await ready(); await type('Main');
    act(() => predictions[0](null, status));
    expect(screen.queryByRole('listbox')).toBeNull(); expect(screen.getByRole('combobox')).toHaveValue('Main');
  });
  it('ignores stale predictions and details after manual edits', async () => {
    const changed = vi.fn(); render(<Controlled changed={changed} />); await ready();
    await type('Old'); await type('New'); offer(0); expect(screen.queryByRole('option')).toBeNull();
    offer(1); fireEvent.click(screen.getByRole('option'));
    await type('Manual'); act(() => details[0](place, 'OK'));
    expect(changed).toHaveBeenLastCalledWith('Manual', undefined);
  });
  it('ignores an earlier selected detail response after reselection', async () => {
    const changed = vi.fn(); render(<Controlled changed={changed} />); await ready();
    await select(); await select(1);
    act(() => details[1]({ ...place, formatted_address: 'Second address' }, 'OK'));
    act(() => details[0](place, 'OK'));
    expect(changed.mock.calls.at(-1)?.[0]).toBe('Second address');
  });
  it('invalidates both pending predictions and details when the country changes', async () => {
    const changed = vi.fn(); const view = render(<Controlled changed={changed} country="NG" />); await ready();
    await type('Old'); view.rerender(<Controlled changed={changed} country="GB" />);
    offer(); expect(screen.queryByRole('option')).toBeNull();
    await select(1);
    expect(provider.predict.mock.calls[1][0].componentRestrictions).toEqual({ country: 'gb' });
    view.rerender(<Controlled changed={changed} country="NG" />); changed.mockClear();
    act(() => details[0](place, 'OK')); expect(changed).not.toHaveBeenCalled();
  });
  it('restores external values and rejects selected details after reset', async () => {
    const changed = vi.fn(); const view = render(<AddressAutocomplete value="Saved" onChange={changed} />); await ready();
    expect(screen.getByRole('combobox')).toHaveValue('Saved');
    await select(); view.rerender(<AddressAutocomplete value="Another record" onChange={changed} />);
    changed.mockClear(); act(() => details[0](place, 'OK'));
    expect(changed).not.toHaveBeenCalled(); expect(screen.getByRole('combobox')).toHaveValue('Another record');
  });
  it('cancels debounce/predictions on clear and escape and details on unmount', async () => {
    const changed = vi.fn(); const view = render(<Controlled changed={changed} />); await ready();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'Soon' } });
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(300); }); expect(provider.predict).not.toHaveBeenCalled();
    await type('Escape'); fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Escape' }); offer();
    expect(screen.queryByRole('option')).toBeNull();
    await select(1); view.unmount(); changed.mockClear(); act(() => details[0](place, 'OK')); expect(changed).not.toHaveBeenCalled();
  });
  it('clearing input invokes reset on the services', async () => {
    render(<Controlled />); await ready();
    await type('Main'); offer();
    // Clear
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '' } });
    expect(provider.reset).toHaveBeenCalled();
  });
  it('selected prediction _raw is passed to getDetails', async () => {
    const rawMarker = { toPlace: vi.fn() };
    const predWithRaw = { ...suggestion, _raw: rawMarker };
    provider.predict.mockReset().mockImplementation((_request, callback) => callback([predWithRaw], 'OK'));
    render(<Controlled />); await ready();
    await type('Main');
    fireEvent.click(screen.getByRole('option'));
    expect(provider.details).toHaveBeenCalledOnce();
    expect(provider.details.mock.calls[0][0]._raw).toBe(rawMarker);
  });
});
