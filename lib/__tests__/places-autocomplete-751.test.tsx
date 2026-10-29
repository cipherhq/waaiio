// @vitest-environment jsdom
import React, { useState } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PlacesAutocomplete from '@/components/ui/PlacesAutocomplete';
import AddressAutocomplete from '@/components/ui/AddressAutocomplete';

const provider = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock('@/lib/google-places-loader', () => ({ loadGooglePlaces: provider.load }));

const predictions: Array<(data: unknown, status: string) => void> = [];
const details: Array<(data: unknown, status: string) => void> = [];
const native: Array<{ listener?: () => void; remove: ReturnType<typeof vi.fn>; restrict: ReturnType<typeof vi.fn>; place: unknown }> = [];
const getPredictions = vi.fn();
const getDetails = vi.fn();
const prediction = { place_id: 'place-1', description: '10 Main Street, Lagos', structured_formatting: { main_text: '10 Main Street', secondary_text: 'Lagos' } };
const components = [
  { long_name: 'County', short_name: 'County', types: ['administrative_area_level_2'] },
  { long_name: 'Lagos', short_name: 'Lagos', types: ['locality'] },
  { long_name: '10', short_name: '10', types: ['street_number'] },
  { long_name: 'Main Street', short_name: 'Main Street', types: ['route'] },
  { long_name: 'Lagos State', short_name: 'LA', types: ['administrative_area_level_1'] },
  { long_name: '100001', short_name: '100001', types: ['postal_code'] },
  { long_name: 'Nigeria', short_name: 'NG', types: ['country'] },
];
const place = { formatted_address: '10 Main Street, Lagos, Nigeria', address_components: components, geometry: { location: { lat: () => 6.5, lng: () => 3.4 } } };

