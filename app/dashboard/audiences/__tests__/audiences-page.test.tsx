// @vitest-environment jsdom

/**
 * Engage Audiences Page — executable component tests
 *
 * Exercises actual rendered UI, user interactions, and intercepted API requests.
 * Covers: create/save, load/edit, delete, preview, API failures, capability
 * restrictions, expression round-trip, numeric in/not_in, nested none, and
 * unsupported saved expressions.
 */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within, act } from '@testing-library/react';

/* ── Hoisted state for mock control ── */

const state = vi.hoisted(() => ({
  business: {
    id: 'biz-test-001',
    name: 'Test Business',
    capabilities: ['broadcast'],
    country_code: 'NG',
  } as Record<string, unknown>,
  capReady: true,
}));

/* ── Mock DashboardProvider ── */

vi.mock('@/components/dashboard/DashboardProvider', () => ({
  useBusiness: () => state.business,
  useRequireCapability: () => state.capReady,
}));

vi.mock('@/components/dashboard/PageHelp', () => ({
  PageHelp: () => null,
}));

vi.mock('@/components/dashboard/EmptyState', () => ({
  default: ({ title, onAction }: { title: string; onAction?: () => void }) => (
    <div data-testid="empty-state">
      <span>{title}</span>
      {onAction && <button onClick={onAction} data-testid="empty-action">Create</button>}
    </div>
  ),
}));

/* ── Import after mocks ── */

import AudiencesPage from '../page';

/* ── Fetch mock helpers ── */

type FetchMock = ReturnType<typeof vi.fn>;

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

let fetchMock: FetchMock;

beforeEach(() => {
  fetchMock = vi.fn();
  global.fetch = fetchMock;
  state.capReady = true;
  state.business = {
    id: 'biz-test-001',
    name: 'Test Business',
    capabilities: ['broadcast'],
    country_code: 'NG',
  };
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/* ── 1. List view — empty state ── */

describe('List view', () => {
  it('shows empty state when no segments exist', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { success: true, segments: [] }));

    render(<AudiencesPage />);

    await waitFor(() => {
      expect(screen.getByTestId('empty-state')).toBeTruthy();
    });
    expect(screen.getByText('No audiences yet')).toBeTruthy();
  });

  it('lists saved segments', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, {
      success: true,
      segments: [
        { id: 'seg-1', name: 'VIP Customers', description: 'High spenders', expression: { type: 'all', children: [{ type: 'predicate', source: 'contact', field: 'tags', operator: 'contains', value: 'VIP' }] }, is_dynamic: true, created_at: '2026-10-20T10:00:00Z', updated_at: '2026-10-20T10:00:00Z' },
        { id: 'seg-2', name: 'Recent Bookers', description: null, expression: { type: 'all', children: [{ type: 'predicate', source: 'booking', field: 'created_at', operator: 'gte', value: '2026-09-01' }] }, is_dynamic: true, created_at: '2026-10-19T10:00:00Z', updated_at: '2026-10-19T10:00:00Z' },
      ],
    }));

    render(<AudiencesPage />);

    await waitFor(() => {
      expect(screen.getByText('VIP Customers')).toBeTruthy();
      expect(screen.getByText('Recent Bookers')).toBeTruthy();
    });
  });

  it('calls segments API with businessId', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { success: true, segments: [] }));
    render(<AudiencesPage />);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/engage/segments?businessId=biz-test-001');
    });
  });
});

/* ── 2. Create and save ── */

describe('Create and save', () => {
  it('creates a segment via POST with correct body', async () => {
    // Load empty list first
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { success: true, segments: [] }));
    render(<AudiencesPage />);

    await waitFor(() => expect(screen.getByTestId('empty-state')).toBeTruthy());

    // Click create
    fireEvent.click(screen.getByTestId('empty-action'));

    // Fill name
    const nameInput = screen.getByPlaceholderText(/Active Customers/i);
    fireEvent.change(nameInput, { target: { value: 'My Test Audience' } });

    // Mock the save + reload
    fetchMock.mockResolvedValueOnce(jsonResponse(201, { success: true, segment: { id: 'new-seg' } }));
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { success: true, segments: [{ id: 'new-seg', name: 'My Test Audience', description: null, expression: { type: 'all', children: [{ type: 'predicate', source: 'contact', field: 'phone', operator: 'eq', value: '' }] }, is_dynamic: true, created_at: '2026-10-21T00:00:00Z', updated_at: '2026-10-21T00:00:00Z' }] }));

    // Click save
    const saveBtn = screen.getByText('Save Audience');
    fireEvent.click(saveBtn);

    await waitFor(() => {
      const postCall = fetchMock.mock.calls.find(
        (c: [string, RequestInit?]) => c[1]?.method === 'POST' && c[0] === '/api/engage/segments',
      );
      expect(postCall).toBeTruthy();
      const body = JSON.parse(postCall![1]!.body as string);
      expect(body.businessId).toBe('biz-test-001');
      expect(body.name).toBe('My Test Audience');
      expect(body.expression.type).toBe('all');
    });
  });
});

