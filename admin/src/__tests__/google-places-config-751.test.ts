// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfigFromFile } from 'vite';
import { resolve } from 'node:path';

const keys = ['VITE_GOOGLE_MAPS_API_KEY', 'VITE_GOOGLE_PLACES_API_KEY', 'NEXT_PUBLIC_GOOGLE_MAPS_API_KEY', 'NEXT_PUBLIC_GOOGLE_PLACES_API_KEY'];
afterEach(() => vi.unstubAllEnvs());
describe('#751 explicit Admin browser-key mapping', () => {
  it.each(keys)('maps only the allowlisted browser key %s', async key => {
    for (const name of keys) vi.stubEnv(name, '');
    vi.stubEnv(key, 'synthetic-browser-key');
    vi.stubEnv('SERVER_PRIVATE_KEY', 'synthetic-server-secret');
    const loaded = await loadConfigFromFile({ mode: 'test', command: 'build' }, resolve('vite.config.js'));
    if (!loaded) throw new Error('Admin Vite config unavailable');
    const result = loaded.config;
    const target = key.includes('PLACES') ? 'process.env.NEXT_PUBLIC_GOOGLE_PLACES_API_KEY' : 'process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY';
    expect(result.define[target]).toBe(JSON.stringify('synthetic-browser-key'));
    expect(Object.keys(result.define).sort()).toEqual(['__WAAIIO_ADMIN_BUILD_IDENTITY__', 'process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY', 'process.env.NEXT_PUBLIC_GOOGLE_PLACES_API_KEY'].sort());
    expect(JSON.stringify(result.define)).not.toContain('synthetic-server-secret');
  });
});