beforeEach(() => {
  vi.useFakeTimers();
  provider.load.mockReset().mockResolvedValue(undefined);
  predictions.length = 0; details.length = 0; native.length = 0;
  getPredictions.mockReset().mockImplementation((_request, callback) => predictions.push(callback));
  getDetails.mockReset().mockImplementation((_request, callback) => details.push(callback));
  vi.stubGlobal('google', { maps: { places: {
    PlacesServiceStatus: { OK: 'OK' },
    AutocompleteService: class { getPlacePredictions = getPredictions; },
    PlacesService: class { getDetails = getDetails; },
    Autocomplete: class {
      state = { remove: vi.fn(), restrict: vi.fn(), place: place as unknown, listener: undefined as (() => void) | undefined };
      constructor() { native.push(this.state); }
      addListener(_event: string, callback: () => void) { this.state.listener = callback; return { remove: this.state.remove }; }
      getPlace() { return this.state.place; }
      setComponentRestrictions(value: unknown) { this.state.restrict(value); }
    },
  } } });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

function Controlled({ changed = vi.fn() }: { changed?: ReturnType<typeof vi.fn> }) {
  const [value, setValue] = useState('');
  return <PlacesAutocomplete value={value} onChange={(text, data) => { setValue(text); changed(text, data); }} />;
}
async function ready() { await act(async () => { await Promise.resolve(); }); }
async function type(text: string) {
  fireEvent.change(screen.getByRole('combobox'), { target: { value: text } });
  await act(async () => { await vi.advanceTimersByTimeAsync(300); });
}
function suggestions(index = 0) { act(() => predictions[index]([prediction], 'OK')); }

describe('#751 controlled Places input', () => {
  it('supports keyboard selection and structured coordinates/city', async () => {
    const changed = vi.fn(); render(<Controlled changed={changed} />); await ready();
    await type('Main'); suggestions();
    const input = screen.getByRole('combobox');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(input.getAttribute('aria-activedescendant')).toBe(screen.getByRole('option').id);
    fireEvent.keyDown(input, { key: 'Enter' });
    expect((input as HTMLInputElement).value).toBe(prediction.description);
    act(() => details[0](place, 'OK'));
    expect(changed).toHaveBeenLastCalledWith(place.formatted_address, { address: place.formatted_address, lat: 6.5, lng: 3.4, city: 'Lagos', placeId: 'place-1' });
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('supports pointer/click selection and keeps text if details fail', async () => {
    render(<Controlled />); await ready(); await type('Main'); suggestions();
    fireEvent.pointerDown(screen.getByRole('option'));
    fireEvent.click(screen.getByRole('option'));
    act(() => details[0](null, 'REQUEST_DENIED'));
    expect((screen.getByRole('combobox') as HTMLInputElement).value).toBe(prediction.description);
  });

  it('does not fabricate coordinates for a selected place without geometry', async () => {
    const changed = vi.fn(); render(<Controlled changed={changed} />); await ready();
    await type('Main'); suggestions(); fireEvent.click(screen.getByRole('option'));
    act(() => details[0]({ ...place, geometry: undefined }, 'OK'));
    expect(changed).toHaveBeenLastCalledWith(place.formatted_address, undefined);
  });

  it('drops an old prediction response after newer typing', async () => {
    render(<Controlled />); await ready(); await type('Old'); await type('New');
    suggestions(0); expect(screen.queryByRole('option')).toBeNull();
    suggestions(1); expect(screen.getByRole('option')).toBeTruthy();
  });

  it('drops details after a manual edit and emits no stale coordinates', async () => {
    const changed = vi.fn(); render(<Controlled changed={changed} />); await ready();
    await type('Main'); suggestions(); fireEvent.click(screen.getByRole('option'));
    await type('My manual address');
    act(() => details[0](place, 'OK'));
    expect(changed).toHaveBeenLastCalledWith('My manual address', undefined);
  });

  it('drops an earlier selection after another selection', async () => {
    const changed = vi.fn(); render(<Controlled changed={changed} />); await ready();
    await type('One'); suggestions(); fireEvent.click(screen.getByRole('option'));
    await type('Two'); suggestions(1); fireEvent.click(screen.getByRole('option'));
    act(() => details[1]({ ...place, formatted_address: 'Second address' }, 'OK'));
    act(() => details[0](place, 'OK'));
    expect(changed.mock.calls.at(-1)?.[0]).toBe('Second address');
  });

  it('keeps manual typing usable while the loader is pending or rejected', async () => {
    provider.load.mockReturnValue(new Promise(() => {}));
    const view = render(<Controlled />); await type('Manual pending');
    expect((screen.getByRole('combobox') as HTMLInputElement).value).toBe('Manual pending');
    view.unmount();
    provider.load.mockRejectedValue(new Error('unavailable'));
    render(<Controlled />); await ready(); await type('Manual fallback');
    expect((screen.getByRole('combobox') as HTMLInputElement).value).toBe('Manual fallback');
    expect(getPredictions).not.toHaveBeenCalled();
  });

  it.each(['ZERO_RESULTS', 'REQUEST_DENIED'])('hides empty/error results: %s', async status => {
    render(<Controlled />); await ready(); await type('Main');
    act(() => predictions[0](null, status));
    expect(screen.queryByRole('listbox')).toBeNull();
    expect((screen.getByRole('combobox') as HTMLInputElement).value).toBe('Main');
  });

  it('cancels debounce and responses on clear, escape, blur and unmount', async () => {
    const changed = vi.fn(); const view = render(<Controlled changed={changed} />); await ready();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'Short' } });
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    expect(getPredictions).not.toHaveBeenCalled();
    await type('Escape'); fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Escape' }); suggestions(0);
    expect(screen.queryByRole('listbox')).toBeNull();
    await type('Blur'); fireEvent.blur(screen.getByRole('combobox')); suggestions(1);
    expect(screen.queryByRole('listbox')).toBeNull();
    await type('Last'); suggestions(2); fireEvent.click(screen.getByRole('option'));
    view.unmount(); changed.mockClear(); act(() => details[0](place, 'OK'));
    expect(changed).not.toHaveBeenCalled();
  });

  it('uses the latest callback and invalidates a pending response on a form reset', async () => {
    const old = vi.fn(), latest = vi.fn();
    const view = render(<PlacesAutocomplete value="" onChange={old} />); await ready();
    await type('Main'); suggestions(); fireEvent.click(screen.getByRole('option'));
    view.rerender(<PlacesAutocomplete value={prediction.description} onChange={latest} />);
    act(() => details[0](place, 'OK')); expect(latest).toHaveBeenCalled();
    await type('Other');
    view.rerender(<PlacesAutocomplete value="Saved record" onChange={latest} />);
    suggestions(1); expect(screen.queryByRole('listbox')).toBeNull();
  });
});

describe('#751 structured Address input', () => {
  it('maps address fields deterministically and calls the latest selection callback', async () => {
    const old = vi.fn(), latest = vi.fn();
    const view = render(<AddressAutocomplete countryCode="NG" onSelect={old} />); await ready();
    view.rerender(<AddressAutocomplete countryCode="GB" onSelect={latest} />);
    expect(native[0].restrict).toHaveBeenLastCalledWith({ country: 'gb' });
    act(() => native[0].listener!());
    expect(old).not.toHaveBeenCalled();
    expect(latest).toHaveBeenCalledWith({ address: '10 Main Street', city: 'Lagos', state: 'Lagos State', zipCode: '100001', country: 'NG', latitude: 6.5, longitude: 3.4, formattedAddress: place.formatted_address });
  });

  it('restores async saved values and forwards manual edits for invalidation', async () => {
    const manual = vi.fn();
    const view = render(<AddressAutocomplete defaultValue="" onSelect={vi.fn()} onManualChange={manual} />); await ready();
    view.rerender(<AddressAutocomplete defaultValue="Saved address" onSelect={vi.fn()} onManualChange={manual} />);
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('Saved address');
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Manual' } });
    expect(manual).toHaveBeenCalledWith('Manual');
  });

  it('uses postal town and formatted fallback without inventing coordinates', async () => {
    const selected = vi.fn(); render(<AddressAutocomplete onSelect={selected} />); await ready();
    native[0].place = { formatted_address: 'London address', address_components: [{ types: ['postal_town'], long_name: 'London', short_name: 'London' }] };
    act(() => native[0].listener!());
    expect(selected.mock.calls[0][0]).toMatchObject({ address: 'London address', city: 'London', latitude: undefined, longitude: undefined });
  });

  it('removes native listeners on unmount and initializes a fresh mount', async () => {
    const first = render(<AddressAutocomplete onSelect={vi.fn()} />); await ready();
    first.unmount(); expect(native[0].remove).toHaveBeenCalledOnce();
    render(<AddressAutocomplete onSelect={vi.fn()} />); await ready();
    expect(native).toHaveLength(2);
  });

  it('retains manual entry when Google cannot load', async () => {
    provider.load.mockRejectedValue(new Error('unavailable'));
    const manual = vi.fn(); render(<AddressAutocomplete onSelect={vi.fn()} onManualChange={manual} />); await ready();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Manual' } });
    expect(manual).toHaveBeenCalledWith('Manual');
    expect(native).toHaveLength(0);
  });
});