/* ── 3. Delete confirmation ── */

describe('Delete', () => {
  it('requires confirmation before deleting', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, {
      success: true,
      segments: [{ id: 'seg-del', name: 'To Delete', description: null, expression: { type: 'all', children: [{ type: 'predicate', source: 'contact', field: 'phone', operator: 'eq', value: 'x' }] }, is_dynamic: true, created_at: '2026-10-20T10:00:00Z', updated_at: '2026-10-20T10:00:00Z' }],
    }));

    render(<AudiencesPage />);
    await waitFor(() => expect(screen.getByText('To Delete')).toBeTruthy());

    // First click shows Confirm/Cancel, not immediate delete
    const deleteBtn = screen.getByText('Delete');
    fireEvent.click(deleteBtn);
    expect(screen.getByText('Confirm')).toBeTruthy();
    expect(screen.getByText('Cancel')).toBeTruthy();
  });

  it('sends DELETE with businessId as query param, not body', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, {
      success: true,
      segments: [{ id: 'seg-del', name: 'To Delete', description: null, expression: { type: 'all', children: [{ type: 'predicate', source: 'contact', field: 'phone', operator: 'eq', value: 'x' }] }, is_dynamic: true, created_at: '2026-10-20T10:00:00Z', updated_at: '2026-10-20T10:00:00Z' }],
    }));

    render(<AudiencesPage />);
    await waitFor(() => expect(screen.getByText('To Delete')).toBeTruthy());

    fireEvent.click(screen.getByText('Delete'));

    // Mock delete + reload
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { success: true }));
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { success: true, segments: [] }));

    fireEvent.click(screen.getByText('Confirm'));

    await waitFor(() => {
      const deleteCall = fetchMock.mock.calls.find(
        (c: [string, RequestInit?]) => c[1]?.method === 'DELETE',
      );
      expect(deleteCall).toBeTruthy();
      // businessId must be in URL query params, NOT in body
      expect(deleteCall![0]).toBe('/api/engage/segments/seg-del?businessId=biz-test-001');
      expect(deleteCall![1]!.body).toBeUndefined();
    });
  });
});

/* ── 4. Preview ── */

describe('Preview', () => {
  it('calls preview API and displays counts', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { success: true, segments: [] }));
    render(<AudiencesPage />);
    await waitFor(() => expect(screen.getByTestId('empty-state')).toBeTruthy());

    // Enter create mode
    fireEvent.click(screen.getByTestId('empty-action'));
    fireEvent.change(screen.getByPlaceholderText(/Active Customers/i), { target: { value: 'Preview Test' } });

    // Mock preview
    fetchMock.mockResolvedValueOnce(jsonResponse(200, {
      success: true,
      total: 42,
      whatsappEligible: 30,
      emailEligible: 10,
      sample: [
        { identity: { key: 'phone:+2348000000001', phone: '+2348000000001', email: null, name: 'John Doe' }, whatsappEligible: true, emailEligible: false },
      ],
    }));

    fireEvent.click(screen.getByText('Preview Audience'));

    await waitFor(() => {
      expect(screen.getByText('42')).toBeTruthy();
      expect(screen.getByText('30')).toBeTruthy();
      expect(screen.getByText('10')).toBeTruthy();
      expect(screen.getByText('John Doe')).toBeTruthy();
    });
  });

  it('shows error on preview failure', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { success: true, segments: [] }));
    render(<AudiencesPage />);
    await waitFor(() => expect(screen.getByTestId('empty-state')).toBeTruthy());

    fireEvent.click(screen.getByTestId('empty-action'));
    fireEvent.change(screen.getByPlaceholderText(/Active Customers/i), { target: { value: 'Err Test' } });

    fetchMock.mockResolvedValueOnce(jsonResponse(422, { error: 'audience_too_large', message: 'Audience exceeds 10,000 contacts.' }));

    fireEvent.click(screen.getByText('Preview Audience'));

    await waitFor(() => {
      expect(screen.getByText('Preview Error')).toBeTruthy();
      expect(screen.getByText(/10,000 contacts/)).toBeTruthy();
    });
  });
});

/* ── 5. API failures ── */

describe('API failures', () => {
  it('shows error when segment list fails to load', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(500, { error: 'Internal server error' }));
    render(<AudiencesPage />);

    await waitFor(() => {
      expect(screen.getByText(/Internal server error|Failed to load/i)).toBeTruthy();
    });
  });

  it('shows save error when create fails', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { success: true, segments: [] }));
    render(<AudiencesPage />);
    await waitFor(() => expect(screen.getByTestId('empty-state')).toBeTruthy());

    fireEvent.click(screen.getByTestId('empty-action'));
    fireEvent.change(screen.getByPlaceholderText(/Active Customers/i), { target: { value: 'Fail Test' } });

    fetchMock.mockResolvedValueOnce(jsonResponse(403, { error: 'Insufficient permissions' }));

    fireEvent.click(screen.getByText('Save Audience'));

    await waitFor(() => {
      expect(screen.getByText(/Insufficient permissions/)).toBeTruthy();
    });
  });
});

