import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestSupabase } from './helpers/mock-supabase';

vi.mock('@/lib/channels/circuit-breaker', () => ({
  isCircuitOpen: () => false,
  recordSuccess: vi.fn(),
  recordFailure: vi.fn(),
  CircuitBreakerOpenError: class extends Error {},
}));
vi.mock('@/lib/channels/send-guard', () => ({
  assertMessagingAllowed: vi.fn().mockResolvedValue(undefined),
}));

import { MetaCloudSender } from '@/lib/channels/message-sender';
import { MetaCloudService } from '@/lib/channels/meta-cloud';

afterEach(() => vi.unstubAllGlobals());

describe('template locale through real sender and cloud adapter', () => {
  it.each([
    ['explicit merchant locale', 'en', 'en'],
    ['existing omitted locale', undefined, 'en_US'],
  ])('%s reaches the actual provider request body', async (_label, languageCode, expected) => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      messages: [{id: 'wamid.locale-test'}],
    }), {status: 200, headers: {'Content-Type': 'application/json'}}));
    vi.stubGlobal('fetch', fetchMock);
    const cloud = new MetaCloudService({accessToken: 'test-only', phoneNumberId: 'test-phone', wabaId: 'test-waba'});
    const sender = new MetaCloudSender(cloud, createTestSupabase());
    sender.bindBusiness('test-business');
    const result = await sender.sendTemplate({
      to: '2348012345678', templateName: 'name_waaiio_merchant_alert_v1',
      ...(languageCode === undefined ? {} : {languageCode}),
      templateParams: ['Shop', 'Order received', 'ORDER-1', 'Review payment status'],
      messageCategory: 'utility', noRetry: true,
    });
    expect(result).toEqual({success: true, messageId: 'wamid.locale-test'});
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, request] = fetchMock.mock.calls[0];
    expect(url).toContain('/test-phone/messages');
    expect(request?.method).toBe('POST');
    expect(JSON.parse(String(request?.body))).toEqual({
      messaging_product: 'whatsapp', to: '2348012345678', type: 'template',
      template: {
        name: 'name_waaiio_merchant_alert_v1', language: {code: expected},
        components: [{type: 'body', parameters: ['Shop', 'Order received', 'ORDER-1', 'Review payment status']
          .map(text => ({type: 'text', text}))}],
      },
    });
  });
});
