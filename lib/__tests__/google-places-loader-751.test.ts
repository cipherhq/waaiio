// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.stubEnv('NEXT_PUBLIC_GOOGLE_MAPS_API_KEY', '');
  vi.stubEnv('NEXT_PUBLIC_GOOGLE_PLACES_API_KEY', '');
  vi.stubGlobal('google', undefined);
  document.head.querySelectorAll('script').forEach(script => script.remove());
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
const script = () => document.querySelector<HTMLScriptElement>('script[src*="maps.googleapis.com/maps/api/js"]')!;

describe('#751 shared Google Places loader', () => {
  it.each(['NEXT_PUBLIC_GOOGLE_MAPS_API_KEY', 'NEXT_PUBLIC_GOOGLE_PLACES_API_KEY'])('loads with %s without duplicate injection', async key => {
    vi.stubEnv(key, 'test-browser-key');
    const { loadGooglePlaces } = await import('@/lib/google-places-loader');
    const first = loadGooglePlaces();
    const second = loadGooglePlaces();
    expect(first).toBe(second);
    expect(document.querySelectorAll('script').length).toBe(1);
    expect(new URL(script().src).searchParams.get('libraries')).toBe('places');
    vi.stubGlobal('google', { maps: { places: {} } });
    script().dispatchEvent(new Event('load'));
    await first;
    await loadGooglePlaces();
    expect(document.querySelectorAll('script').length).toBe(1);
  });

  it('rejects missing config without injecting a script', async () => {
    const { loadGooglePlaces } = await import('@/lib/google-places-loader');
    await expect(loadGooglePlaces()).rejects.toThrow('not configured');
    expect(script()).toBeNull();
  });

  it('shares an existing in-flight script', async () => {
    vi.stubEnv('NEXT_PUBLIC_GOOGLE_MAPS_API_KEY', 'test-browser-key');
    const existing = document.createElement('script');
    existing.src = 'https://maps.googleapis.com/maps/api/js?libraries=places';
    document.head.appendChild(existing);
    const { loadGooglePlaces } = await import('@/lib/google-places-loader');
    const ready = loadGooglePlaces();
    vi.stubGlobal('google', { maps: { places: {} } });
    existing.dispatchEvent(new Event('load'));
    await ready;
    expect(document.querySelectorAll('script').length).toBe(1);
  });

  it('uses an already loaded library without config or injection', async () => {
    vi.stubGlobal('google', { maps: { places: {} } });
    const { loadGooglePlaces } = await import('@/lib/google-places-loader');
    await loadGooglePlaces();
    expect(script()).toBeNull();
  });

  it('adds Places through an existing importLibrary loader', async () => {
    vi.stubEnv('NEXT_PUBLIC_GOOGLE_MAPS_API_KEY', 'test-browser-key');
    const maps = { places: undefined as object | undefined, importLibrary: vi.fn(async () => { maps.places = {}; }) };
    vi.stubGlobal('google', { maps });
    const { loadGooglePlaces } = await import('@/lib/google-places-loader');
    await loadGooglePlaces();
    expect(maps.importLibrary).toHaveBeenCalledWith('places');
    expect(script()).toBeNull();
  });

  it('rejects failed load and permits a later mount to retry', async () => {
    vi.stubEnv('NEXT_PUBLIC_GOOGLE_MAPS_API_KEY', 'test-browser-key');
    const { loadGooglePlaces } = await import('@/lib/google-places-loader');
    const ready = loadGooglePlaces();
    const rejected = expect(ready).rejects.toThrow('unavailable');
    script().dispatchEvent(new Event('error'));
    await rejected;
    expect(script()).toBeNull();
    const retry = loadGooglePlaces();
    vi.stubGlobal('google', { maps: { places: {} } });
    script().dispatchEvent(new Event('load'));
    await retry;
  });

  it('times out instead of leaving subscribers pending forever', async () => {
    vi.stubEnv('NEXT_PUBLIC_GOOGLE_MAPS_API_KEY', 'test-browser-key');
    const { loadGooglePlaces } = await import('@/lib/google-places-loader');
    const rejected = expect(loadGooglePlaces()).rejects.toThrow('unavailable');
    await vi.advanceTimersByTimeAsync(15000);
    await rejected;
    expect(script()).toBeNull();
  });

  it('rejects a load event without a usable Google library', async () => {
    vi.stubEnv('NEXT_PUBLIC_GOOGLE_MAPS_API_KEY', 'test-browser-key');
    const { loadGooglePlaces } = await import('@/lib/google-places-loader');
    const rejected = expect(loadGooglePlaces()).rejects.toThrow('unavailable');
    script().dispatchEvent(new Event('load'));
    await rejected;
  });
});