/* ── 6. Capability restriction ── */

describe('Capability restriction', () => {
  it('shows upgrade message when broadcast capability is missing', () => {
    state.capReady = false;
    render(<AudiencesPage />);

    expect(screen.getByText(/Broadcast capability/i)).toBeTruthy();
    expect(screen.getByText(/Upgrade/i)).toBeTruthy();
  });
});

/* ── 7. Load and edit existing expression ── */

describe('Edit existing segment', () => {
  const complexExpression = {
    type: 'all' as const,
    children: [
      { type: 'predicate' as const, source: 'contact' as const, field: 'tags', operator: 'contains' as const, value: 'VIP' },
      {
        type: 'any' as const,
        children: [
          { type: 'predicate' as const, source: 'order' as const, field: 'total_amount', operator: 'gte' as const, value: 5000 },
          { type: 'predicate' as const, source: 'booking' as const, field: 'status', operator: 'eq' as const, value: 'confirmed' },
        ],
      },
    ],
  };

  it('loads an existing segment into the builder and preserves structure', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, {
      success: true,
      segments: [{ id: 'seg-edit', name: 'Complex Segment', description: 'Test', expression: complexExpression, is_dynamic: true, created_at: '2026-10-20T10:00:00Z', updated_at: '2026-10-20T10:00:00Z' }],
    }));

    render(<AudiencesPage />);
    await waitFor(() => expect(screen.getByText('Complex Segment')).toBeTruthy());

    // Click edit
    fireEvent.click(screen.getByText('Edit'));

    // Builder should show the name
    expect(screen.getByDisplayValue('Complex Segment')).toBeTruthy();
    expect(screen.getByDisplayValue('Test')).toBeTruthy();

    // Now save without changes — should PUT with the exact same expression
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { success: true, segment: { id: 'seg-edit' } }));
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { success: true, segments: [] }));

    fireEvent.click(screen.getByText('Update Audience'));

    await waitFor(() => {
      const putCall = fetchMock.mock.calls.find(
        (c: [string, RequestInit?]) => c[1]?.method === 'PUT',
      );
      expect(putCall).toBeTruthy();
      const body = JSON.parse(putCall![1]!.body as string);
      // Expression must be structurally identical to what was loaded
      expect(body.expression.type).toBe('all');
      expect(body.expression.children).toHaveLength(2);
      expect(body.expression.children[0].value).toBe('VIP');
      expect(body.expression.children[1].type).toBe('any');
      expect(body.expression.children[1].children).toHaveLength(2);
      expect(body.expression.children[1].children[0].value).toBe(5000);
    });
  });
});

/* ── 8. Nested NONE expression round-trip ── */

describe('Nested NONE expression', () => {
  it('preserves none group as direct child of all', async () => {
    const noneExpression = {
      type: 'all' as const,
      children: [
        { type: 'predicate' as const, source: 'contact' as const, field: 'tags', operator: 'contains' as const, value: 'member' },
        {
          type: 'none' as const,
          children: [
            { type: 'predicate' as const, source: 'contact' as const, field: 'tags', operator: 'contains' as const, value: 'inactive' },
          ],
        },
      ],
    };

    fetchMock.mockResolvedValueOnce(jsonResponse(200, {
      success: true,
      segments: [{ id: 'seg-none', name: 'Exclude Test', description: null, expression: noneExpression, is_dynamic: true, created_at: '2026-10-20T10:00:00Z', updated_at: '2026-10-20T10:00:00Z' }],
    }));

    render(<AudiencesPage />);
    await waitFor(() => expect(screen.getByText('Exclude Test')).toBeTruthy());

    fireEvent.click(screen.getByText('Edit'));

    // Save to verify round-trip
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { success: true, segment: { id: 'seg-none' } }));
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { success: true, segments: [] }));

    fireEvent.click(screen.getByText('Update Audience'));

    await waitFor(() => {
      const putCall = fetchMock.mock.calls.find((c: [string, RequestInit?]) => c[1]?.method === 'PUT');
      const body = JSON.parse(putCall![1]!.body as string);
      expect(body.expression.children[1].type).toBe('none');
      expect(body.expression.children[1].children[0].value).toBe('inactive');
    });
  });
});

/* ── 9. Unsupported saved expression shape ── */

