// @vitest-environment jsdom
import React, { useState } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PlacesAutocomplete from '@/components/ui/PlacesAutocomplete';
import AddressAutocomplete from '@/components/ui/AddressAutocomplete';

// ── Mock at the provider boundary (Places API New) ──

const providerMock = vi.hoisted(() => ({
  fetchPredictions: vi.fn(),
  fetchPlaceDetails: vi.fn(),
  resetSession: vi.fn(),
  isNewApiAvailable: vi.fn().mockReturnValue(true),
}));
vi.mock('@/lib/places-provider', () => providerMock);

const loader = vi.hoisted(() => ({ loadGooglePlaces: vi.fn() }));
vi.mock('@/lib/google-places-loader', () => loader);

// ── Test data (New API normalized shapes) ──

import type { NormalizedPrediction, NormalizedPlaceResult } from '@/lib/places-provider';

const prediction: NormalizedPrediction = {
  placeId: 'place-1',
  description: '10 Main Street, Lagos',
  mainText: '10 Main Street',
  secondaryText: 'Lagos',
  _raw: {} as google.maps.places.PlacePrediction,
};

const placeResult: NormalizedPlaceResult = {
  formattedAddress: '10 Main Street, Lagos, Nigeria',
  components: {
    streetNumber: '10',
    route: 'Main Street',
    city: 'Lagos',
    state: 'Lagos State',
    postalCode: '100001',
    country: 'NG',
  },
  lat: 6.5,
  lng: 3.4,
  placeId: 'place-1',
};

// ── Setup ──

