/**
 * Lane 1 — Route-level outbound delivery fallback regression tests.
 *
 * These invoke the real route handlers with isolated mock dependencies so
 * accepted email fallbacks and resolved email rejections are reflected in
 * the API results without simulating provider/network behavior.
 */
import { NextRequest } from 'next/server';
import { describe, expect, it, vi } from 'vitest';

function makePost(path: string, body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost' + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function makeContractService() {
  const signerUpdates = vi.fn();
  const contractUpdates = vi.fn();
  const business = {
    id: 'business-1',
    name: 'Test Business',
    owner_id: 'owner-1',
    country_code: 'NG',
  };

  const service = {
    from: vi.fn((table: string) => {
      if (table === 'businesses') {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              single: vi.fn(async () => ({ data: business, error: null })),
            })),
          })),
        };
      }

      if (table === 'contracts') {
        return {
          insert: vi.fn(() => ({
            select: vi.fn(() => ({
              single: vi.fn(async () => ({ data: { id: 'contract-1' }, error: null })),
            })),
          })),
          update: contractUpdates,
        };
      }

      if (table === 'contract_signers') {
        return {
          insert: vi.fn((rows: Array<Record<string, unknown>>) => ({
            select: vi.fn(async () => ({
              data: rows.map((row, index) => ({ ...row, id: 'signer-' + (index + 1) })),
              error: null,
            })),
          })),
          update: signerUpdates,
        };
      }

      throw new Error('Unexpected table: ' + table);
    }),
  };

  return { service, signerUpdates, contractUpdates };
}

async function loadContractRoute() {
  vi.resetModules();

  const sendOrEmail = vi.fn().mockResolvedValue({ whatsapp: 'failed', email: 'sent' });
  const findCustomerEmail = vi.fn().mockResolvedValue('customer@example.com');
  const sender = {
    sendTemplate: vi.fn().mockResolvedValue({ success: false }),
  };
  const { service, signerUpdates, contractUpdates } = makeContractService();

  vi.doMock('@/lib/supabase/server', () => ({
    createClient: vi.fn(async () => ({
      auth: { getUser: vi.fn(async () => ({ data: { user: { id: 'owner-1' } } })) },
    })),
  }));
  vi.doMock('@/lib/supabase/service', () => ({
    createServiceClient: vi.fn(() => service),
  }));
  vi.doMock('@/lib/capabilities/api-guard', () => ({
    requireCapability: vi.fn(async () => ({ allowed: true })),
  }));
  vi.doMock('@/lib/channels/channel-resolver', () => ({
    ChannelResolver: vi.fn().mockImplementation(() => ({
      resolveByBusinessId: vi.fn(async () => ({ sender })),
      getSharedChannelForCountry: vi.fn(async () => null),
    })),
  }));
  vi.doMock('@/lib/channels/send-or-email', () => ({ sendOrEmail, findCustomerEmail }));
  vi.doMock('@/lib/bot/conversation-guard', () => ({
    checkConversationLimit: vi.fn(async () => ({ allowed: true, used: 0, limit: 100 })),
  }));
  vi.doMock('@/lib/platformSettings', () => ({
    loadPlatformSettings: vi.fn(async () => ({ contract_signing_hours: 72 })),
  }));
  vi.doMock('@/lib/email/templates', () => ({
    businessNotificationEmail: vi.fn(() => ({ subject: 'Sign this document', html: '<p>Sign</p>' })),
  }));
  vi.doMock('@/lib/logger', () => ({
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  }));

  const { POST } = await import('@/app/api/contracts/send/route');
  return { POST, sendOrEmail, sender, signerUpdates, contractUpdates };
}