describe('Unsupported expression handling', () => {
  it('wraps a bare predicate in an all group without discarding', async () => {
    // Server returns a bare predicate (not wrapped in a group)
    const barePredicate = {
      type: 'predicate' as const,
      source: 'contact' as const,
      field: 'phone',
      operator: 'eq' as const,
      value: '+2348000000001',
    };

    fetchMock.mockResolvedValueOnce(jsonResponse(200, {
      success: true,
      segments: [{ id: 'seg-bare', name: 'Bare Pred', description: null, expression: barePredicate, is_dynamic: true, created_at: '2026-10-20T10:00:00Z', updated_at: '2026-10-20T10:00:00Z' }],
    }));

    render(<AudiencesPage />);
    await waitFor(() => expect(screen.getByText('Bare Pred')).toBeTruthy());

    fireEvent.click(screen.getByText('Edit'));

    // Save — expression should be wrapped in all group with the original predicate preserved
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { success: true, segment: { id: 'seg-bare' } }));
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { success: true, segments: [] }));

    fireEvent.click(screen.getByText('Update Audience'));

    await waitFor(() => {
      const putCall = fetchMock.mock.calls.find((c: [string, RequestInit?]) => c[1]?.method === 'PUT');
      const body = JSON.parse(putCall![1]!.body as string);
      // Wrapped in an 'all' group, original predicate preserved
      expect(body.expression.type).toBe('all');
      expect(body.expression.children[0].type).toBe('predicate');
      expect(body.expression.children[0].value).toBe('+2348000000001');
    });
  });
});

/* ── 10. in/not_in array value handling ── */

describe('Array operator (in/not_in) handling', () => {
  it('preserves saved array values when loading a segment with in operator', async () => {
    const arrayExpression = {
      type: 'all' as const,
      children: [{
        type: 'predicate' as const,
        source: 'order' as const,
        field: 'status',
        operator: 'in' as const,
        value: ['completed', 'delivered', 'shipped'],
      }],
    };

    fetchMock.mockResolvedValueOnce(jsonResponse(200, {
      success: true,
      segments: [{ id: 'seg-arr', name: 'Array Test', description: null, expression: arrayExpression, is_dynamic: true, created_at: '2026-10-20T10:00:00Z', updated_at: '2026-10-20T10:00:00Z' }],
    }));

    render(<AudiencesPage />);
    await waitFor(() => expect(screen.getByText('Array Test')).toBeTruthy());

    fireEvent.click(screen.getByText('Edit'));

    // The array input should show the values as comma-separated
    const arrayInput = screen.getByLabelText('List values (comma-separated)');
    expect(arrayInput).toBeTruthy();
    expect((arrayInput as HTMLInputElement).value).toBe('completed, delivered, shipped');

    // Save without changes — round-trip must preserve the array
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { success: true, segment: { id: 'seg-arr' } }));
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { success: true, segments: [] }));

    fireEvent.click(screen.getByText('Update Audience'));

    await waitFor(() => {
      const putCall = fetchMock.mock.calls.find((c: [string, RequestInit?]) => c[1]?.method === 'PUT');
      const body = JSON.parse(putCall![1]!.body as string);
      expect(body.expression.children[0].operator).toBe('in');
      expect(body.expression.children[0].value).toEqual(['completed', 'delivered', 'shipped']);
    });
  });

  it('produces valid number arrays for numeric in operator', async () => {
    const numArrayExpression = {
      type: 'all' as const,
      children: [{
        type: 'predicate' as const,
        source: 'payment' as const,
        field: 'amount',
        operator: 'not_in' as const,
        value: [100, 200, 500],
      }],
    };

    fetchMock.mockResolvedValueOnce(jsonResponse(200, {
      success: true,
      segments: [{ id: 'seg-num-arr', name: 'Num Array', description: null, expression: numArrayExpression, is_dynamic: true, created_at: '2026-10-20T10:00:00Z', updated_at: '2026-10-20T10:00:00Z' }],
    }));

    render(<AudiencesPage />);
    await waitFor(() => expect(screen.getByText('Num Array')).toBeTruthy());

    fireEvent.click(screen.getByText('Edit'));

    const arrayInput = screen.getByLabelText('List values (comma-separated)');
    expect((arrayInput as HTMLInputElement).value).toBe('100, 200, 500');

    // Edit the values — change triggers draft, blur commits
    fireEvent.change(arrayInput, { target: { value: '100, 300, 700' } });
    fireEvent.blur(arrayInput);

    // Save and verify number types are preserved
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { success: true, segment: { id: 'seg-num-arr' } }));
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { success: true, segments: [] }));

    fireEvent.click(screen.getByText('Update Audience'));

    await waitFor(() => {
      const putCall = fetchMock.mock.calls.find((c: [string, RequestInit?]) => c[1]?.method === 'PUT');
      const body = JSON.parse(putCall![1]!.body as string);
      expect(body.expression.children[0].value).toEqual([100, 300, 700]);
      // Verify they are actual numbers, not strings
      expect(typeof body.expression.children[0].value[0]).toBe('number');
    });
  });

  it('switching from eq to in converts scalar to array', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, {
      success: true,
      segments: [{ id: 'seg-switch', name: 'Switch Test', description: null, expression: {
        type: 'all',
        children: [{ type: 'predicate', source: 'order', field: 'status', operator: 'eq', value: 'completed' }],
      }, is_dynamic: true, created_at: '2026-10-20T10:00:00Z', updated_at: '2026-10-20T10:00:00Z' }],
    }));

    render(<AudiencesPage />);
    await waitFor(() => expect(screen.getByText('Switch Test')).toBeTruthy());

    fireEvent.click(screen.getByText('Edit'));

    // Find the operator dropdown and switch to 'in'
    const operatorSelect = screen.getByDisplayValue('equals');
    fireEvent.change(operatorSelect, { target: { value: 'in' } });

    // Save — the scalar 'completed' should now be array ['completed']
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { success: true, segment: { id: 'seg-switch' } }));
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { success: true, segments: [] }));

    fireEvent.click(screen.getByText('Update Audience'));

    await waitFor(() => {
      const putCall = fetchMock.mock.calls.find((c: [string, RequestInit?]) => c[1]?.method === 'PUT');
      const body = JSON.parse(putCall![1]!.body as string);
      expect(body.expression.children[0].operator).toBe('in');
      expect(Array.isArray(body.expression.children[0].value)).toBe(true);
      expect(body.expression.children[0].value).toContain('completed');
    });
  });

  it('switching from in to eq converts array to first element', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, {
      success: true,
      segments: [{ id: 'seg-back', name: 'Back Test', description: null, expression: {
        type: 'all',
        children: [{ type: 'predicate', source: 'order', field: 'status', operator: 'in', value: ['completed', 'delivered'] }],
      }, is_dynamic: true, created_at: '2026-10-20T10:00:00Z', updated_at: '2026-10-20T10:00:00Z' }],
    }));

    render(<AudiencesPage />);
    await waitFor(() => expect(screen.getByText('Back Test')).toBeTruthy());

    fireEvent.click(screen.getByText('Edit'));

    // Switch from 'in' to 'eq' — all values preserved as joined string
    const operatorSelect = screen.getByDisplayValue('is one of');
    fireEvent.change(operatorSelect, { target: { value: 'eq' } });

    // Save — should preserve all values as joined string, not silently truncate
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { success: true, segment: { id: 'seg-back' } }));
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { success: true, segments: [] }));

    fireEvent.click(screen.getByText('Update Audience'));

    await waitFor(() => {
      const putCall = fetchMock.mock.calls.find((c: [string, RequestInit?]) => c[1]?.method === 'PUT');
      const body = JSON.parse(putCall![1]!.body as string);
      expect(body.expression.children[0].operator).toBe('eq');
      // All values preserved as joined string — user can see and edit
      expect(body.expression.children[0].value).toBe('completed, delivered');
      expect(Array.isArray(body.expression.children[0].value)).toBe(false);
    });
  });
});

