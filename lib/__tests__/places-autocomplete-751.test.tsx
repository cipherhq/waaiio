// @vitest-environment jsdom
import React, { useState } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PlacesAutocomplete from '@/components/ui/PlacesAutocomplete';
import AddressAutocomplete from '@/components/ui/AddressAutocomplete';

// ── Mock at the provider boundary (Places API New, per-instance sessions) ──

const sessionMock = vi.hoisted(() => ({
  fetchPredictions: vi.fn(),
  fetchPlaceDetails: vi.fn(),
  reset: vi.fn(),
}));

const providerMock = vi.hoisted(() => ({
  createPlacesSession: vi.fn(() => sessionMock),
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
  sessionMock.fetchPredictions.mockReset();
  sessionMock.fetchPlaceDetails.mockReset();
  sessionMock.reset.mockReset();
  providerMock.createPlacesSession.mockReset().mockReturnValue(sessionMock);
  providerMock.isNewApiAvailable.mockReset().mockReturnValue(true);
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

function Controlled({ changed = vi.fn() }: { changed?: (...args: unknown[]) => void }) {
  const [value, setValue] = useState('');
  return <PlacesAutocomplete value={value} onChange={(text, data) => { setValue(text); changed(text, data); }} />;
}
async function ready() { await act(async () => { await Promise.resolve(); }); }
async function type(text: string) {
  sessionMock.fetchPredictions.mockResolvedValue([prediction]);
  fireEvent.change(screen.getByRole('combobox'), { target: { value: text } });
  await act(async () => { await vi.advanceTimersByTimeAsync(300); });
}

describe('#751 controlled Places input (New API)', () => {
  it('supports keyboard selection and structured coordinates/city', async () => {
    const changed = vi.fn();
    sessionMock.fetchPredictions.mockResolvedValue([prediction]);
    sessionMock.fetchPlaceDetails.mockResolvedValue(placeResult);
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
    sessionMock.fetchPredictions.mockResolvedValue([prediction]);
    sessionMock.fetchPlaceDetails.mockResolvedValue(placeResult);
    render(<Controlled changed={changed} />); await ready();
    await type('Main');
    fireEvent.click(screen.getByRole('option'));
    expect(changed).toHaveBeenLastCalledWith(prediction.description, undefined);
    fireEvent.blur(screen.getByRole('combobox'));
    await act(async () => { await Promise.resolve(); });
    expect(changed).toHaveBeenLastCalledWith(placeResult.formattedAddress, {
      address: placeResult.formattedAddress, lat: 6.5, lng: 3.4, city: 'Lagos', placeId: 'place-1',
    });
  });

  it('supports pointer/click selection and keeps text if details fail', async () => {
    sessionMock.fetchPredictions.mockResolvedValue([prediction]);
    sessionMock.fetchPlaceDetails.mockRejectedValue(new Error('Failed'));
    render(<Controlled />); await ready(); await type('Main');
    fireEvent.pointerDown(screen.getByRole('option'));
    fireEvent.click(screen.getByRole('option'));
    await act(async () => { await Promise.resolve(); });
    expect((screen.getByRole('combobox') as HTMLInputElement).value).toBe(prediction.description);
  });

  it('does not fabricate coordinates for a place without geometry', async () => {
    const changed = vi.fn();
    sessionMock.fetchPredictions.mockResolvedValue([prediction]);
    sessionMock.fetchPlaceDetails.mockResolvedValue({ ...placeResult, lat: undefined, lng: undefined });
    render(<Controlled changed={changed} />); await ready();
    await type('Main'); fireEvent.click(screen.getByRole('option'));
    await act(async () => { await Promise.resolve(); });
    expect(changed).toHaveBeenLastCalledWith(placeResult.formattedAddress, undefined);
  });

  it('drops stale predictions after newer typing', async () => {
    let callCount = 0;
    sessionMock.fetchPredictions.mockImplementation(() => {
      callCount++;
      if (callCount === 1) return new Promise(() => {});
      return Promise.resolve([prediction]);
    });
    render(<Controlled />); await ready();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'Old' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    expect(screen.queryByRole('option')).toBeNull();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'New' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    expect(screen.getByRole('option')).toBeTruthy();
  });

  it('drops details after a manual edit', async () => {
    const changed = vi.fn();
    sessionMock.fetchPredictions.mockResolvedValue([prediction]);
    let resolveDetails: (v: NormalizedPlaceResult) => void;
    sessionMock.fetchPlaceDetails.mockReturnValue(new Promise<NormalizedPlaceResult>(r => { resolveDetails = r; }));
    render(<Controlled changed={changed} />); await ready();
    await type('Main'); fireEvent.click(screen.getByRole('option'));
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'My manual address' } });
    sessionMock.fetchPredictions.mockResolvedValue([]);
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    resolveDetails!(placeResult);
    await act(async () => { await Promise.resolve(); });
    expect(changed).toHaveBeenLastCalledWith('My manual address', undefined);
  });

  it('keeps manual typing usable when loader fails', async () => {
    loader.loadGooglePlaces.mockRejectedValue(new Error('unavailable'));
    render(<Controlled />); await ready();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'Manual fallback' } });
    expect((screen.getByRole('combobox') as HTMLInputElement).value).toBe('Manual fallback');
    expect(sessionMock.fetchPredictions).not.toHaveBeenCalled();
  });

  it('creates a per-instance session on mount', async () => {
    render(<Controlled />); await ready();
    expect(providerMock.createPlacesSession).toHaveBeenCalledOnce();
  });

  it('resets session on unmount', async () => {
    const view = render(<Controlled />); await ready();
    view.unmount();
    expect(sessionMock.reset).toHaveBeenCalled();
  });

  it('resets session on value change from parent', async () => {
    const view = render(<PlacesAutocomplete value="" onChange={vi.fn()} />); await ready();
    sessionMock.reset.mockClear();
    view.rerender(<PlacesAutocomplete value="Saved record" onChange={vi.fn()} />);
    expect(sessionMock.reset).toHaveBeenCalled();
  });
});

