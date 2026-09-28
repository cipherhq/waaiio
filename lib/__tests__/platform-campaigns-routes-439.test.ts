/**
 * Platform Campaigns Slice 1 — Executable route handler tests (#439)
 *
 * Invokes the real POST/PUT handlers for Campaign and Asset routes
 * with mocked Supabase to prove authorization, validation, and authority paths.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ═══════════════════════════════════════════════════
// Shared mocks
// ═══════════════════════════════════════════════════

const { mockAdminAuth, mockFrom, mockServiceClient } = vi.hoisted(() => {
  const mockFrom = vi.fn();
  const mockServiceClient = { from: mockFrom };
  const mockAdminAuth = vi.fn();
  return { mockAdminAuth, mockFrom, mockServiceClient };
});

vi.mock('@/lib/admin-auth', () => ({
  requirePlatformAdmin: mockAdminAuth,
}));

vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => mockServiceClient,
}));

vi.mock('@/lib/admin-cors', () => ({
  adminCorsHeaders: () => ({}),
}));

function makeReq(url: string, method: string, body?: Record<string, unknown>): NextRequest {
  const opts: RequestInit = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  return new NextRequest(url, opts);
}

const ADMIN = { userId: 'admin-439', email: 'admin@test.com', role: 'admin' };

// Helper: make a chain of .from().select().eq()... that resolves to given data
function mockTable(table: string, handlers: Record<string, unknown>) {
  mockFrom.mockImplementation((t: string) => {
    if (t === table) return handlers;
    // Default: return a no-op chain for unrelated tables
    return {
      select: vi.fn(() => ({ eq: vi.fn(() => ({ single: vi.fn(async () => ({ data: null, error: null })), eq: vi.fn(() => ({ single: vi.fn(async () => ({ data: null, error: null })) })) })) })),
      insert: vi.fn(async () => ({ data: null, error: null })),
      update: vi.fn(() => ({ eq: vi.fn(() => ({ eq: vi.fn(() => ({ select: vi.fn(() => ({ single: vi.fn(async () => ({ data: null, error: null })) })) })) })) })),
    };
  });
}

// ═══════════════════════════════════════════════════
// Campaign POST
// ═══════════════════════════════════════════════════

describe('POST /api/admin/platform-campaigns — executable (#439)', () => {
  let POST: (req: NextRequest) => Promise<Response>;

  beforeEach(async () => {
    vi.resetModules();
    mockFrom.mockReset();
    mockAdminAuth.mockReset().mockResolvedValue(ADMIN);
    // Lazy-import to get fresh module with mocks applied
    const mod = await import('@/app/api/admin/platform-campaigns/route');
    POST = mod.POST;
  });

  it('non-admin rejected with 403', async () => {
    mockAdminAuth.mockResolvedValueOnce(null);
    const res = await POST(makeReq('http://localhost/api/admin/platform-campaigns', 'POST', {
      name: 'Test', campaign_type: 'opt_in', consent_type: 'opt_in',
    }));
    expect(res.status).toBe(403);
  });

  it('missing consent_type rejected with 400', async () => {
    const res = await POST(makeReq('http://localhost/api/admin/platform-campaigns', 'POST', {
      name: 'Test', campaign_type: 'opt_in',
    }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain('consent_type');
  });

  it('malformed starts_at rejected with 400', async () => {
    const res = await POST(makeReq('http://localhost/api/admin/platform-campaigns', 'POST', {
      name: 'Test', campaign_type: 'opt_in', consent_type: 'opt_in',
      starts_at: 'not-a-date',
    }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain('starts_at');
  });

  it('malformed ends_at rejected with 400', async () => {
    const res = await POST(makeReq('http://localhost/api/admin/platform-campaigns', 'POST', {
      name: 'Test', campaign_type: 'opt_in', consent_type: 'opt_in',
      ends_at: 'invalid-date-string',
    }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain('ends_at');
  });

  it('starts_at >= ends_at rejected with 400', async () => {
    const res = await POST(makeReq('http://localhost/api/admin/platform-campaigns', 'POST', {
      name: 'Test', campaign_type: 'opt_in', consent_type: 'opt_in',
      starts_at: '2026-12-01T00:00:00Z', ends_at: '2026-11-01T00:00:00Z',
    }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain('starts_at must be before ends_at');
  });

  it('invalid market_scope (non-array) rejected with 400', async () => {
    const res = await POST(makeReq('http://localhost/api/admin/platform-campaigns', 'POST', {
      name: 'Test', campaign_type: 'opt_in', consent_type: 'opt_in',
      market_scope: 'US',
    }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain('market_scope');
  });

  it('market_scope with non-string element rejected with 400', async () => {
    const res = await POST(makeReq('http://localhost/api/admin/platform-campaigns', 'POST', {
      name: 'Test', campaign_type: 'opt_in', consent_type: 'opt_in',
      market_scope: ['US', 42],
    }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain('market_scope');
  });

  it('valid create succeeds with required consent', async () => {
    const created = { id: 'camp-1', name: 'Launch US', campaign_type: 'opt_in', consent_type: 'opt_in', status: 'draft' };
    mockFrom.mockImplementation((table: string) => {
      if (table === 'platform_campaigns') {
        return {
          insert: vi.fn(() => ({
            select: vi.fn(() => ({
              single: vi.fn(async () => ({ data: created, error: null })),
            })),
          })),
        };
      }
      // admin_audit_logs
      return { insert: vi.fn(() => ({ then: vi.fn((resolve: () => void) => resolve()) })) };
    });

    const res = await POST(makeReq('http://localhost/api/admin/platform-campaigns', 'POST', {
      name: 'Launch US', campaign_type: 'opt_in', consent_type: 'opt_in',
      market_scope: ['us', 'ng'], // should normalize to ['US', 'NG']
    }));
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.data.consent_type).toBe('opt_in');
  });
});

// ═══════════════════════════════════════════════════
// Campaign PUT
// ═══════════════════════════════════════════════════

describe('PUT /api/admin/platform-campaigns/[id] — executable (#439)', () => {
  let PUT: (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;

  beforeEach(async () => {
    vi.resetModules();
    mockFrom.mockReset();
    mockAdminAuth.mockReset().mockResolvedValue(ADMIN);
    const mod = await import('@/app/api/admin/platform-campaigns/[id]/route');
    PUT = mod.PUT;
  });

  const params = (id: string) => ({ params: Promise.resolve({ id }) });

  it('invalid status rejected with 400', async () => {
    const res = await PUT(
      makeReq('http://localhost/api/admin/platform-campaigns/c1', 'PUT', { status: 'invalid_status' }),
      params('c1'),
    );
    expect(res.status).toBe(400);
  });

  it('invalid consent_type rejected with 400', async () => {
    const res = await PUT(
      makeReq('http://localhost/api/admin/platform-campaigns/c1', 'PUT', { consent_type: 'marketing' }),
      params('c1'),
    );
    expect(res.status).toBe(400);
  });

  it('malformed starts_at rejected with 400', async () => {
    const res = await PUT(
      makeReq('http://localhost/api/admin/platform-campaigns/c1', 'PUT', { starts_at: 'garbage' }),
      params('c1'),
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain('starts_at');
  });

  it('PUT changing only ends_at validates against existing starts_at', async () => {
    // Existing campaign has starts_at in the future
    mockFrom.mockImplementation((table: string) => {
      if (table === 'platform_campaigns') {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              single: vi.fn(async () => ({
                data: { starts_at: '2026-12-01T00:00:00Z', ends_at: null },
                error: null,
              })),
            })),
          })),
        };
      }
      return { insert: vi.fn(async () => ({ data: null, error: null })) };
    });

    // Setting ends_at to before the existing starts_at should fail
    const res = await PUT(
      makeReq('http://localhost/api/admin/platform-campaigns/c1', 'PUT', { ends_at: '2026-11-01T00:00:00Z' }),
      params('c1'),
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain('starts_at must be before ends_at');
  });

  it('market-scope narrowing with active out-of-scope asset rejected', async () => {
    mockFrom.mockImplementation((table: string) => {
      if (table === 'platform_campaigns') {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              single: vi.fn(async () => ({ data: { starts_at: null, ends_at: null }, error: null })),
            })),
          })),
        };
      }
      if (table === 'platform_campaign_assets') {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              eq: vi.fn(async () => ({
                data: [{ market: 'NG' }], // active asset in NG
                error: null,
              })),
            })),
          })),
        };
      }
      return { insert: vi.fn(async () => ({ data: null, error: null })) };
    });

    const res = await PUT(
      makeReq('http://localhost/api/admin/platform-campaigns/c1', 'PUT', { market_scope: ['US'] }), // narrowing to US only
      params('c1'),
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain('Cannot narrow market_scope');
  });
});

// ═══════════════════════════════════════════════════
// Asset POST
// ═══════════════════════════════════════════════════

describe('POST /api/admin/platform-campaigns/[id]/assets — executable (#439)', () => {
  let POST: (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;

  beforeEach(async () => {
    vi.resetModules();
    mockFrom.mockReset();
    mockAdminAuth.mockReset().mockResolvedValue(ADMIN);
    const mod = await import('@/app/api/admin/platform-campaigns/[id]/assets/route');
    POST = mod.POST;
  });

  const params = (id: string) => ({ params: Promise.resolve({ id }) });

  it('non-admin rejected with 403', async () => {
    mockAdminAuth.mockResolvedValueOnce(null);
    const res = await POST(
      makeReq('http://localhost/api/admin/platform-campaigns/c1/assets', 'POST', {
        source_type: 'website_button', channel_id: 'ch-1', prefilled_message: 'Hello',
      }),
      params('c1'),
    );
    expect(res.status).toBe(403);
  });

  it('dedicated channel rejected with 400', async () => {
    mockFrom.mockImplementation((table: string) => {
      if (table === 'platform_campaigns') {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              single: vi.fn(async () => ({
                data: { id: 'c1', market_scope: [] },
                error: null,
              })),
            })),
          })),
        };
      }
      if (table === 'whatsapp_channels') {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              single: vi.fn(async () => ({
                data: { id: 'ch-1', phone_number: '+1234', country_code: 'US', channel_type: 'dedicated', is_active: true },
                error: null,
              })),
            })),
          })),
        };
      }
      return { select: vi.fn(() => ({ eq: vi.fn(() => ({ single: vi.fn(async () => ({ data: null, error: null })) })) })) };
    });

    const res = await POST(
      makeReq('http://localhost/api/admin/platform-campaigns/c1/assets', 'POST', {
        source_type: 'website_button', channel_id: 'ch-1', prefilled_message: 'Hello',
      }),
      params('c1'),
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain('shared');
  });

  it('inactive shared channel rejected with 400', async () => {
    mockFrom.mockImplementation((table: string) => {
      if (table === 'platform_campaigns') {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              single: vi.fn(async () => ({
                data: { id: 'c1', market_scope: [] },
                error: null,
              })),
            })),
          })),
        };
      }
      if (table === 'whatsapp_channels') {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              single: vi.fn(async () => ({
                data: { id: 'ch-1', phone_number: '+1234', country_code: 'US', channel_type: 'shared', is_active: false },
                error: null,
              })),
            })),
          })),
        };
      }
      return { select: vi.fn(() => ({ eq: vi.fn(() => ({ single: vi.fn(async () => ({ data: null, error: null })) })) })) };
    });

    const res = await POST(
      makeReq('http://localhost/api/admin/platform-campaigns/c1/assets', 'POST', {
        source_type: 'website_button', channel_id: 'ch-1', prefilled_message: 'Hello',
      }),
      params('c1'),
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain('not active');
  });

  it('out-of-scope market rejected with 400', async () => {
    mockFrom.mockImplementation((table: string) => {
      if (table === 'platform_campaigns') {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              single: vi.fn(async () => ({
                data: { id: 'c1', market_scope: ['US'] },
                error: null,
              })),
            })),
          })),
        };
      }
      if (table === 'whatsapp_channels') {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              single: vi.fn(async () => ({
                data: { id: 'ch-1', phone_number: '+234', country_code: 'NG', channel_type: 'shared', is_active: true },
                error: null,
              })),
            })),
          })),
        };
      }
      return { select: vi.fn(() => ({ eq: vi.fn(() => ({ single: vi.fn(async () => ({ data: null, error: null })) })) })) };
    });

    const res = await POST(
      makeReq('http://localhost/api/admin/platform-campaigns/c1/assets', 'POST', {
        source_type: 'website_button', channel_id: 'ch-1', prefilled_message: 'Hello',
      }),
      params('c1'),
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain('outside campaign scope');
  });

  it('valid shared channel creates asset with server-derived market', async () => {
    mockFrom.mockImplementation((table: string) => {
      if (table === 'platform_campaigns') {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              single: vi.fn(async () => ({
                data: { id: 'c1', market_scope: [] },
                error: null,
              })),
            })),
          })),
        };
      }
      if (table === 'whatsapp_channels') {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              single: vi.fn(async () => ({
                data: { id: 'ch-1', phone_number: '+12025551234', country_code: 'US', channel_type: 'shared', is_active: true },
                error: null,
              })),
            })),
          })),
        };
      }
      if (table === 'platform_campaign_assets') {
        return {
          insert: vi.fn(() => ({
            select: vi.fn(() => ({
              single: vi.fn(async () => ({
                data: { id: 'asset-1', campaign_id: 'c1', market: 'US', attribution_token: 'ABCDEF', is_active: true },
                error: null,
              })),
            })),
          })),
        };
      }
      // admin_audit_logs
      return { insert: vi.fn(() => ({ then: vi.fn((resolve: () => void) => resolve()) })) };
    });

    const res = await POST(
      makeReq('http://localhost/api/admin/platform-campaigns/c1/assets', 'POST', {
        source_type: 'website_button', channel_id: 'ch-1', prefilled_message: 'Join the waitlist',
      }),
      params('c1'),
    );
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.tracked_link).toContain('/go/');
    // Must NOT contain wa.me
    expect(JSON.stringify(json)).not.toContain('wa.me');
  });

  it('token collision retries and eventually succeeds', async () => {
    let insertAttempts = 0;
    mockFrom.mockImplementation((table: string) => {
      if (table === 'platform_campaigns') {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              single: vi.fn(async () => ({
                data: { id: 'c1', market_scope: [] },
                error: null,
              })),
            })),
          })),
        };
      }
      if (table === 'whatsapp_channels') {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              single: vi.fn(async () => ({
                data: { id: 'ch-1', phone_number: '+12025551234', country_code: 'US', channel_type: 'shared', is_active: true },
                error: null,
              })),
            })),
          })),
        };
      }
      if (table === 'platform_campaign_assets') {
        return {
          insert: vi.fn(() => ({
            select: vi.fn(() => ({
              single: vi.fn(async () => {
                insertAttempts++;
                if (insertAttempts <= 2) {
                  // Unique violation on first 2 attempts
                  return { data: null, error: { code: '23505', message: 'duplicate key' } };
                }
                return {
                  data: { id: 'asset-1', campaign_id: 'c1', market: 'US', attribution_token: 'RETRY3', is_active: true },
                  error: null,
                };
              }),
            })),
          })),
        };
      }
      return { insert: vi.fn(() => ({ then: vi.fn((resolve: () => void) => resolve()) })) };
    });

    const res = await POST(
      makeReq('http://localhost/api/admin/platform-campaigns/c1/assets', 'POST', {
        source_type: 'website_button', channel_id: 'ch-1', prefilled_message: 'Retry test',
      }),
      params('c1'),
    );
    expect(res.status).toBe(201);
    expect(insertAttempts).toBe(3);
  });

  it('response exposes tracked link but no direct wa.me URL', async () => {
    mockFrom.mockImplementation((table: string) => {
      if (table === 'platform_campaigns') {
        return { select: vi.fn(() => ({ eq: vi.fn(() => ({ single: vi.fn(async () => ({ data: { id: 'c1', market_scope: [] }, error: null })) })) })) };
      }
      if (table === 'whatsapp_channels') {
        return { select: vi.fn(() => ({ eq: vi.fn(() => ({ single: vi.fn(async () => ({ data: { id: 'ch-1', phone_number: '+12025551234', country_code: 'US', channel_type: 'shared', is_active: true }, error: null })) })) })) };
      }
      if (table === 'platform_campaign_assets') {
        return { insert: vi.fn(() => ({ select: vi.fn(() => ({ single: vi.fn(async () => ({ data: { id: 'a1', campaign_id: 'c1', market: 'US', attribution_token: 'XYZ789', is_active: true }, error: null })) })) })) };
      }
      return { insert: vi.fn(() => ({ then: vi.fn((resolve: () => void) => resolve()) })) };
    });

    const res = await POST(
      makeReq('http://localhost/api/admin/platform-campaigns/c1/assets', 'POST', {
        source_type: 'direct_link', channel_id: 'ch-1', prefilled_message: 'Check this',
      }),
      params('c1'),
    );
    expect(res.status).toBe(201);
    const json = await res.json();
    // tracked_link must be /go/<token> format
    expect(json.tracked_link).toMatch(/^\/go\/[A-Z0-9]{6}$/);
    // The response body must not contain wa.me anywhere
    const body = JSON.stringify(json);
    expect(body).not.toContain('wa.me');
  });
});

// ═══════════════════════════════════════════════════
// Asset PUT
// ═══════════════════════════════════════════════════

describe('PUT /api/admin/platform-campaigns/[id]/assets/[assetId] — executable (#439)', () => {
  let PUT: (req: NextRequest, ctx: { params: Promise<{ id: string; assetId: string }> }) => Promise<Response>;

  beforeEach(async () => {
    vi.resetModules();
    mockFrom.mockReset();
    mockAdminAuth.mockReset().mockResolvedValue(ADMIN);
    const mod = await import('@/app/api/admin/platform-campaigns/[id]/assets/[assetId]/route');
    PUT = mod.PUT;
  });

  const params = (id: string, assetId: string) => ({ params: Promise.resolve({ id, assetId }) });

  it('asset must belong to campaign (wrong campaign → 404)', async () => {
    mockFrom.mockImplementation((table: string) => {
      if (table === 'platform_campaign_assets') {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              eq: vi.fn(() => ({
                single: vi.fn(async () => ({ data: null, error: null })), // not found
              })),
            })),
          })),
        };
      }
      return { select: vi.fn(() => ({ eq: vi.fn(() => ({ single: vi.fn(async () => ({ data: null, error: null })) })) })) };
    });

    const res = await PUT(
      makeReq('http://localhost/api/admin/platform-campaigns/c1/assets/a1', 'PUT', { is_active: false }),
      params('c1', 'a1'),
    );
    expect(res.status).toBe(404);
  });

  it('deactivation succeeds', async () => {
    mockFrom.mockImplementation((table: string) => {
      if (table === 'platform_campaign_assets') {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              eq: vi.fn(() => ({
                single: vi.fn(async () => ({
                  data: { id: 'a1', campaign_id: 'c1', channel_id: 'ch-1', market: 'US' },
                  error: null,
                })),
              })),
            })),
          })),
          update: vi.fn(() => ({
            eq: vi.fn(() => ({
              eq: vi.fn(() => ({
                select: vi.fn(() => ({
                  single: vi.fn(async () => ({
                    data: { id: 'a1', is_active: false },
                    error: null,
                  })),
                })),
              })),
            })),
          })),
        };
      }
      return { insert: vi.fn(() => ({ then: vi.fn((resolve: () => void) => resolve()) })) };
    });

    const res = await PUT(
      makeReq('http://localhost/api/admin/platform-campaigns/c1/assets/a1', 'PUT', { is_active: false }),
      params('c1', 'a1'),
    );
    expect(res.status).toBe(200);
  });

  it('dedicated replacement channel rejected', async () => {
    mockFrom.mockImplementation((table: string) => {
      if (table === 'platform_campaign_assets') {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              eq: vi.fn(() => ({
                single: vi.fn(async () => ({
                  data: { id: 'a1', campaign_id: 'c1', channel_id: 'ch-old', market: 'US' },
                  error: null,
                })),
              })),
            })),
          })),
        };
      }
      if (table === 'whatsapp_channels') {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              single: vi.fn(async () => ({
                data: { id: 'ch-new', phone_number: '+1555', country_code: 'US', channel_type: 'dedicated', is_active: true },
                error: null,
              })),
            })),
          })),
        };
      }
      return { select: vi.fn(() => ({ eq: vi.fn(() => ({ single: vi.fn(async () => ({ data: null, error: null })) })) })) };
    });

    const res = await PUT(
      makeReq('http://localhost/api/admin/platform-campaigns/c1/assets/a1', 'PUT', { channel_id: 'ch-new' }),
      params('c1', 'a1'),
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain('shared');
  });

  it('inactive replacement channel rejected', async () => {
    mockFrom.mockImplementation((table: string) => {
      if (table === 'platform_campaign_assets') {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              eq: vi.fn(() => ({
                single: vi.fn(async () => ({
                  data: { id: 'a1', campaign_id: 'c1', channel_id: 'ch-old', market: 'US' },
                  error: null,
                })),
              })),
            })),
          })),
        };
      }
      if (table === 'whatsapp_channels') {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              single: vi.fn(async () => ({
                data: { id: 'ch-new', phone_number: '+1555', country_code: 'US', channel_type: 'shared', is_active: false },
                error: null,
              })),
            })),
          })),
        };
      }
      return { select: vi.fn(() => ({ eq: vi.fn(() => ({ single: vi.fn(async () => ({ data: null, error: null })) })) })) };
    });

    const res = await PUT(
      makeReq('http://localhost/api/admin/platform-campaigns/c1/assets/a1', 'PUT', { channel_id: 'ch-new' }),
      params('c1', 'a1'),
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain('not active');
  });

  it('non-string/non-null source_label rejected with 400', async () => {
    mockFrom.mockImplementation((table: string) => {
      if (table === 'platform_campaign_assets') {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              eq: vi.fn(() => ({
                single: vi.fn(async () => ({
                  data: { id: 'a1', campaign_id: 'c1', channel_id: 'ch-1', market: 'US' },
                  error: null,
                })),
              })),
            })),
          })),
        };
      }
      return { select: vi.fn(() => ({ eq: vi.fn(() => ({ single: vi.fn(async () => ({ data: null, error: null })) })) })) };
    });

    const res = await PUT(
      makeReq('http://localhost/api/admin/platform-campaigns/c1/assets/a1', 'PUT', { source_label: 42 }),
      params('c1', 'a1'),
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain('source_label');
  });

  it('valid channel change derives market and succeeds', async () => {
    mockFrom.mockImplementation((table: string) => {
      if (table === 'platform_campaign_assets') {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              eq: vi.fn(() => ({
                single: vi.fn(async () => ({
                  data: { id: 'a1', campaign_id: 'c1', channel_id: 'ch-old', market: 'US' },
                  error: null,
                })),
              })),
            })),
          })),
          update: vi.fn(() => ({
            eq: vi.fn(() => ({
              eq: vi.fn(() => ({
                select: vi.fn(() => ({
                  single: vi.fn(async () => ({
                    data: { id: 'a1', channel_id: 'ch-new', market: 'NG' },
                    error: null,
                  })),
                })),
              })),
            })),
          })),
        };
      }
      if (table === 'whatsapp_channels') {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              single: vi.fn(async () => ({
                data: { id: 'ch-new', phone_number: '+234', country_code: 'NG', channel_type: 'shared', is_active: true },
                error: null,
              })),
            })),
          })),
        };
      }
      if (table === 'platform_campaigns') {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              single: vi.fn(async () => ({
                data: { market_scope: [] }, // unrestricted
                error: null,
              })),
            })),
          })),
        };
      }
      return { insert: vi.fn(() => ({ then: vi.fn((resolve: () => void) => resolve()) })) };
    });

    const res = await PUT(
      makeReq('http://localhost/api/admin/platform-campaigns/c1/assets/a1', 'PUT', { channel_id: 'ch-new' }),
      params('c1', 'a1'),
    );
    expect(res.status).toBe(200);
  });
});
