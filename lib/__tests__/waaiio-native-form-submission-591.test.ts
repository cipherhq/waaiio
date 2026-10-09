import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  encodeFlowToken,
  decodeFlowToken,
  handleFlowSubmission,
} from '@/lib/whatsapp-forms/submission-handler';

// ── Flow token encoding/decoding ──

describe('#591 flow token encoding/decoding', () => {
  const BIZ = '00000000-0000-4000-8000-000000000111';
  const FORM = '00000000-0000-4000-8000-000000000222';

  it('encodes and decodes a round-trip flow token', () => {
    const token = encodeFlowToken(FORM, BIZ);
    expect(token).toMatch(/^waaiio_form:/);
    const decoded = decodeFlowToken(token);
    expect(decoded).not.toBeNull();
    expect(decoded!.formId).toBe(FORM);
    expect(decoded!.businessId).toBe(BIZ);
    expect(decoded!.sentAt).toBeDefined();
  });

  it('rejects malformed tokens', () => {
    expect(decodeFlowToken('')).toBeNull();
    expect(decodeFlowToken('random_string')).toBeNull();
    expect(decodeFlowToken('waaiio_form:not-uuid:also-not-uuid')).toBeNull();
    expect(decodeFlowToken('other_prefix:' + FORM + ':' + BIZ)).toBeNull();
  });

  it('rejects null/undefined', () => {
    expect(decodeFlowToken(null as any)).toBeNull();
    expect(decodeFlowToken(undefined as any)).toBeNull();
  });
});

// ── Submission handler with mocked Supabase ──

const mockRpc = vi.fn();
const mockFrom = vi.fn();

const makeSupabase = () => ({
  from: mockFrom,
  rpc: mockRpc,
});

const BIZ = '00000000-0000-4000-8000-000000000111';
const FORM = '00000000-0000-4000-8000-000000000222';
const META_MSG = 'wamid.test123';

const formRecord = () => ({
  id: FORM,
  business_id: BIZ,
  title: 'Lead Registration',
  fields: [
    { id: 'full_name', label: 'Full name', type: 'text', required: true },
    { id: 'email', label: 'Email', type: 'email', required: false },
  ],
  is_active: true,
  settings: {},
});

function chainMock(result: { data: unknown; error: unknown }) {
  return {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnValue({ select: vi.fn().mockReturnValue({ single: vi.fn().mockResolvedValue(result) }) }),
    update: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) }),
    maybeSingle: vi.fn().mockResolvedValue(result),
    single: vi.fn().mockResolvedValue(result),
  };
}

describe('#591 Flow submission handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRpc.mockResolvedValue({ data: null, error: null });
  });

  it('rejects invalid flow token', async () => {
    const result = await handleFlowSubmission(
      makeSupabase() as any,
      '2348012345678',
      BIZ,
      { responseJson: { full_name: 'John' }, flowToken: 'invalid_token' },
      META_MSG,
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid flow token');
  });

  it('blocks cross-tenant submission', async () => {
    const DIFFERENT_BIZ = '00000000-0000-4000-8000-000000000999';
    const token = encodeFlowToken(FORM, DIFFERENT_BIZ);

    // Mock idempotency check
    mockFrom.mockImplementation(() => chainMock({ data: null, error: null }));

    const result = await handleFlowSubmission(
      makeSupabase() as any,
      '2348012345678',
      BIZ, // Channel business ID differs from token business ID
      { responseJson: { full_name: 'John' }, flowToken: token },
      META_MSG,
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('Cross-tenant');
  });

  it('deduplicates by meta message ID', async () => {
    const token = encodeFlowToken(FORM, BIZ);

    // First call: idempotency check returns existing record
    mockFrom.mockImplementation((table: string) => {
      if (table === 'form_responses') {
        return chainMock({ data: { id: 'existing-response-id' }, error: null });
      }
      return chainMock({ data: null, error: null });
    });

    const result = await handleFlowSubmission(
      makeSupabase() as any,
      '2348012345678',
      BIZ,
      { responseJson: { full_name: 'John' }, flowToken: token },
      META_MSG,
    );
    expect(result.success).toBe(true);
    expect(result.duplicate).toBe(true);
    expect(result.responseId).toBe('existing-response-id');
  });

  it('rejects response with extra/injected fields', async () => {
    const token = encodeFlowToken(FORM, BIZ);

    let callCount = 0;
    mockFrom.mockImplementation((table: string) => {
      if (table === 'form_responses' && callCount === 0) {
        callCount++;
        return chainMock({ data: null, error: null }); // No duplicate
      }
      if (table === 'forms') {
        return chainMock({ data: formRecord(), error: null });
      }
      return chainMock({ data: null, error: null });
    });

    const result = await handleFlowSubmission(
      makeSupabase() as any,
      '2348012345678',
      BIZ,
      {
        responseJson: { full_name: 'John', injected_field: 'malicious' },
        flowToken: token,
      },
      META_MSG,
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('Unexpected field');
  });

  it('rejects response missing required fields', async () => {
    const token = encodeFlowToken(FORM, BIZ);

    let callCount = 0;
    mockFrom.mockImplementation((table: string) => {
      if (table === 'form_responses' && callCount === 0) {
        callCount++;
        return chainMock({ data: null, error: null }); // No duplicate
      }
      if (table === 'forms') {
        return chainMock({ data: formRecord(), error: null });
      }
      return chainMock({ data: null, error: null });
    });

    const result = await handleFlowSubmission(
      makeSupabase() as any,
      '2348012345678',
      BIZ,
      {
        responseJson: { email: 'john@test.com' }, // Missing required full_name
        flowToken: token,
      },
      META_MSG,
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('Full name');
  });

  it('processes valid submission successfully', async () => {
    const token = encodeFlowToken(FORM, BIZ);

    let callCount = 0;
    const insertMock = vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        single: vi.fn().mockResolvedValue({ data: { id: 'new-response-id' }, error: null }),
      }),
    });

    mockFrom.mockImplementation((table: string) => {
      if (table === 'form_responses' && callCount === 0) {
        callCount++;
        // Idempotency check — no duplicate
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
        };
      }
      if (table === 'form_responses' && callCount === 1) {
        callCount++;
        // Second form_responses call: pending record check
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
        };
      }
      if (table === 'form_responses') {
        // Insert
        return { insert: insertMock };
      }
      if (table === 'forms') {
        return chainMock({ data: formRecord(), error: null });
      }
      return chainMock({ data: null, error: null });
    });

    const result = await handleFlowSubmission(
      makeSupabase() as any,
      '2348012345678',
      BIZ,
      {
        responseJson: { full_name: 'John Doe', email: 'john@test.com' },
        flowToken: token,
      },
      META_MSG,
    );
    expect(result.success).toBe(true);
    expect(result.duplicate).toBeFalsy();
  });

  it('rejects submission for inactive form', async () => {
    const token = encodeFlowToken(FORM, BIZ);

    let callCount = 0;
    mockFrom.mockImplementation((table: string) => {
      if (table === 'form_responses' && callCount === 0) {
        callCount++;
        return chainMock({ data: null, error: null }); // No duplicate
      }
      if (table === 'forms') {
        return chainMock({ data: { ...formRecord(), is_active: false }, error: null });
      }
      return chainMock({ data: null, error: null });
    });

    const result = await handleFlowSubmission(
      makeSupabase() as any,
      '2348012345678',
      BIZ,
      { responseJson: { full_name: 'John' }, flowToken: token },
      META_MSG,
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('no longer accepting');
  });

  it('rejects submission for form not found', async () => {
    const token = encodeFlowToken(FORM, BIZ);

    let callCount = 0;
    mockFrom.mockImplementation((table: string) => {
      if (table === 'form_responses' && callCount === 0) {
        callCount++;
        return chainMock({ data: null, error: null }); // No duplicate
      }
      if (table === 'forms') {
        return chainMock({ data: null, error: null }); // Form not found
      }
      return chainMock({ data: null, error: null });
    });

    const result = await handleFlowSubmission(
      makeSupabase() as any,
      '2348012345678',
      BIZ,
      { responseJson: { full_name: 'John' }, flowToken: token },
      META_MSG,
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });
});