/* ── 11. Draft input preservation and validation ── */

describe('Array draft input behavior', () => {
  it('preserves commas during typing — draft is not immediately committed', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { success: true, segments: [] }));
    render(<AudiencesPage />);
    await waitFor(() => expect(screen.getByTestId('empty-state')).toBeTruthy());

    fireEvent.click(screen.getByTestId('empty-action'));

    // Switch to 'in' operator
    const operatorSelect = screen.getByDisplayValue('equals');
    fireEvent.change(operatorSelect, { target: { value: 'in' } });

    // Type incrementally including a trailing comma
    const arrayInput = screen.getByLabelText('List values (comma-separated)');
    fireEvent.change(arrayInput, { target: { value: 'hello,' } });

    // The trailing comma should be preserved in the input (draft mode)
    expect((arrayInput as HTMLInputElement).value).toBe('hello,');
  });

  it('commits values on blur, stripping empty tokens', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { success: true, segments: [] }));
    render(<AudiencesPage />);
    await waitFor(() => expect(screen.getByTestId('empty-state')).toBeTruthy());

    fireEvent.click(screen.getByTestId('empty-action'));
    fireEvent.change(screen.getByPlaceholderText(/Active Customers/i), { target: { value: 'Blur Test' } });

    const operatorSelect = screen.getByDisplayValue('equals');
    fireEvent.change(operatorSelect, { target: { value: 'in' } });

    const arrayInput = screen.getByLabelText('List values (comma-separated)');
    fireEvent.change(arrayInput, { target: { value: 'alpha, beta, gamma' } });
    fireEvent.blur(arrayInput);

    // After blur, save and verify the committed array
    fetchMock.mockResolvedValueOnce(jsonResponse(201, { success: true, segment: { id: 'new' } }));
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { success: true, segments: [] }));

    fireEvent.click(screen.getByText('Save Audience'));

    await waitFor(() => {
      const postCall = fetchMock.mock.calls.find(
        (c: [string, RequestInit?]) => c[1]?.method === 'POST',
      );
      const body = JSON.parse(postCall![1]!.body as string);
      expect(body.expression.children[0].value).toEqual(['alpha', 'beta', 'gamma']);
    });
  });

  it('shows validation error for invalid numeric tokens instead of silently dropping', async () => {
    const numExpression = {
      type: 'all' as const,
      children: [{ type: 'predicate' as const, source: 'payment' as const, field: 'amount', operator: 'in' as const, value: [100, 200] }],
    };

    fetchMock.mockResolvedValueOnce(jsonResponse(200, {
      success: true,
      segments: [{ id: 'seg-num', name: 'Num Validate', description: null, expression: numExpression, is_dynamic: true, created_at: '2026-10-20T10:00:00Z', updated_at: '2026-10-20T10:00:00Z' }],
    }));

    render(<AudiencesPage />);
    await waitFor(() => expect(screen.getByText('Num Validate')).toBeTruthy());

    fireEvent.click(screen.getByText('Edit'));

    const arrayInput = screen.getByLabelText('List values (comma-separated)');
    // Type an invalid number
    fireEvent.change(arrayInput, { target: { value: '100, abc, 300' } });
    fireEvent.blur(arrayInput);

    // Should show an error for "abc"
    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeTruthy();
      expect(screen.getByText(/not a valid number/i)).toBeTruthy();
    });
  });

  it('commits on Enter key press', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { success: true, segments: [] }));
    render(<AudiencesPage />);
    await waitFor(() => expect(screen.getByTestId('empty-state')).toBeTruthy());

    fireEvent.click(screen.getByTestId('empty-action'));
    fireEvent.change(screen.getByPlaceholderText(/Active Customers/i), { target: { value: 'Enter Test' } });

    const operatorSelect = screen.getByDisplayValue('equals');
    fireEvent.change(operatorSelect, { target: { value: 'in' } });

    const arrayInput = screen.getByLabelText('List values (comma-separated)');
    fireEvent.change(arrayInput, { target: { value: 'one, two, three' } });
    fireEvent.keyDown(arrayInput, { key: 'Enter' });

    // Save and verify committed values
    fetchMock.mockResolvedValueOnce(jsonResponse(201, { success: true, segment: { id: 'new' } }));
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { success: true, segments: [] }));

    fireEvent.click(screen.getByText('Save Audience'));

    await waitFor(() => {
      const postCall = fetchMock.mock.calls.find(
        (c: [string, RequestInit?]) => c[1]?.method === 'POST',
      );
      const body = JSON.parse(postCall![1]!.body as string);
      expect(body.expression.children[0].value).toEqual(['one', 'two', 'three']);
    });
  });
});

