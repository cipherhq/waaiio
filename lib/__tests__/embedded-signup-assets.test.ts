import { afterEach, expect, it, vi } from 'vitest';
import { listSignupPhones } from '@/lib/whatsapp/embedded-signup-assets';
afterEach(() => vi.unstubAllGlobals());
it('collects every page using cursors without following provider-supplied URLs', async () => {
  const fetchMock = vi.fn().mockResolvedValueOnce(Response.json({ data: [{ id: 'one' }], paging: { next: 'https://untrusted.example/steal', cursors: { after: 'cursor&2' } } }))
    .mockResolvedValueOnce(Response.json({ data: [{ id: 'two' }] }));
  vi.stubGlobal('fetch', fetchMock);
  expect(await listSignupPhones('account', 'secret')).toEqual([{ id: 'one' }, { id: 'two' }]);
  const url = new URL(fetchMock.mock.calls[1][0]);
  expect(url.origin).toBe('https://graph.facebook.com');
  expect(url.searchParams.get('after')).toBe('cursor&2');
  expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe('Bearer secret');
});
it('fails closed rather than returning a partial account on paging failure', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(Response.json({ data: [{ id: 'one' }], paging: { next: 'next', cursors: { after: 'cursor' } } }))
    .mockResolvedValueOnce(Response.json({}, { status: 403 })));
  await expect(listSignupPhones('account', 'secret')).rejects.toThrow('Unable to read');
});
