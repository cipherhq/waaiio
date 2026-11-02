import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
const mocks = vi.hoisted(() => ({ lookup: vi.fn(), request: vi.fn() }));
vi.mock('node:dns/promises', () => ({ lookup: mocks.lookup }));
vi.mock('node:http', () => ({ request: mocks.request }));
vi.mock('node:https', () => ({ request: mocks.request }));
import { isPublicAddress, sendPublicWebhook, validateWebhookDestination } from './public-destination';

beforeEach(() => { vi.resetAllMocks(); mocks.lookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]); });
function respond(status = 200, location?: string, body = 'ok') {
  mocks.request.mockImplementationOnce((_url, options, callback) => {
    const request = new EventEmitter() as EventEmitter & { end: ReturnType<typeof vi.fn> };
    request.end = vi.fn(() => {
      const response = Object.assign(new EventEmitter(), { statusCode: status, headers: { location }, destroy: vi.fn() });
      callback(response);
      response.emit('data', Buffer.from(body)); response.emit('end');
    });
    return request;
  });
}
describe('public webhook destination boundary', () => {
  it.each(['127.0.0.1','0.0.0.0','10.0.0.1','100.64.0.1','169.254.169.254','172.16.1.2','192.168.1.2','192.0.2.1','198.18.0.1','224.0.0.1','255.255.255.255','::1','::','::ffff:127.0.0.1','fc00::1','fe80::1','2001:db8::1','2002:7f00:1::'])('rejects nonpublic %s', address => expect(isPublicAddress(address)).toBe(false));
  it.each(['93.184.216.34','8.8.8.8','2606:4700:4700::1111'])('allows public %s', address => expect(isPublicAddress(address)).toBe(true));
  it.each(['file:///etc/passwd','ftp://example.com','https://user:pass@example.com','http://2130706433','http://0x7f000001','http://[::ffff:127.0.0.1]'])('rejects unsafe URL %s', async url => { await expect(validateWebhookDestination(url)).rejects.toThrow(); });
  it('rejects mixed or empty DNS answers and resolution failures', async () => {
    mocks.lookup.mockResolvedValueOnce([{address:'8.8.8.8',family:4},{address:'127.0.0.1',family:4}]).mockResolvedValueOnce([]).mockRejectedValueOnce(new Error('dns'));
    for (let i=0;i<3;i++) await expect(validateWebhookDestination('https://example.com')).rejects.toThrow();
    expect(mocks.request).not.toHaveBeenCalled();
  });
  it('preserves signed POST and pins actual transport lookup', async () => {
    respond(); const headers = {'Content-Type':'application/json','X-Webhook-Signature':'signature'};
    expect(await sendPublicWebhook('https://example.com/hook', headers, '{"test":true}')).toEqual({status:200,location:undefined,text:'ok'});
    const [url, options] = mocks.request.mock.calls[0];
    expect(url.hostname).toBe('example.com'); expect(options.headers).toEqual(headers); expect(options.agent).toBe(false);
    const callback = vi.fn(); options.lookup('example.com', {all:true}, callback);
    expect(callback).toHaveBeenCalledWith(null,[{address:'93.184.216.34',family:4}]);
    expect(mocks.lookup).toHaveBeenCalledTimes(1);
    expect(mocks.request.mock.results[0].value.end).toHaveBeenCalledWith('{"test":true}');
  });
  it('denies redirect to private destination before another request', async () => {
    respond(307,'http://127.0.0.1/private');
    await expect(sendPublicWebhook('https://example.com',{},'x')).rejects.toThrow();
    expect(mocks.request).toHaveBeenCalledTimes(1);
  });
  it.each([301,302,303,307,308])('preserves method semantics for %s', async status => {
    respond(status,'/next'); respond(); await sendPublicWebhook('https://example.com',{},'x');
    expect(mocks.request.mock.calls[1][1].method).toBe(status===307||status===308?'POST':'GET');
    expect(mocks.request.mock.results[1].value.end).toHaveBeenCalledWith(status===307||status===308?'x':undefined);
  });
  it('limits response body and preserves failure status', async () => {
    respond(500,undefined,'x'.repeat(5000)); const result=await sendPublicWebhook('http://example.com',{},'x');
    expect(result.status).toBe(500); expect(result.text).toHaveLength(2000);
  });
  it('stops redirect loops', async () => {
    for(let i=0;i<21;i++) respond(307,'/loop');
    await expect(sendPublicWebhook('https://example.com',{},'x')).rejects.toThrow('Too many');
    expect(mocks.request).toHaveBeenCalledTimes(21);
  });
});
it('aborts unresolved DNS without opening a socket', async () => {
  const controller = new AbortController();
  const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
  mocks.lookup.mockImplementation(() => new Promise(() => {}));
  const pending = sendPublicWebhook('https://example.com', {}, 'x');
  controller.abort();
  await expect(pending).rejects.toThrow('timed out');
  expect(mocks.request).not.toHaveBeenCalled();
  timeout.mockRestore();
});