/* ── 12. P1: Invalid numeric draft cannot trigger save/preview with stale data ── */

describe('Invalid draft blocks save and preview', () => {
  it('save is blocked when numeric array has invalid tokens', async () => {
    const numExpression = {
      type: 'all' as const,
      children: [{ type: 'predicate' as const, source: 'payment' as const, field: 'amount', operator: 'in' as const, value: [100, 200] }],
    };

    fetchMock.mockResolvedValueOnce(jsonResponse(200, {
      success: true,
      segments: [{ id: 'seg-block', name: 'Block Test', description: null, expression: numExpression, is_dynamic: true, created_at: '2026-10-20T10:00:00Z', updated_at: '2026-10-20T10:00:00Z' }],
    }));

    render(<AudiencesPage />);
    await waitFor(() => expect(screen.getByText('Block Test')).toBeTruthy());

    fireEvent.click(screen.getByText('Edit'));

    // Type invalid numeric values and blur to commit
    const arrayInput = screen.getByLabelText('List values (comma-separated)');
    fireEvent.change(arrayInput, { target: { value: '100, abc, 300' } });
    fireEvent.blur(arrayInput);

    // Inline error should be visible
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());

    // Try to save — should be blocked, NOT send the old [100, 200]
    fireEvent.click(screen.getByText('Update Audience'));

    // Wait a tick and verify NO PUT was made
    await act(async () => { await new Promise(r => setTimeout(r, 50)); });
    const putCall = fetchMock.mock.calls.find(
      (c: [string, RequestInit?]) => c[1]?.method === 'PUT',
    );
    expect(putCall).toBeUndefined();

    // Validation error should be shown to the user
    expect(screen.getByText(/Fix invalid values/i)).toBeTruthy();
  });

  it('preview is blocked when numeric array has invalid tokens', async () => {
    const numExpression = {
      type: 'all' as const,
      children: [{ type: 'predicate' as const, source: 'payment' as const, field: 'amount', operator: 'in' as const, value: [50] }],
    };

    fetchMock.mockResolvedValueOnce(jsonResponse(200, {
      success: true,
      segments: [{ id: 'seg-prev-block', name: 'Preview Block', description: null, expression: numExpression, is_dynamic: true, created_at: '2026-10-20T10:00:00Z', updated_at: '2026-10-20T10:00:00Z' }],
    }));

    render(<AudiencesPage />);
    await waitFor(() => expect(screen.getByText('Preview Block')).toBeTruthy());

    fireEvent.click(screen.getByText('Edit'));

    const arrayInput = screen.getByLabelText('List values (comma-separated)');
    fireEvent.change(arrayInput, { target: { value: '50, xyz' } });
    fireEvent.blur(arrayInput);

    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());

    // Try preview — should be blocked
    fireEvent.click(screen.getByText('Preview Audience'));

    await act(async () => { await new Promise(r => setTimeout(r, 50)); });
    // No preview API call should have been made
    const previewCall = fetchMock.mock.calls.find(
      (c: [string, RequestInit?]) => c[0] === '/api/engage/audience/preview',
    );
    expect(previewCall).toBeUndefined();

    expect(screen.getByText(/Fix invalid values/i)).toBeTruthy();
  });

  it('invalid draft text remains visible until user corrects it', async () => {
    const numExpression = {
      type: 'all' as const,
      children: [{ type: 'predicate' as const, source: 'payment' as const, field: 'amount', operator: 'in' as const, value: [100] }],
    };

    fetchMock.mockResolvedValueOnce(jsonResponse(200, {
      success: true,
      segments: [{ id: 'seg-vis', name: 'Visible Draft', description: null, expression: numExpression, is_dynamic: true, created_at: '2026-10-20T10:00:00Z', updated_at: '2026-10-20T10:00:00Z' }],
    }));

    render(<AudiencesPage />);
    await waitFor(() => expect(screen.getByText('Visible Draft')).toBeTruthy());

    fireEvent.click(screen.getByText('Edit'));

    const arrayInput = screen.getByLabelText('List values (comma-separated)') as HTMLInputElement;
    fireEvent.change(arrayInput, { target: { value: '100, bad' } });
    fireEvent.blur(arrayInput);

    // The invalid text should remain visible in the input (not revert to "100")
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    // Draft should still show the invalid text since commit failed
    expect(arrayInput.value).toBe('100, bad');
  });
});