describe('#751 structured Address input (New API)', () => {
  it('maps address fields and calls the latest selection callback', async () => {
    sessionMock.fetchPredictions.mockResolvedValue([prediction]);
    sessionMock.fetchPlaceDetails.mockResolvedValue(placeResult);
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

  it('does not send unsupported includedPrimaryTypes: address', async () => {
    sessionMock.fetchPredictions.mockResolvedValue([]);
    render(<AddressAutocomplete countryCode="NG" onSelect={vi.fn()} />); await ready();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'Main' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    const call = sessionMock.fetchPredictions.mock.calls[0]?.[0];
    expect(call).toBeTruthy();
    expect(call.includedRegionCodes).toEqual(['ng']);
    // Must not include unsupported 'address' type
    expect(call.includedPrimaryTypes).toBeUndefined();
  });

  it('notifies parent on selection text (before details)', async () => {
    sessionMock.fetchPredictions.mockResolvedValue([prediction]);
    sessionMock.fetchPlaceDetails.mockReturnValue(new Promise(() => {})); // hang
    const manual = vi.fn();
    render(<AddressAutocomplete onSelect={vi.fn()} onManualChange={manual} />); await ready();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'Main' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    fireEvent.click(screen.getByRole('option'));
    expect(manual).toHaveBeenCalledWith(prediction.description);
  });

  it('invalidates predictions on external defaultValue change', async () => {
    sessionMock.fetchPredictions.mockResolvedValue([prediction]);
    const view = render(<AddressAutocomplete defaultValue="" onSelect={vi.fn()} />); await ready();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'Main' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    expect(screen.getByRole('option')).toBeTruthy();
    // Parent changes defaultValue — predictions must clear
    view.rerender(<AddressAutocomplete defaultValue="New saved value" onSelect={vi.fn()} />);
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(sessionMock.reset).toHaveBeenCalled();
  });

  it('invalidates predictions on country change', async () => {
    sessionMock.fetchPredictions.mockResolvedValue([prediction]);
    const view = render(<AddressAutocomplete countryCode="NG" onSelect={vi.fn()} />); await ready();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'Main' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    sessionMock.reset.mockClear();
    view.rerender(<AddressAutocomplete countryCode="GB" onSelect={vi.fn()} />);
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(sessionMock.reset).toHaveBeenCalled();
  });

  it('restores saved values and forwards manual edits', async () => {
    const manual = vi.fn();
    const view = render(<AddressAutocomplete defaultValue="" onSelect={vi.fn()} onManualChange={manual} />); await ready();
    view.rerender(<AddressAutocomplete defaultValue="Saved address" onSelect={vi.fn()} onManualChange={manual} />);
    expect((screen.getByRole('combobox') as HTMLInputElement).value).toBe('Saved address');
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'Manual' } });
    expect(manual).toHaveBeenCalledWith('Manual');
  });

  it('uses formatted fallback without inventing coordinates', async () => {
    const noGeoResult: NormalizedPlaceResult = {
      ...placeResult, formattedAddress: 'London address',
      components: { ...placeResult.components, streetNumber: '', route: '', city: 'London' },
      lat: undefined, lng: undefined,
    };
    sessionMock.fetchPredictions.mockResolvedValue([prediction]);
    sessionMock.fetchPlaceDetails.mockResolvedValue(noGeoResult);
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

  it('shows dropdown with Google attribution', async () => {
    sessionMock.fetchPredictions.mockResolvedValue([prediction]);
    render(<AddressAutocomplete onSelect={vi.fn()} />); await ready();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'Main' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    expect(screen.getByRole('listbox')).toBeTruthy();
    expect(screen.getByText('Powered by Google')).toBeTruthy();
  });

  it('no Legacy constructor is called in migrated paths', async () => {
    const legacyConstructors = {
      AutocompleteService: vi.fn(), PlacesService: vi.fn(), Autocomplete: vi.fn(),
    };
    vi.stubGlobal('google', { maps: { places: legacyConstructors } });
    sessionMock.fetchPredictions.mockResolvedValue([prediction]);
    sessionMock.fetchPlaceDetails.mockResolvedValue(placeResult);
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

  it('clears input resets the session', async () => {
    sessionMock.fetchPredictions.mockResolvedValue([prediction]);
    render(<AddressAutocomplete onSelect={vi.fn()} />); await ready();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'Main' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    sessionMock.reset.mockClear();
    // Clear the input
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '' } });
    expect(sessionMock.reset).toHaveBeenCalled();
  });

  it('controlled parent echo: typing yields suggestions, deferred selection after blur delivers structured fields', async () => {
    // Simulates StepDetails/Discovery: onManualChange feeds back into defaultValue
    sessionMock.fetchPredictions.mockResolvedValue([prediction]);
    // Details are deferred — unresolved through blur
    let resolveDetails!: (v: NormalizedPlaceResult) => void;
    sessionMock.fetchPlaceDetails.mockReturnValue(new Promise<NormalizedPlaceResult>(r => { resolveDetails = r; }));
    const selectedFields = vi.fn();
    function ParentEcho() {
      const [addr, setAddr] = useState('');
      return (
        <AddressAutocomplete
          defaultValue={addr}
          onManualChange={setAddr}
          onSelect={(r) => { setAddr(r.formattedAddress || ''); selectedFields(r); }}
        />
      );
    }
    render(<ParentEcho />); await ready();
    // Type — parent echoes the text back as defaultValue
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'Main St' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    // Predictions should still appear (not cancelled by echo)
    expect(sessionMock.fetchPredictions).toHaveBeenCalled();
    expect(screen.getByRole('option')).toBeTruthy();
    // Select — details still pending
    fireEvent.click(screen.getByRole('option'));
    expect(selectedFields).not.toHaveBeenCalled();
    // Blur while details are still unresolved
    fireEvent.blur(screen.getByRole('combobox'));
    expect(selectedFields).not.toHaveBeenCalled();
    // Now resolve details — structured fields should still reach the parent
    resolveDetails(placeResult);
    await act(async () => { await Promise.resolve(); });
    expect(selectedFields).toHaveBeenCalledOnce();
    expect(selectedFields).toHaveBeenCalledWith(expect.objectContaining({
      address: '10 Main Street',
      city: 'Lagos',
      state: 'Lagos State',
      zipCode: '100001',
      country: 'NG',
      latitude: 6.5,
      longitude: 3.4,
      formattedAddress: placeResult.formattedAddress,
    }));
    expect((screen.getByRole('combobox') as HTMLInputElement).value).toBe(placeResult.formattedAddress);
  });

  it('PlacesAutocomplete clears input resets the session', async () => {
    sessionMock.fetchPredictions.mockResolvedValue([prediction]);
    render(<Controlled />); await ready();
    await type('Main');
    sessionMock.reset.mockClear();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '' } });
    expect(sessionMock.reset).toHaveBeenCalled();
  });
});
