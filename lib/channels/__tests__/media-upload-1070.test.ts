/**
 * #1070: WhatsApp media is uploaded first (and sent by id) only for URLs on this
 * app's host or our Supabase Storage. Everything else keeps the `link` send and is
 * never fetched by the server. Real MetaCloudService; only HTTP is faked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MetaCloudService } from '@/lib/channels/meta-cloud';
import { isUploadSourceAllowed } from '@/lib/channels/media-upload';

const APP = 'https://www.waaiio.com';
const SUPA = 'https://projref.supabase.co';
const GRAPH = 'https://graph.facebook.com/';

type Route = (url: string, init?: RequestInit) => Promise<Response> | Response;
let fetchCalls: Array<{ url: string; init?: RequestInit }>;
let sourceRoute: Route;
let uploadRoute: Route;

function messageBody(): Record<string, any> {
  const call = fetchCalls.find(c => c.url.endsWith('/messages'));
  return JSON.parse(String(call?.init?.body));
}
function sourceFetches() {
  return fetchCalls.filter(c => !c.url.startsWith(GRAPH));
}
function png(bytes = 64) {
  return new Response(new Uint8Array(bytes), { status: 200, headers: { 'content-type': 'image/png', 'content-length': String(bytes) } });
}
function pdf(bytes = 64) {
  return new Response(new Uint8Array(bytes), { status: 200, headers: { 'content-type': 'application/pdf' } });
}

beforeEach(() => {
  process.env.NEXT_PUBLIC_APP_URL = APP;
  process.env.NEXT_PUBLIC_SUPABASE_URL = SUPA;
  fetchCalls = [];
  sourceRoute = () => png();
  uploadRoute = () => new Response(JSON.stringify({ id: 'MEDIA-1' }), { status: 200 });
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    fetchCalls.push({ url, init });
    if (url.startsWith(GRAPH) && url.endsWith('/media')) return uploadRoute(url, init);
    if (url.startsWith(GRAPH) && url.endsWith('/messages')) {
      return new Response(JSON.stringify({ messages: [{ id: 'wamid.SENT' }] }), { status: 200 });
    }
    return sourceRoute(url, init);
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.NEXT_PUBLIC_APP_URL;
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
});

const cloud = () => new MetaCloudService({ accessToken: 'test-token-placeholder', phoneNumberId: 'PNID' });

describe('#1070 allowlist', () => {
  it('allows only https app host (and its www/apex twin) and Supabase Storage paths', () => {
    expect(isUploadSourceAllowed(`${APP}/api/tickets/image?code=ABC`)).toBe(true);
    expect(isUploadSourceAllowed('https://waaiio.com/api/tickets/image?code=ABC')).toBe(true);
    expect(isUploadSourceAllowed(`${SUPA}/storage/v1/object/sign/documents/x.pdf?token=t`)).toBe(true);
    expect(isUploadSourceAllowed(`${SUPA}/rest/v1/payments`)).toBe(false);
    expect(isUploadSourceAllowed('http://www.waaiio.com/api/tickets/image')).toBe(false);
    expect(isUploadSourceAllowed('https://merchant-cdn.example.com/p.png')).toBe(false);
    expect(isUploadSourceAllowed('https://www.waaiio.com.evil.example/p.png')).toBe(false);
    expect(isUploadSourceAllowed('https://user:pw@www.waaiio.com/p.png')).toBe(false);
    expect(isUploadSourceAllowed('https://www.waaiio.com:8443/p.png')).toBe(false);
    expect(isUploadSourceAllowed('https://169.254.169.254/latest/meta-data')).toBe(false);
  });

  it('allows nothing on the app host when NEXT_PUBLIC_APP_URL is not https', () => {
    process.env.NEXT_PUBLIC_APP_URL = 'http://localhost:3000';
    expect(isUploadSourceAllowed('https://localhost:3000/api/tickets/image')).toBe(false);
    expect(isUploadSourceAllowed('https://localhost/api/tickets/image')).toBe(false);
  });
});

describe('#1070 upload before send', () => {
  it('allowlisted image is fetched, uploaded and sent by media id', async () => {
    const res = await cloud().sendImage({ to: '2348000000001', imageUrl: `${APP}/api/tickets/image?code=T1`, caption: 'c' });
    expect(res.messageId).toBe('wamid.SENT');
    expect(sourceFetches()).toHaveLength(1);
    expect(sourceFetches()[0].init?.redirect).toBe('manual');
    // The source fetch never carries the WhatsApp token.
    expect(JSON.stringify(sourceFetches()[0].init?.headers || {})).not.toContain('test-token-placeholder');
    const upload = fetchCalls.find(c => c.url.endsWith('/PNID/media'))!;
    const form = upload.init?.body as FormData;
    expect(form.get('messaging_product')).toBe('whatsapp');
    expect(form.get('type')).toBe('image/png');
    expect(messageBody().image).toEqual({ id: 'MEDIA-1', caption: 'c' });
  });

  it('allowlisted Supabase Storage document is uploaded and sent by id with its filename', async () => {
    sourceRoute = () => pdf();
    await cloud().sendDocument({ to: '2348000000001', documentUrl: `${SUPA}/storage/v1/object/sign/customer-reports/r.pdf?token=x`, filename: 'receipt-R1.pdf' });
    expect(messageBody().document).toEqual({ id: 'MEDIA-1', filename: 'receipt-R1.pdf' });
  });

  it('non-allowlisted merchant URL is never fetched and is sent by link', async () => {
    const url = 'https://merchant-cdn.example.com/product.png';
    await cloud().sendImage({ to: '2348000000001', imageUrl: url });
    expect(sourceFetches()).toHaveLength(0);
    expect(fetchCalls.some(c => c.url.endsWith('/media'))).toBe(false);
    expect(messageBody().image).toEqual({ link: url });
  });

  it('http:// URL on the app host is never fetched and is sent by link', async () => {
    const url = 'http://www.waaiio.com/api/tickets/image?code=T1';
    await cloud().sendImage({ to: '2348000000001', imageUrl: url });
    expect(sourceFetches()).toHaveLength(0);
    expect(messageBody().image).toEqual({ link: url });
  });

  it('redirect to another host is not followed and falls back to link', async () => {
    const url = `${APP}/api/images/redirector`;
    sourceRoute = (u) => u === url
      ? new Response(null, { status: 302, headers: { location: 'https://evil.example/x.png' } })
      : png();
    await cloud().sendImage({ to: '2348000000001', imageUrl: url });
    expect(sourceFetches().map(c => c.url)).toEqual([url]);
    expect(messageBody().image).toEqual({ link: url });
  });

  it('redirect between allowlisted hosts (www -> apex) is followed', async () => {
    const url = `${APP}/api/tickets/image?code=T1`;
    sourceRoute = (u) => u === url
      ? new Response(null, { status: 301, headers: { location: 'https://waaiio.com/api/tickets/image?code=T1' } })
      : png();
    await cloud().sendImage({ to: '2348000000001', imageUrl: url });
    expect(sourceFetches()).toHaveLength(2);
    expect(messageBody().image).toEqual({ id: 'MEDIA-1' });
  });

  it('oversized image (declared or streamed) falls back to link without uploading', async () => {
    const url = `${APP}/big.png`;
    sourceRoute = () => png(5 * 1024 * 1024 + 1);
    await cloud().sendImage({ to: '2348000000001', imageUrl: url });
    expect(fetchCalls.some(c => c.url.endsWith('/media'))).toBe(false);
    expect(messageBody().image).toEqual({ link: url });

    fetchCalls = [];
    sourceRoute = () => new Response(new Uint8Array(5 * 1024 * 1024 + 1), { status: 200, headers: { 'content-type': 'image/png' } });
    await cloud().sendImage({ to: '2348000000001', imageUrl: url });
    expect(fetchCalls.some(c => c.url.endsWith('/media'))).toBe(false);
    expect(messageBody().image).toEqual({ link: url });
  });

  it('unsupported content type (webp) falls back to link', async () => {
    const url = `${APP}/x.webp`;
    sourceRoute = () => new Response(new Uint8Array(10), { status: 200, headers: { 'content-type': 'image/webp' } });
    await cloud().sendImage({ to: '2348000000001', imageUrl: url });
    expect(messageBody().image).toEqual({ link: url });
  });

  it('source timeout falls back to link and disables uploads for the rest of the instance', async () => {
    const url = `${APP}/api/tickets/image?code=T1`;
    sourceRoute = () => { const e = new Error('timed out'); e.name = 'TimeoutError'; throw e; };
    const c = cloud();
    await c.sendImage({ to: '2348000000001', imageUrl: url });
    expect(messageBody().image).toEqual({ link: url });

    fetchCalls = [];
    sourceRoute = () => png();
    await c.sendImage({ to: '2348000000001', imageUrl: url });
    expect(sourceFetches()).toHaveLength(0);
    expect(messageBody().image).toEqual({ link: url });
  });

  it('upload failure (Meta 4xx/5xx or no id) falls back to link', async () => {
    const url = `${APP}/api/tickets/image?code=T1`;
    for (const failure of [
      () => new Response(JSON.stringify({ error: { message: 'bad' } }), { status: 400 }),
      () => new Response('oops', { status: 500 }),
      () => new Response(JSON.stringify({}), { status: 200 }),
    ]) {
      fetchCalls = [];
      uploadRoute = failure;
      await cloud().sendImage({ to: '2348000000001', imageUrl: url });
      expect(fetchCalls.some(c => c.url.endsWith('/media'))).toBe(true);
      expect(messageBody().image).toEqual({ link: url });
    }
  });

  it('non-2xx source falls back to link', async () => {
    const url = `${SUPA}/storage/v1/object/sign/documents/t.pdf?token=x`;
    sourceRoute = () => new Response('gone', { status: 404 });
    await cloud().sendDocument({ to: '2348000000001', documentUrl: url, filename: 't.pdf' });
    expect(messageBody().document).toEqual({ link: url, filename: 't.pdf' });
  });

  it('caller-provided media id is sent as-is without any fetch', async () => {
    await cloud().sendDocument({ to: '2348000000001', documentUrl: `${APP}/x.pdf`, filename: 'x.pdf', mediaId: 'PRE-ID' });
    expect(sourceFetches()).toHaveLength(0);
    expect(messageBody().document).toEqual({ id: 'PRE-ID', filename: 'x.pdf' });
  });
});

describe('#1070 total upload allowance per request (review P1)', () => {
  it('slices never exceed the per-upload cap and stop once the total allowance is used', async () => {
    const { nextUploadSliceMs, MEDIA_UPLOAD_BUDGET_MS, MEDIA_UPLOAD_TOTAL_BUDGET_MS } = await import('@/lib/channels/media-upload');
    expect(nextUploadSliceMs(0)).toBe(MEDIA_UPLOAD_BUDGET_MS);
    expect(nextUploadSliceMs(MEDIA_UPLOAD_TOTAL_BUDGET_MS - 2500)).toBe(2500);
    expect(nextUploadSliceMs(MEDIA_UPLOAD_TOTAL_BUDGET_MS - 500)).toBe(0);
    expect(nextUploadSliceMs(MEDIA_UPLOAD_TOTAL_BUDGET_MS)).toBe(0);
  });

  it('a many-ticket send stops uploading once slow uploads use the allowance, and the rest go by link', async () => {
    let clock = 0;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => clock);
    // Each upload takes 4.5 s (just under its own 6 s cap), so no timeout ever disables uploads.
    uploadRoute = () => { clock += 4500; return new Response(JSON.stringify({ id: 'MEDIA-SLOW' }), { status: 200 }); };
    const svc = cloud();
    const sentBy: string[] = [];
    for (let n = 1; n <= 6; n++) {
      fetchCalls = [];
      await svc.sendImage({ to: '2348000000001', imageUrl: `${APP}/api/tickets/image?code=T${n}` });
      const body = messageBody();
      sentBy.push(body.image.id ? 'id' : 'link');
    }
    nowSpy.mockRestore();
    // 4.5 + 4.5 = 9 s used; 1 s left is the minimum slice, so a third upload still starts;
    // after that the allowance is gone and every remaining ticket is sent by link at once.
    expect(sentBy.slice(0, 2)).toEqual(['id', 'id']);
    expect(sentBy.slice(-3)).toEqual(['link', 'link', 'link']);
    expect(sentBy.filter(s => s === 'id').length).toBeLessThanOrEqual(3);
  });
});
