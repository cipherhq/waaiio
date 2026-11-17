// #1085: MetaCloudService.downloadMediaWithin enforces the 10 MB limit at the
// network layer: Meta's file_size before any download, then content-length,
// then the bytes actually streamed. fetch is mocked; nothing leaves the machine.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MetaCloudService } from '@/lib/channels/meta-cloud';

const MAX = 10;
const service = () => new MetaCloudService({ accessToken: 'token', phoneNumberId: 'pnid', wabaId: 'waba' } as never);
function stream(chunks: number[]) {
  let i = 0;
  const cancel = vi.fn();
  const body = { getReader: () => ({ read: async () => (i < chunks.length ? { done: false, value: new Uint8Array(chunks[i++]) } : { done: true, value: undefined }), cancel }), cancel };
  return { body, cancel };
}
function mockFetch(info: Record<string, unknown> | null, media?: { length?: string; chunks: number[] }) {
  const calls: string[] = [];
  const media$ = media ? stream(media.chunks) : null;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    calls.push(url);
    if (calls.length === 1) return { ok: !!info, json: async () => info };
    return { ok: true, body: media$!.body, headers: { get: (h: string) => (h === 'content-length' ? media?.length ?? null : 'image/jpeg') } };
  }));
  return { calls, cancel: media$?.cancel };
}
afterEach(() => vi.unstubAllGlobals());

describe('#1085 downloadMediaWithin', () => {
  it('refuses on Meta’s file_size without downloading', async () => {
    const { calls } = mockFetch({ url: 'https://media', file_size: MAX + 1, mime_type: 'image/jpeg' });
    expect(await service().downloadMediaWithin('m1', MAX)).toEqual({ ok: false, reason: 'too_large' });
    expect(calls).toHaveLength(1);
  });

  it('refuses on a declared content-length over the limit', async () => {
    const { cancel } = mockFetch({ url: 'https://media', mime_type: 'image/jpeg' }, { length: String(MAX + 1), chunks: [MAX + 1] });
    expect(await service().downloadMediaWithin('m1', MAX)).toEqual({ ok: false, reason: 'too_large' });
    expect(cancel).toHaveBeenCalled();
  });

  it('stops reading as soon as the streamed bytes pass the limit, even with no size given', async () => {
    const { cancel } = mockFetch({ url: 'https://media', mime_type: 'image/jpeg' }, { chunks: [6, 6, 6] });
    expect(await service().downloadMediaWithin('m1', MAX)).toEqual({ ok: false, reason: 'too_large' });
    expect(cancel).toHaveBeenCalled();
  });

  it('returns the bytes when within the limit', async () => {
    mockFetch({ url: 'https://media', file_size: MAX, mime_type: 'image/png' }, { length: String(MAX), chunks: [4, 6] });
    const result = await service().downloadMediaWithin('m1', MAX);
    expect(result).toMatchObject({ ok: true, mimeType: 'image/png' });
    expect(result.ok && result.buffer.length).toBe(MAX);
  });

  it('is unavailable (never throws) when Meta has no link or errors', async () => {
    mockFetch(null);
    expect(await service().downloadMediaWithin('m1', MAX)).toEqual({ ok: false, reason: 'unavailable' });
    mockFetch({ mime_type: 'image/jpeg' });
    expect(await service().downloadMediaWithin('m1', MAX)).toEqual({ ok: false, reason: 'unavailable' });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network'); }));
    expect(await service().downloadMediaWithin('m1', MAX)).toEqual({ ok: false, reason: 'unavailable' });
  });
});