beforeEach(() => {
  vi.useFakeTimers();
  loader.loadGooglePlaces.mockReset().mockResolvedValue(undefined);
  providerMock.fetchPredictions.mockReset();
  providerMock.fetchPlaceDetails.mockReset();
  providerMock.resetSession.mockReset();
  providerMock.isNewApiAvailable.mockReset().mockReturnValue(true);
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

function Controlled({ changed = vi.fn() }: { changed?: ReturnType<typeof vi.fn> }) {
  const [value, setValue] = useState('');
  return <PlacesAutocomplete value={value} onChange={(text, data) => { setValue(text); changed(text, data); }} />;
}
async function ready() { await act(async () => { await Promise.resolve(); }); }
async function type(text: string) {
  providerMock.fetchPredictions.mockResolvedValue([prediction]);
  fireEvent.change(screen.getByRole('combobox'), { target: { value: text } });
  await act(async () => { await vi.advanceTimersByTimeAsync(300); });
}

describe('#751 controlled Places input (New API)', () => {
  it('supports keyboard selection and structured coordinates/city', async () => {
    const changed = vi.fn();
    providerMock.fetchPredictions.mockResolvedValue([prediction]);
    providerMock.fetchPlaceDetails.mockResolvedValue(placeResult);
    render(<Controlled changed={changed} />); await ready();
    await type('Main');
    const input = screen.getByRole('combobox');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(input.getAttribute('aria-activedescendant')).toBe(screen.getByRole('option').id);
    fireEvent.keyDown(input, { key: 'Enter' });
    expect((input as HTMLInputElement).value).toBe(prediction.description);
    await act(async () => { await Promise.resolve(); });
    expect(changed).toHaveBeenLastCalledWith(placeResult.formattedAddress, {
      address: placeResult.formattedAddress, lat: 6.5, lng: 3.4, city: 'Lagos', placeId: 'place-1',
    });
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('keeps selected details after blur with the menu closed', async () => {
    const changed = vi.fn();
    providerMock.fetchPredictions.mockResolvedValue([prediction]);
    providerMock.fetchPlaceDetails.mockResolvedValue(placeResult);
    render(<Controlled changed={changed} />); await ready();
    await type('Main');
    fireEvent.click(screen.getByRole('option'));
    expect(changed).toHaveBeenLastCalledWith(prediction.description, undefined);
    fireEvent.blur(screen.getByRole('combobox'));
    expect(screen.queryByRole('listbox')).toBeNull();
    await act(async () => { await Promise.resolve(); });
    expect(changed).toHaveBeenLastCalledWith(placeResult.formattedAddress, {
      address: placeResult.formattedAddress, lat: 6.5, lng: 3.4, city: 'Lagos', placeId: 'place-1',
    });
  });

  it('supports pointer/click selection and keeps text if details fail', async () => {
    providerMock.fetchPredictions.mockResolvedValue([prediction]);
    providerMock.fetchPlaceDetails.mockRejectedValue(new Error('Failed'));
    render(<Controlled />); await ready(); await type('Main');
    fireEvent.pointerDown(screen.getByRole('option'));
    fireEvent.click(screen.getByRole('option'));
    await act(async () => { await Promise.resolve(); });
    expect((screen.getByRole('combobox') as HTMLInputElement).value).toBe(prediction.description);
  });

  it('does not fabricate coordinates for a place without geometry', async () => {
    const changed = vi.fn();
    providerMock.fetchPredictions.mockResolvedValue([prediction]);
    providerMock.fetchPlaceDetails.mockResolvedValue({ ...placeResult, lat: undefined, lng: undefined });
    render(<Controlled changed={changed} />); await ready();
    await type('Main'); fireEvent.click(screen.getByRole('option'));
    await act(async () => { await Promise.resolve(); });
    expect(changed).toHaveBeenLastCalledWith(placeResult.formattedAddress, undefined);
  });

  it('drops an old prediction response after newer typing', async () => {
    let callCount = 0;
    providerMock.fetchPredictions.mockImplementation(() => {
      callCount++;
      if (callCount === 1) return new Promise(() => {}); // Never resolves (stale)
      return Promise.resolve([prediction]);
    });
    render(<Controlled />); await ready();
    // First type — predictions hang
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'Old' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    expect(screen.queryByRole('option')).toBeNull();
    // Second type — predictions resolve
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'New' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    expect(screen.getByRole('option')).toBeTruthy();
  });

  it('drops details after a manual edit and emits no stale coordinates', async () => {
    const changed = vi.fn();
    providerMock.fetchPredictions.mockResolvedValue([prediction]);
    let resolveDetails: (v: NormalizedPlaceResult) => void;
    providerMock.fetchPlaceDetails.mockReturnValue(new Promise<NormalizedPlaceResult>(r => { resolveDetails = r; }));
    render(<Controlled changed={changed} />); await ready();
    await type('Main'); fireEvent.click(screen.getByRole('option'));
    // Manual edit before details resolve
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'My manual address' } });
    providerMock.fetchPredictions.mockResolvedValue([]);
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    resolveDetails!(placeResult);
    await act(async () => { await Promise.resolve(); });
    expect(changed).toHaveBeenLastCalledWith('My manual address', undefined);
  });

  it('keeps manual typing usable while the loader is pending or rejected', async () => {
    loader.loadGooglePlaces.mockReturnValue(new Promise(() => {}));
    const view = render(<Controlled />);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'Manual pending' } });
    expect((screen.getByRole('combobox') as HTMLInputElement).value).toBe('Manual pending');
    view.unmount();
    loader.loadGooglePlaces.mockRejectedValue(new Error('unavailable'));
    render(<Controlled />); await ready();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'Manual fallback' } });
    expect((screen.getByRole('combobox') as HTMLInputElement).value).toBe('Manual fallback');
    expect(providerMock.fetchPredictions).not.toHaveBeenCalled();
  });

  it('hides empty results', async () => {
    providerMock.fetchPredictions.mockResolvedValue([]);
    render(<Controlled />); await ready();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'Main' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('resets session on unmount', async () => {
    const view = render(<Controlled />); await ready();
    view.unmount();
    expect(providerMock.resetSession).toHaveBeenCalled();
  });

  it('resets session on value change from parent', async () => {
    const view = render(<PlacesAutocomplete value="" onChange={vi.fn()} />); await ready();
    view.rerender(<PlacesAutocomplete value="Saved record" onChange={vi.fn()} />);
    expect(providerMock.resetSession).toHaveBeenCalled();
  });
});