/* ── 13. P1: Numeric array-to-scalar operator conversion ── */

describe('Numeric array-to-scalar operator conversion', () => {
  it('blocks numeric multi-value array from switching to scalar operator', async () => {
    const numArrayExpression = {
      type: 'all' as const,
      children: [{ type: 'predicate' as const, source: 'payment' as const, field: 'amount', operator: 'in' as const, value: [100, 200, 300] }],
    };

    fetchMock.mockResolvedValueOnce(jsonResponse(200, {
      success: true,
      segments: [{ id: 'seg-num-block', name: 'Num Block', description: null, expression: numArrayExpression, is_dynamic: true, created_at: '2026-10-20T10:00:00Z', updated_at: '2026-10-20T10:00:00Z' }],
    }));

    render(<AudiencesPage />);
    await waitFor(() => expect(screen.getByText('Num Block')).toBeTruthy());

    fireEvent.click(screen.getByText('Edit'));

    // Try to switch from 'in' to 'eq' with multiple numeric values
    const operatorSelect = screen.getByDisplayValue('is one of');
    fireEvent.change(operatorSelect, { target: { value: 'eq' } });

    // The operator should NOT have changed (blocked)
    // An error message should be shown
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(screen.getByText(/Remove values until one remains/i)).toBeTruthy();
  });

  it('allows numeric single-value array to switch to scalar operator', async () => {
    const singleNumExpression = {
      type: 'all' as const,
      children: [{ type: 'predicate' as const, source: 'payment' as const, field: 'amount', operator: 'in' as const, value: [500] }],
    };

    fetchMock.mockResolvedValueOnce(jsonResponse(200, {
      success: true,
      segments: [{ id: 'seg-single', name: 'Single Num', description: null, expression: singleNumExpression, is_dynamic: true, created_at: '2026-10-20T10:00:00Z', updated_at: '2026-10-20T10:00:00Z' }],
    }));

    render(<AudiencesPage />);
    await waitFor(() => expect(screen.getByText('Single Num')).toBeTruthy());

    fireEvent.click(screen.getByText('Edit'));

    // Switch from 'in' to 'eq' — should work because only 1 value
    const operatorSelect = screen.getByDisplayValue('is one of');
    fireEvent.change(operatorSelect, { target: { value: 'eq' } });

    // Save and verify the scalar conversion
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { success: true, segment: { id: 'seg-single' } }));
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { success: true, segments: [] }));

    fireEvent.click(screen.getByText('Update Audience'));

    await waitFor(() => {
      const putCall = fetchMock.mock.calls.find((c: [string, RequestInit?]) => c[1]?.method === 'PUT');
      const body = JSON.parse(putCall![1]!.body as string);
      expect(body.expression.children[0].operator).toBe('eq');
      expect(body.expression.children[0].value).toBe(500);
      expect(typeof body.expression.children[0].value).toBe('number');
    });
  });
});