describe('#591 booking request invariants', () => {
  it('booking_request form type does NOT create a confirmed booking', async () => {
    // This test verifies the invariant that form submissions of type booking_request
    // only store booking request metadata in form_responses, never create
    // entries in the bookings table or bypass payment/availability checks.
    const token = encodeFlowToken(FORM, BIZ);

    let callCount = 0;
    const updateCalls: Array<Record<string, unknown>> = [];
    const insertCalls: Array<Record<string, unknown>> = [];

    mockFrom.mockImplementation((table: string) => {
      if (table === 'form_responses' && callCount === 0) {
        callCount++;
        return chainMock({ data: null, error: null }); // No duplicate
      }
      if (table === 'form_responses' && callCount === 1) {
        callCount++;
        return chainMock({ data: null, error: null }); // No pending record
      }
      if (table === 'form_responses') {
        // Track insert/update calls
        return {
          insert: vi.fn((data: Record<string, unknown>) => {
            insertCalls.push(data);
            return {
              select: vi.fn().mockReturnValue({
                single: vi.fn().mockResolvedValue({ data: { id: 'new-response-id' }, error: null }),
              }),
            };
          }),
          update: vi.fn((data: Record<string, unknown>) => {
            updateCalls.push(data);
            return { eq: vi.fn().mockResolvedValue({ error: null }) };
          }),
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
        };
      }
      if (table === 'forms') {
        return chainMock({
          data: {
            ...formRecord(),
            settings: { form_type: 'booking_request' },
            fields: [
              { id: 'full_name', label: 'Full name', type: 'text', required: true },
              { id: 'date', label: 'Preferred date', type: 'date', required: true },
            ],
          },
          error: null,
        });
      }
      // Should NEVER query the bookings table
      if (table === 'bookings') {
        throw new Error('INVARIANT VIOLATION: booking_request must NOT touch the bookings table');
      }
      return chainMock({ data: null, error: null });
    });

    const result = await handleFlowSubmission(
      makeSupabase() as any,
      '2348012345678',
      BIZ,
      {
        responseJson: { full_name: 'John', date: '2026-12-25' },
        flowToken: token,
      },
      META_MSG,
    );

    // Submission should succeed
    expect(result.success).toBe(true);
    // The bookings table was never touched
    // (if it were, the mock would throw)

    // Verify booking request metadata contains status: pending_review
    const allCalls = [...insertCalls, ...updateCalls];
    const bookingMetadata = allCalls.find(c =>
      c.metadata && (c.metadata as Record<string, unknown>).booking_request,
    );
    if (bookingMetadata) {
      const br = (bookingMetadata.metadata as Record<string, unknown>).booking_request as Record<string, unknown>;
      expect(br.status).toBe('pending_review');
    }
  });
});