describe('contracts/send route email fallback delivery status', () => {
  it('reports an accepted email fallback as delivered for a single signer', async () => {
    const { POST, sendOrEmail, signerUpdates, contractUpdates } = await loadContractRoute();

    const response = await POST(makePost('/api/contracts/send', {
      business_id: 'business-1',
      title: 'Agreement',
      signer_phone: '+2348000000001',
      signer_name: 'Ava',
      signer_email: 'customer@example.com',
    }));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ message_delivered: true });
    expect(sendOrEmail).toHaveBeenCalledOnce();
    expect(signerUpdates).not.toHaveBeenCalled();
    expect(contractUpdates).not.toHaveBeenCalled();
  });

  it('counts accepted email fallbacks for multi-signer contracts without a WhatsApp ID', async () => {
    const { POST, sendOrEmail, signerUpdates } = await loadContractRoute();

    const response = await POST(makePost('/api/contracts/send', {
      business_id: 'business-1',
      title: 'Agreement',
      signers: [
        { name: 'Ava', phone: '+2348000000001', email: 'ava@example.com' },
        { name: 'Ben', phone: '+2348000000002', email: 'ben@example.com' },
      ],
    }));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ messages_delivered: 2 });
    expect(sendOrEmail).toHaveBeenCalledTimes(2);
    expect(signerUpdates).not.toHaveBeenCalled();
  });
});

function makeWaiverService() {
  const signedRows: Array<Record<string, unknown>> = [];
  const template = {
    id: 'template-1',
    business_id: 'business-1',
    title: 'Waiver',
    is_active: true,
  };
  const business = {
    name: 'Test Business',
    country_code: 'NG',
    phone: null,
  };
  const service = {
    from: vi.fn((table: string) => {
      if (table === 'waiver_templates') {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              single: vi.fn(async () => ({ data: template, error: null })),
            })),
          })),
        };
      }

      if (table === 'signed_waivers') {
        return {
          insert: vi.fn((row: Record<string, unknown>) => {
            signedRows.push(row);
            return {
              select: vi.fn(() => ({
                single: vi.fn(async () => ({
                  data: { id: 'signed-abcdef123456', access_token: 'access-token' },
                  error: null,
                })),
              })),
            };
          }),
        };
      }

      if (table === 'businesses') {
        return {
          select: vi.fn((fields: string) => ({
            eq: vi.fn(() => ({
              single: vi.fn(async () => ({
                data: fields === 'owner_id' ? { owner_id: 'owner-1' } : business,
                error: null,
              })),
            })),
          })),
        };
      }

      if (table === 'profiles') {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              single: vi.fn(async () => ({ data: { email: 'owner@example.com' }, error: null })),
            })),
          })),
        };
      }

      throw new Error('Unexpected table: ' + table);
    }),
    storage: {
      from: vi.fn(() => ({
        upload: vi.fn(async () => ({ error: null })),
      })),
    },
  };

  return { service, signedRows };
}

async function loadWaiverRoute() {
  vi.resetModules();
  const sendEmail = vi.fn(async () => ({ success: false, error: 'provider rejected' }));
  const { service, signedRows } = makeWaiverService();

  vi.doMock('@/lib/supabase/service', () => ({
    createServiceClient: vi.fn(() => service),
  }));
  vi.doMock('@/lib/rate-limit', () => ({
    rateLimitResponseAsync: vi.fn(async () => null),
    getRateLimitKey: vi.fn(() => 'test-key'),
  }));
  vi.doMock('@/lib/channels/channel-resolver', () => ({
    ChannelResolver: vi.fn(),
  }));
  vi.doMock('@/lib/email/client', () => ({ sendEmail }));
  vi.doMock('@/lib/email/templates', () => ({
    businessFrom: vi.fn(() => 'Waaiio <no-reply@example.com>'),
  }));
  vi.doMock('@/lib/logger', () => ({
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  }));

  const { POST } = await import('@/app/api/waivers/sign/route');
  return { POST, sendEmail, signedRows };
}

describe('waivers/sign route resolved email status', () => {
  it('exposes customer and merchant email rejection while preserving signed state', async () => {
    const { POST, sendEmail, signedRows } = await loadWaiverRoute();

    const response = await POST(makePost('/api/waivers/sign', {
      token: 'valid-token',
      first_name: 'Ava',
      last_name: 'Customer',
      customer_email: 'customer@example.com',
      signature: 'data:image/png;base64,aGVsbG8=',
    }));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      success: true,
      notification_status: {
        customer_whatsapp: 'skipped',
        customer_email: 'failed',
        merchant_whatsapp: 'skipped',
        merchant_email: 'failed',
      },
    });
    expect(signedRows).toHaveLength(1);
    expect(sendEmail).toHaveBeenCalledTimes(2);
  });
});