/* ── 14. Multi-condition independent error tracking ── */

describe('Multi-condition validation independence', () => {
  it('valid edit on Condition B does NOT clear invalid Condition A — save blocked', async () => {
    // Two conditions: one numeric in (will be made invalid), one string eq (valid)
    const twoConditionExpression = {
      type: 'all' as const,
      children: [
        { type: 'predicate' as const, source: 'payment' as const, field: 'amount', operator: 'in' as const, value: [100] },
        { type: 'predicate' as const, source: 'contact' as const, field: 'name', operator: 'eq' as const, value: 'Alice' },
      ],
    };

    fetchMock.mockResolvedValueOnce(jsonResponse(200, {
      success: true,
      segments: [{ id: 'seg-multi', name: 'Multi Test', description: null, expression: twoConditionExpression, is_dynamic: true, created_at: '2026-10-21T00:00:00Z', updated_at: '2026-10-21T00:00:00Z' }],
    }));

    render(<AudiencesPage />);
    await waitFor(() => expect(screen.getByText('Multi Test')).toBeTruthy());

    fireEvent.click(screen.getByText('Edit'));

    // Make Condition A invalid: type bad numeric data and blur
    const arrayInputs = screen.getAllByLabelText('List values (comma-separated)');
    expect(arrayInputs.length).toBe(1); // Only the in/not_in condition has this label
    fireEvent.change(arrayInputs[0], { target: { value: '100, bad' } });
    fireEvent.blur(arrayInputs[0]);

    // Confirm error appears
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());

    // Now edit Condition B (the valid string eq) — change value
    const textInputs = screen.getAllByPlaceholderText('Value');
    // Find the one showing 'Alice'
    const aliceInput = textInputs.find(el => (el as HTMLInputElement).value === 'Alice');
    expect(aliceInput).toBeTruthy();
    fireEvent.change(aliceInput!, { target: { value: 'Bob' } });

    // Condition A's error should STILL be present
    expect(screen.getByRole('alert')).toBeTruthy();

    // Try to save — should be BLOCKED because Condition A is still invalid
    fireEvent.click(screen.getByText('Update Audience'));

    await act(async () => { await new Promise(r => setTimeout(r, 50)); });
    const putCall = fetchMock.mock.calls.find(
      (c: [string, RequestInit?]) => c[1]?.method === 'PUT',
    );
    expect(putCall).toBeUndefined();

    // User should see the blocking message
    expect(screen.getByText(/Fix invalid values/i)).toBeTruthy();
  });

  it('fixing the invalid condition then allows save', async () => {
    const twoConditionExpression = {
      type: 'all' as const,
      children: [
        { type: 'predicate' as const, source: 'payment' as const, field: 'amount', operator: 'in' as const, value: [100] },
        { type: 'predicate' as const, source: 'contact' as const, field: 'name', operator: 'eq' as const, value: 'Alice' },
      ],
    };

    fetchMock.mockResolvedValueOnce(jsonResponse(200, {
      success: true,
      segments: [{ id: 'seg-fix', name: 'Fix Test', description: null, expression: twoConditionExpression, is_dynamic: true, created_at: '2026-10-21T00:00:00Z', updated_at: '2026-10-21T00:00:00Z' }],
    }));

    render(<AudiencesPage />);
    await waitFor(() => expect(screen.getByText('Fix Test')).toBeTruthy());

    fireEvent.click(screen.getByText('Edit'));

    // Make Condition A invalid
    const arrayInputs = screen.getAllByLabelText('List values (comma-separated)');
    fireEvent.change(arrayInputs[0], { target: { value: '100, bad' } });
    fireEvent.blur(arrayInputs[0]);
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());

    // Now fix Condition A
    fireEvent.change(arrayInputs[0], { target: { value: '100, 200' } });
    fireEvent.blur(arrayInputs[0]);

    // Error should clear
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());

    // Save should now succeed
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { success: true, segment: { id: 'seg-fix' } }));
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { success: true, segments: [] }));

    fireEvent.click(screen.getByText('Update Audience'));

    await waitFor(() => {
      const putCall = fetchMock.mock.calls.find(
        (c: [string, RequestInit?]) => c[1]?.method === 'PUT',
      );
      expect(putCall).toBeTruthy();
      const body = JSON.parse(putCall![1]!.body as string);
      expect(body.expression.children[0].value).toEqual([100, 200]);
      expect(body.expression.children[1].value).toBe('Alice');
    });
  });
});
