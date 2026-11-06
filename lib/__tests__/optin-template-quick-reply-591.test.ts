/**
 * #591 part B1 — template quick-reply payloads reach the actual provider request body
 * through the real MetaCloudSender and MetaCloudService.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestSupabase } from './helpers/mock-supabase';

vi.mock('@/lib/channels/circuit-breaker', () => ({
  isCircuitOpen: () => false,
  recordSuccess: vi.fn(),
  recordFailure: vi.fn(),
  CircuitBreakerOpenError: class extends Error {},
}));
vi.mock('@/lib/channels/send-guard', async importOriginal => ({
  ...await importOriginal<typeof import('@/lib/channels/send-guard')>(),
  assertMessagingAllowed: vi.fn().mockResolvedValue(undefined),
}));

import { MetaCloudSender } from '@/lib/channels/message-sender';
import { MetaCloudService } from '@/lib/channels/meta-cloud';

afterEach(() => vi.unstubAllGlobals());

async function sendAndCapture(extra: Record<string, unknown>) {
  const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
    messages: [{ id: 'wamid.optin-test' }],
  }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  vi.stubGlobal('fetch', fetchMock);
  const cloud = new MetaCloudService({ accessToken: 'test-only', phoneNumberId: 'test-phone', wabaId: 'test-waba' });
  const sender = new MetaCloudSender(cloud, createTestSupabase());
  sender.bindBusiness('test-business');
  const result = await sender.sendTemplate({
    to: '15550001111', templateName: 'waaiio_updates_optin_v1', languageCode: 'en',
    templateParams: ['Test Shop'], messageCategory: 'marketing', noRetry: true, ...extra,
  });
  expect(result).toEqual({ success: true, messageId: 'wamid.optin-test' });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  return JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
}

describe('sendTemplate quick-reply payloads', () => {
  it('sends each payload as a quick_reply button component with its index', async () => {
    const yes = `optin_yes:${'a'.repeat(43)}`;
    const no = `optin_no:${'a'.repeat(43)}`;
    const body = await sendAndCapture({ quickReplyPayloads: [yes, no] });
    expect(body).toEqual({
      messaging_product: 'whatsapp', to: '15550001111', type: 'template',
      template: {
        name: 'waaiio_updates_optin_v1', language: { code: 'en' },
        components: [
          { type: 'body', parameters: [{ type: 'text', text: 'Test Shop' }] },
          { type: 'button', sub_type: 'quick_reply', index: 0, parameters: [{ type: 'payload', payload: yes }] },
          { type: 'button', sub_type: 'quick_reply', index: 1, parameters: [{ type: 'payload', payload: no }] },
        ],
      },
    });
  });

  it('leaves the body unchanged when no payloads are given', async () => {
    const body = await sendAndCapture({});
    expect(body.template.components).toEqual([{ type: 'body', parameters: [{ type: 'text', text: 'Test Shop' }] }]);
  });
});
