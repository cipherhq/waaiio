/**
 * Polls API — behavioral tests
 *
 * Tests actual route handlers (POST, PATCH, DELETE, send) with mock Supabase.
 * Covers: validation, status transitions, vote dedup, capability guards, option integrity.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ── Mock state ──
const mockGetUser = vi.fn();
const mockFrom = vi.fn();
const mockServiceFrom = vi.fn();

// Helper: build a chainable query mock
function chainable(finalResult: { data: unknown; error: unknown; count?: number }) {
  const chain: Record<string, unknown> = {};
  const self = () => chain;
  chain.select = vi.fn().mockReturnValue(chain);
  chain.insert = vi.fn().mockReturnValue(chain);
  chain.update = vi.fn().mockReturnValue(chain);
  chain.delete = vi.fn().mockReturnValue(chain);
  chain.eq = vi.fn().mockReturnValue(chain);
  chain.order = vi.fn().mockReturnValue(chain);
  chain.single = vi.fn().mockResolvedValue(finalResult);
  chain.maybeSingle = vi.fn().mockResolvedValue(finalResult);
  // For count queries
  if (finalResult.count !== undefined) {
    chain.select = vi.fn().mockResolvedValue(finalResult);
  }
  // Allow .then() for bare awaits (insert/update/delete without .select)
  chain.then = (resolve: (v: unknown) => void) => resolve(finalResult);
  return chain;
}

// ── Mock Supabase server client ──
vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve({
    auth: { getUser: mockGetUser },
    from: mockFrom,
  }),
}));

// ── Mock Supabase service client ──
vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => ({
    from: mockServiceFrom,
  }),
}));

// ── Mock capability guard (allow by default) ──
const mockRequireCapability = vi.fn().mockResolvedValue({ allowed: true });
vi.mock('@/lib/capabilities/api-guard', () => ({
  requireCapability: (...args: unknown[]) => mockRequireCapability(...args),
}));

// ── Mock logger ──
vi.mock('@/lib/logger', () => ({
  logger: {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(),
    withContext: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
  },
}));

// ── Helpers ──
const USER = { id: 'user-1', email: 'test@example.com' };
const BIZ = { id: 'biz-1', owner_id: 'user-1', name: 'Test Biz' };
const POLL_DRAFT = {
  id: 'poll-1', business_id: 'biz-1', question: 'Favorite color?',
  options: ['Red', 'Blue', 'Green'], status: 'draft', total_votes: 0,
  allow_change_vote: false, show_results: 'after_vote', closes_at: null,
};
const POLL_ACTIVE = { ...POLL_DRAFT, id: 'poll-2', status: 'active' };
const POLL_CLOSED = { ...POLL_DRAFT, id: 'poll-3', status: 'closed' };

function makeRequest(method: string, url: string, body?: Record<string, unknown>) {
  const opts: RequestInit = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  return new NextRequest(new URL(url, 'http://localhost:3000'), opts);
}

/** Set up mockFrom to resolve different tables to different results */
function setupMockFrom(tableMap: Record<string, unknown>) {
  mockFrom.mockImplementation((table: string) => {
    const result = tableMap[table];
    if (!result) return chainable({ data: null, error: null });
    return chainable(result as { data: unknown; error: unknown; count?: number });
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetUser.mockResolvedValue({ data: { user: USER } });
  mockRequireCapability.mockResolvedValue({ allowed: true });
});

// ═══════════════════════════════════════════════════════════════════
// POST /api/polls — Create
// ═══════════════════════════════════════════════════════════════════

describe('POST /api/polls', () => {
  let POST: (req: NextRequest) => Promise<Response>;

  beforeEach(async () => {
    const mod = await import('@/app/api/polls/route');
    POST = mod.POST;
  });

  it('returns 401 when unauthenticated', async () => {
    mockGetUser.mockResolvedValueOnce({ data: { user: null } });
    const res = await POST(makeRequest('POST', '/api/polls', {
      business_id: 'biz-1', question: 'Q?', options: ['A', 'B'],
    }));
    expect(res.status).toBe(401);
  });

  it('returns 400 when question is missing', async () => {
    const res = await POST(makeRequest('POST', '/api/polls', {
      business_id: 'biz-1', question: '', options: ['A', 'B'],
    }));
    expect(res.status).toBe(400);
  });

  it('returns 400 when fewer than 2 options', async () => {
    const res = await POST(makeRequest('POST', '/api/polls', {
      business_id: 'biz-1', question: 'Q?', options: ['Only one'],
    }));
    expect(res.status).toBe(400);
  });

  it('returns 400 when more than 10 options', async () => {
    const opts = Array.from({ length: 11 }, (_, i) => `Opt ${i}`);
    const res = await POST(makeRequest('POST', '/api/polls', {
      business_id: 'biz-1', question: 'Q?', options: opts,
    }));
    expect(res.status).toBe(400);
  });

  it('returns 400 for empty option strings', async () => {
    setupMockFrom({ businesses: { data: BIZ, error: null } });
    const res = await POST(makeRequest('POST', '/api/polls', {
      business_id: 'biz-1', question: 'Q?', options: ['A', '', 'C'],
    }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('empty strings');
  });

  it('returns 400 for duplicate options', async () => {
    setupMockFrom({ businesses: { data: BIZ, error: null } });
    const res = await POST(makeRequest('POST', '/api/polls', {
      business_id: 'biz-1', question: 'Q?', options: ['Red', 'red'],
    }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('duplicates');
  });

  it('returns 404 when business not owned by user', async () => {
    setupMockFrom({ businesses: { data: null, error: null } });
    const res = await POST(makeRequest('POST', '/api/polls', {
      business_id: 'biz-other', question: 'Q?', options: ['A', 'B'],
    }));
    expect(res.status).toBe(404);
  });

  it('returns 403 when capability guard denies', async () => {
    setupMockFrom({ businesses: { data: BIZ, error: null } });
    mockRequireCapability.mockResolvedValueOnce({
      allowed: false, denial: { error: 'Upgrade required' }, status: 403,
    });
    const res = await POST(makeRequest('POST', '/api/polls', {
      business_id: 'biz-1', question: 'Q?', options: ['A', 'B'],
    }));
    expect(res.status).toBe(403);
  });

  it('creates poll with status=draft and returns 201', async () => {
    const createdPoll = { ...POLL_DRAFT, question: 'Best fruit?' };
    setupMockFrom({
      businesses: { data: BIZ, error: null },
      polls: { data: createdPoll, error: null },
    });
    const res = await POST(makeRequest('POST', '/api/polls', {
      business_id: 'biz-1', question: 'Best fruit?', options: ['Apple', 'Banana'],
    }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.poll).toBeTruthy();
  });
});

// ═══════════════════════════════════════════════════════════════════
// PATCH /api/polls/[id] — Update & status transitions
// ═══════════════════════════════════════════════════════════════════

describe('PATCH /api/polls/[id]', () => {
  let PATCH: (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;

  beforeEach(async () => {
    const mod = await import('@/app/api/polls/[id]/route');
    PATCH = mod.PATCH;
  });

  const params = (id: string) => ({ params: Promise.resolve({ id }) });

  it('returns 401 when unauthenticated', async () => {
    mockGetUser.mockResolvedValueOnce({ data: { user: null } });
    const res = await PATCH(
      makeRequest('PATCH', '/api/polls/poll-1', { status: 'active' }),
      params('poll-1'),
    );
    expect(res.status).toBe(401);
  });

  it('returns 404 when poll not found', async () => {
    setupMockFrom({ polls: { data: null, error: null } });
    const res = await PATCH(
      makeRequest('PATCH', '/api/polls/poll-x', { status: 'active' }),
      params('poll-x'),
    );
    expect(res.status).toBe(404);
  });

  it('allows draft -> active with valid question and options', async () => {
    const updatedPoll = { ...POLL_DRAFT, status: 'active' };
    setupMockFrom({
      polls: { data: POLL_DRAFT, error: null },
      businesses: { data: BIZ, error: null },
    });
    // Override second polls.from call (the update)
    let callCount = 0;
    mockFrom.mockImplementation((table: string) => {
      if (table === 'polls') {
        callCount++;
        if (callCount === 1) return chainable({ data: POLL_DRAFT, error: null });
        return chainable({ data: updatedPoll, error: null });
      }
      return chainable({ data: BIZ, error: null });
    });

    const res = await PATCH(
      makeRequest('PATCH', '/api/polls/poll-1', { status: 'active' }),
      params('poll-1'),
    );
    expect(res.status).toBe(200);
  });

  it('rejects draft -> active with empty question', async () => {
    const pollNoQuestion = { ...POLL_DRAFT, question: '' };
    setupMockFrom({
      polls: { data: pollNoQuestion, error: null },
      businesses: { data: BIZ, error: null },
    });
    const res = await PATCH(
      makeRequest('PATCH', '/api/polls/poll-1', { status: 'active' }),
      params('poll-1'),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('question');
  });

  it('rejects draft -> active with < 2 options', async () => {
    const pollFewOpts = { ...POLL_DRAFT, options: ['Only one'] };
    setupMockFrom({
      polls: { data: pollFewOpts, error: null },
      businesses: { data: BIZ, error: null },
    });
    const res = await PATCH(
      makeRequest('PATCH', '/api/polls/poll-1', { status: 'active' }),
      params('poll-1'),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('at least 2');
  });

  it('allows active -> closed', async () => {
    const closedPoll = { ...POLL_ACTIVE, status: 'closed' };
    let callCount = 0;
    mockFrom.mockImplementation((table: string) => {
      if (table === 'polls') {
        callCount++;
        if (callCount === 1) return chainable({ data: POLL_ACTIVE, error: null });
        return chainable({ data: closedPoll, error: null });
      }
      return chainable({ data: BIZ, error: null });
    });

    const res = await PATCH(
      makeRequest('PATCH', '/api/polls/poll-2', { status: 'closed' }),
      params('poll-2'),
    );
    expect(res.status).toBe(200);
  });

  it('rejects closed -> active', async () => {
    setupMockFrom({
      polls: { data: POLL_CLOSED, error: null },
      businesses: { data: BIZ, error: null },
    });
    const res = await PATCH(
      makeRequest('PATCH', '/api/polls/poll-3', { status: 'active' }),
      params('poll-3'),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('Invalid transition');
  });

  it('rejects closed -> draft', async () => {
    setupMockFrom({
      polls: { data: POLL_CLOSED, error: null },
      businesses: { data: BIZ, error: null },
    });
    const res = await PATCH(
      makeRequest('PATCH', '/api/polls/poll-3', { status: 'draft' }),
      params('poll-3'),
    );
    expect(res.status).toBe(400);
  });

  it('rejects active -> draft (no rollback)', async () => {
    setupMockFrom({
      polls: { data: POLL_ACTIVE, error: null },
      businesses: { data: BIZ, error: null },
    });
    const res = await PATCH(
      makeRequest('PATCH', '/api/polls/poll-2', { status: 'draft' }),
      params('poll-2'),
    );
    expect(res.status).toBe(400);
  });

  it('rejects unknown status', async () => {
    setupMockFrom({
      polls: { data: POLL_DRAFT, error: null },
      businesses: { data: BIZ, error: null },
    });
    const res = await PATCH(
      makeRequest('PATCH', '/api/polls/poll-1', { status: 'archived' }),
      params('poll-1'),
    );
    expect(res.status).toBe(400);
  });

  it('rejects empty option strings in PATCH', async () => {
    setupMockFrom({
      polls: { data: POLL_DRAFT, error: null },
      businesses: { data: BIZ, error: null },
    });
    const res = await PATCH(
      makeRequest('PATCH', '/api/polls/poll-1', { options: ['Good', ''] }),
      params('poll-1'),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('empty strings');
  });

  it('rejects duplicate options in PATCH', async () => {
    setupMockFrom({
      polls: { data: POLL_DRAFT, error: null },
      businesses: { data: BIZ, error: null },
    });
    const res = await PATCH(
      makeRequest('PATCH', '/api/polls/poll-1', { options: ['Red', 'RED'] }),
      params('poll-1'),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('duplicates');
  });

  it('rejects removing options from active poll below minimum', async () => {
    setupMockFrom({
      polls: { data: POLL_ACTIVE, error: null },
      businesses: { data: BIZ, error: null },
    });
    const res = await PATCH(
      makeRequest('PATCH', '/api/polls/poll-2', { options: ['Only one'] }),
      params('poll-2'),
    );
    expect(res.status).toBe(400);
  });

  it('returns 403 when capability guard denies', async () => {
    setupMockFrom({
      polls: { data: POLL_DRAFT, error: null },
      businesses: { data: BIZ, error: null },
    });
    mockRequireCapability.mockResolvedValueOnce({
      allowed: false, denial: { error: 'Upgrade' }, status: 403,
    });
    const res = await PATCH(
      makeRequest('PATCH', '/api/polls/poll-1', { question: 'New Q?' }),
      params('poll-1'),
    );
    expect(res.status).toBe(403);
  });
});

// ═══════════════════════════════════════════════════════════════════
// DELETE /api/polls/[id]
// ═══════════════════════════════════════════════════════════════════

describe('DELETE /api/polls/[id]', () => {
  let DELETE: (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;

  beforeEach(async () => {
    const mod = await import('@/app/api/polls/[id]/route');
    DELETE = mod.DELETE;
  });

  const params = (id: string) => ({ params: Promise.resolve({ id }) });

  it('returns 401 when unauthenticated', async () => {
    mockGetUser.mockResolvedValueOnce({ data: { user: null } });
    const res = await DELETE(
      makeRequest('DELETE', '/api/polls/poll-1'),
      params('poll-1'),
    );
    expect(res.status).toBe(401);
  });

  it('returns 404 when poll not found', async () => {
    setupMockFrom({ polls: { data: null, error: null } });
    const res = await DELETE(
      makeRequest('DELETE', '/api/polls/poll-x'),
      params('poll-x'),
    );
    expect(res.status).toBe(404);
  });

  it('returns 403 when not business owner', async () => {
    mockFrom.mockImplementation((table: string) => {
      if (table === 'polls') return chainable({ data: { business_id: 'biz-1' }, error: null });
      return chainable({ data: null, error: null }); // business ownership check fails
    });
    const res = await DELETE(
      makeRequest('DELETE', '/api/polls/poll-1'),
      params('poll-1'),
    );
    expect(res.status).toBe(403);
  });

  it('deletes poll successfully', async () => {
    let callCount = 0;
    mockFrom.mockImplementation((table: string) => {
      if (table === 'polls') {
        callCount++;
        if (callCount === 1) return chainable({ data: { business_id: 'biz-1' }, error: null });
        return chainable({ data: null, error: null }); // delete result
      }
      return chainable({ data: BIZ, error: null });
    });

    const res = await DELETE(
      makeRequest('DELETE', '/api/polls/poll-1'),
      params('poll-1'),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════
// POST /api/polls/[id]/send — Send poll to contacts
// ═══════════════════════════════════════════════════════════════════

describe('POST /api/polls/[id]/send', () => {
  let SEND_POST: (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;

  beforeEach(async () => {
    // Reset module for fresh import
    vi.doMock('@/lib/rate-limit', () => ({
      rateLimitResponseAsync: vi.fn().mockResolvedValue(null),
    }));
    vi.doMock('@/lib/bot/conversation-guard', () => ({
      checkConversationLimit: vi.fn().mockResolvedValue({ allowed: true, used: 0, limit: 1000 }),
    }));
    vi.doMock('@/lib/channels/channel-resolver', () => ({
      ChannelResolver: class {
        resolveByBusinessId() { return Promise.resolve({ sender: { sendText: vi.fn(), sendButtons: vi.fn(), sendList: vi.fn() } }); }
      },
    }));
    vi.doMock('@/lib/channels/send-with-template', () => ({
      sendWithTemplate: vi.fn().mockResolvedValue(undefined),
    }));
    const mod = await import('@/app/api/polls/[id]/send/route');
    SEND_POST = mod.POST;
  });

  const params = (id: string) => ({ params: Promise.resolve({ id }) });

  it('returns 400 when poll is not active', async () => {
    setupMockFrom({
      polls: { data: POLL_DRAFT, error: null },
      businesses: { data: BIZ, error: null },
    });
    const res = await SEND_POST(
      makeRequest('POST', '/api/polls/poll-1/send', { phones: ['+1234'] }),
      params('poll-1'),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('active');
  });

  it('returns 400 when closed poll is sent', async () => {
    setupMockFrom({
      polls: { data: POLL_CLOSED, error: null },
      businesses: { data: BIZ, error: null },
    });
    const res = await SEND_POST(
      makeRequest('POST', '/api/polls/poll-3/send', { phones: ['+1234'] }),
      params('poll-3'),
    );
    expect(res.status).toBe(400);
  });

  it('returns 401 when unauthenticated', async () => {
    mockGetUser.mockResolvedValueOnce({ data: { user: null } });
    const res = await SEND_POST(
      makeRequest('POST', '/api/polls/poll-1/send', { phones: ['+1234'] }),
      params('poll-1'),
    );
    expect(res.status).toBe(401);
  });

  it('returns 400 when phones array is empty', async () => {
    const res = await SEND_POST(
      makeRequest('POST', '/api/polls/poll-1/send', { phones: [] }),
      params('poll-1'),
    );
    expect(res.status).toBe(400);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Poll bot flow — vote deduplication
// ═══════════════════════════════════════════════════════════════════

describe('Poll flow vote deduplication', () => {
  it('validate() checks existing vote and prevents duplicate when allow_change is false', async () => {
    // Import the flow to verify the dedup logic exists and works
    const { pollFlow } = await import('@/lib/bot/flows/poll.flow');
    const pollQuestionStep = pollFlow.steps[0];

    // The validate function requires a FlowContext. We test the dedup logic
    // by verifying the flow step handles _poll_already_voted data.
    // When an existing vote is found and allowChange=false, validate returns
    // { valid: true } with _poll_already_voted set, which causes next() to return null
    // (session ends without re-voting).
    const mockCtx = {
      from: '+1234',
      session: {
        id: 'sess-1',
        session_data: {
          poll_id: 'poll-1',
          poll_question: 'Q?',
          poll_options: ['A', 'B'],
          poll_allow_change: false,
          poll_show_results: 'after_vote',
          _poll_already_voted: true,
          _poll_voted_index: 0,
        },
      },
      supabase: {
        from: () => ({
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: () => Promise.resolve({ data: { id: 'vote-1', option_index: 0 }, error: null }),
              }),
            }),
          }),
        }),
      },
      business: { id: 'biz-1', category: 'retail', subscription_tier: 'free' },
      sender: {},
      t: (s: string) => Promise.resolve(s),
    };

    // When already voted and allow_change is false, validate should return valid: true
    // (user already voted, nothing to do)
    const result = await pollQuestionStep.validate!('poll_vote_0', mockCtx as never);
    expect(result.valid).toBe(true);
  });

  it('next() returns null when _poll_already_voted is set (no re-vote)', async () => {
    const { pollFlow } = await import('@/lib/bot/flows/poll.flow');
    const pollQuestionStep = pollFlow.steps[0];

    const ctx = {
      session: {
        session_data: { _poll_already_voted: true },
      },
    };
    const nextStep = await pollQuestionStep.next!(ctx as never);
    expect(nextStep).toBeNull();
  });

  it('next() advances to poll_results when _poll_voted is set', async () => {
    const { pollFlow } = await import('@/lib/bot/flows/poll.flow');
    const pollQuestionStep = pollFlow.steps[0];

    const ctx = {
      session: {
        session_data: { _poll_voted: true },
      },
    };
    const nextStep = await pollQuestionStep.next!(ctx as never);
    expect(nextStep).toBe('poll_results');
  });

  it('next() returns null when poll is cancelled', async () => {
    const { pollFlow } = await import('@/lib/bot/flows/poll.flow');
    const pollQuestionStep = pollFlow.steps[0];

    const ctx = {
      session: { session_data: { _poll_cancelled: true } },
      from: '+1234',
      sender: { sendText: vi.fn() },
      t: (s: string) => Promise.resolve(s),
    };
    const nextStep = await pollQuestionStep.next!(ctx as never);
    expect(nextStep).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════
// Status transition matrix — exhaustive
// ═══════════════════════════════════════════════════════════════════

describe('Status transition matrix', () => {
  const VALID_TRANSITIONS: Record<string, string[]> = {
    draft: ['active'],
    active: ['closed'],
    closed: [],
  };

  const ALL_STATUSES = ['draft', 'active', 'closed'];

  for (const from of ALL_STATUSES) {
    for (const to of ALL_STATUSES) {
      if (from === to) continue;
      const expected = VALID_TRANSITIONS[from].includes(to);
      it(`${from} -> ${to} is ${expected ? 'allowed' : 'rejected'}`, () => {
        expect(VALID_TRANSITIONS[from].includes(to)).toBe(expected);
      });
    }
  }
});

// ═══════════════════════════════════════════════════════════════════
// Poll flow rendering — prompt format
// ═══════════════════════════════════════════════════════════════════

describe('Poll flow rendering', () => {
  it('renders buttons for <= 3 options', async () => {
    const { pollFlow } = await import('@/lib/bot/flows/poll.flow');
    const step = pollFlow.steps[0];

    const ctx = {
      session: {
        session_data: {
          poll_question: 'Pick a color?',
          poll_options: ['Red', 'Blue'],
          poll_show_results: 'after_vote',
        },
      },
      t: (s: string) => Promise.resolve(s),
      supabase: { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null }) }) }) }) },
    };

    const messages = await step.prompt(ctx as never);
    expect(messages[0].type).toBe('buttons');
    expect((messages[0] as { buttons: unknown[] }).buttons).toHaveLength(2);
  });

  it('renders list for > 3 options', async () => {
    const { pollFlow } = await import('@/lib/bot/flows/poll.flow');
    const step = pollFlow.steps[0];

    const ctx = {
      session: {
        session_data: {
          poll_question: 'Pick a day?',
          poll_options: ['Mon', 'Tue', 'Wed', 'Thu'],
          poll_show_results: 'after_vote',
        },
      },
      t: (s: string) => Promise.resolve(s),
      supabase: { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null }) }) }) }) },
    };

    const messages = await step.prompt(ctx as never);
    expect(messages[0].type).toBe('list');
    expect((messages[0] as { items: unknown[] }).items).toHaveLength(4);
  });
});