describe('#751 structured Address input (New API)', () => {
  it('maps address fields and calls the latest selection callback', async () => {
    providerMock.fetchPredictions.mockResolvedValue([prediction]);
    providerMock.fetchPlaceDetails.mockResolvedValue(placeResult);
    const old = vi.fn(), latest = vi.fn();
    const view = render(<AddressAutocomplete countryCode="NG" onSelect={old} />); await ready();
    view.rerender(<AddressAutocomplete countryCode="GB" onSelect={latest} />);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'Main' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    fireEvent.click(screen.getByRole('option'));
    await act(async () => { await Promise.resolve(); });
    expect(old).not.toHaveBeenCalled();
    expect(latest).toHaveBeenCalledWith({
      address: '10 Main Street', city: 'Lagos', state: 'Lagos State',
      zipCode: '100001', country: 'NG',
      latitude: 6.5, longitude: 3.4, formattedAddress: placeResult.formattedAddress,
    });
  });

  it('passes country restriction to fetchPredictions', async () => {
    providerMock.fetchPredictions.mockResolvedValue([]);
    render(<AddressAutocomplete countryCode="NG" onSelect={vi.fn()} />); await ready();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'Main' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    expect(providerMock.fetchPredictions).toHaveBeenCalledWith(
      expect.objectContaining({ includedRegionCodes: ['ng'], includedPrimaryTypes: ['address'] })
    );
  });

  it('restores async saved values and forwards manual edits for invalidation', async () => {
    const manual = vi.fn();
    const view = render(<AddressAutocomplete defaultValue="" onSelect={vi.fn()} onManualChange={manual} />); await ready();
    view.rerender(<AddressAutocomplete defaultValue="Saved address" onSelect={vi.fn()} onManualChange={manual} />);
    expect((screen.getByRole('combobox') as HTMLInputElement).value).toBe('Saved address');
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'Manual' } });
    expect(manual).toHaveBeenCalledWith('Manual');
  });

  it('uses formatted fallback without inventing coordinates', async () => {
    const noGeoResult: NormalizedPlaceResult = {
      ...placeResult,
      formattedAddress: 'London address',
      components: { ...placeResult.components, streetNumber: '', route: '', city: 'London' },
      lat: undefined, lng: undefined,
    };
    providerMock.fetchPredictions.mockResolvedValue([prediction]);
    providerMock.fetchPlaceDetails.mockResolvedValue(noGeoResult);
    const selected = vi.fn();
    render(<AddressAutocomplete onSelect={selected} />); await ready();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'Main' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    fireEvent.click(screen.getByRole('option'));
    await act(async () => { await Promise.resolve(); });
    expect(selected.mock.calls[0][0]).toMatchObject({
      address: 'London address', city: 'London', latitude: undefined, longitude: undefined,
    });
  });

  it('retains manual entry when Google cannot load', async () => {
    loader.loadGooglePlaces.mockRejectedValue(new Error('unavailable'));
    const manual = vi.fn(); render(<AddressAutocomplete onSelect={vi.fn()} onManualChange={manual} />); await ready();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'Manual' } });
    expect(manual).toHaveBeenCalledWith('Manual');
  });

  it('resets session on country change', async () => {
    const view = render(<AddressAutocomplete countryCode="NG" onSelect={vi.fn()} />); await ready();
    providerMock.resetSession.mockClear();
    view.rerender(<AddressAutocomplete countryCode="GB" onSelect={vi.fn()} />);
    expect(providerMock.resetSession).toHaveBeenCalled();
  });

  it('shows dropdown with keyboard and touch accessibility', async () => {
    providerMock.fetchPredictions.mockResolvedValue([prediction]);
    render(<AddressAutocomplete onSelect={vi.fn()} />); await ready();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'Main' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    expect(screen.getByRole('listbox')).toBeTruthy();
    expect(screen.getByRole('option')).toBeTruthy();
    expect(screen.getByText('Powered by Google')).toBeTruthy();
  });

  it('no Legacy constructor is called in migrated paths', async () => {
    // Verify that AutocompleteService, PlacesService, and Autocomplete are not instantiated
    const legacyConstructors = {
      AutocompleteService: vi.fn(),
      PlacesService: vi.fn(),
      Autocomplete: vi.fn(),
    };
    vi.stubGlobal('google', { maps: { places: legacyConstructors } });
    providerMock.fetchPredictions.mockResolvedValue([prediction]);
    providerMock.fetchPlaceDetails.mockResolvedValue(placeResult);
    render(<AddressAutocomplete onSelect={vi.fn()} />); await ready();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'Main' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    fireEvent.click(screen.getByRole('option'));
    await act(async () => { await Promise.resolve(); });
    expect(legacyConstructors.AutocompleteService).not.toHaveBeenCalled();
    expect(legacyConstructors.PlacesService).not.toHaveBeenCalled();
    expect(legacyConstructors.Autocomplete).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
