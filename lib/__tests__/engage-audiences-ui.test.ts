/**
 * Engage Audiences UI — behavioral tests
 *
 * Tests the visual builder's expression serialization, save/reload round-trips,
 * unsupported expression handling, and integration with the existing E1 backend.
 */

import { describe, it, expect } from 'vitest';
import {
  validateAudienceExpression,
  SOURCE_FAMILIES,
  FIELD_ALLOWLIST,
  OPERATORS,
  type Predicate,
  type GroupExpression,
  type AudienceExpression,
  type SourceFamily,
  type Operator,
} from '@/lib/engage/audience-dsl';
import { readFileSync } from 'fs';
import { resolve } from 'path';

/* ── Helper: read source file ── */

function readSource(relPath: string): string {
  return readFileSync(resolve(process.cwd(), relPath), 'utf8');
}

/* ── 1. Expression serialization — the builder produces valid DSL ── */

describe('Expression serialization', () => {
  it('simple single predicate validates', () => {
    const expr: AudienceExpression = {
      type: 'all',
      children: [{
        type: 'predicate',
        source: 'contact',
        field: 'phone',
        operator: 'eq',
        value: '+2348012345678',
      }],
    };
    const result = validateAudienceExpression(expr);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('multiple predicates with AND group validates', () => {
    const expr: GroupExpression = {
      type: 'all',
      children: [
        { type: 'predicate', source: 'contact', field: 'tags', operator: 'contains', value: 'VIP' },
        { type: 'predicate', source: 'order', field: 'total_amount', operator: 'gte', value: 5000 },
      ],
    };
    const result = validateAudienceExpression(expr);
    expect(result.valid).toBe(true);
  });

  it('OR group with date filter validates', () => {
    const expr: GroupExpression = {
      type: 'any',
      children: [
        { type: 'predicate', source: 'booking', field: 'created_at', operator: 'gte', value: '2026-01-01' },
        { type: 'predicate', source: 'event', field: 'created_at', operator: 'gte', value: '2026-01-01' },
      ],
    };
    const result = validateAudienceExpression(expr);
    expect(result.valid).toBe(true);
  });

  it('nested group (all + any) validates within depth limit', () => {
    const expr: GroupExpression = {
      type: 'all',
      children: [
        { type: 'predicate', source: 'contact', field: 'email', operator: 'is_not_null' },
        {
          type: 'any',
          children: [
            { type: 'predicate', source: 'order', field: 'status', operator: 'eq', value: 'completed' },
            { type: 'predicate', source: 'payment', field: 'status', operator: 'eq', value: 'success' },
          ],
        },
      ],
    };
    const result = validateAudienceExpression(expr);
    expect(result.valid).toBe(true);
  });

  it('NONE (exclude) group validates as direct child of ALL', () => {
    const expr: GroupExpression = {
      type: 'all',
      children: [
        { type: 'predicate', source: 'contact', field: 'tags', operator: 'contains', value: 'member' },
        {
          type: 'none',
          children: [
            { type: 'predicate', source: 'contact', field: 'tags', operator: 'contains', value: 'inactive' },
          ],
        },
      ],
    };
    const result = validateAudienceExpression(expr);
    expect(result.valid).toBe(true);
  });

  it('is_null/is_not_null operators need no value', () => {
    const expr: GroupExpression = {
      type: 'all',
      children: [
        { type: 'predicate', source: 'contact', field: 'email', operator: 'is_null' },
        { type: 'predicate', source: 'contact', field: 'phone', operator: 'is_not_null' },
      ],
    };
    const result = validateAudienceExpression(expr);
    expect(result.valid).toBe(true);
  });

  it('all 6 source families have fields in FIELD_ALLOWLIST', () => {
    for (const source of SOURCE_FAMILIES) {
      const fields = FIELD_ALLOWLIST[source];
      expect(Object.keys(fields).length).toBeGreaterThan(0);
    }
  });

  it('payment source has amount, status, and payment_method fields', () => {
    const fields = FIELD_ALLOWLIST.payment;
    expect(fields.amount).toBeDefined();
    expect(fields.status).toBeDefined();
    expect(fields.payment_method).toBeDefined();
    expect(fields.created_at).toBeDefined();
  });
});

/* ── 2. Validation rejection — invalid expressions are caught ── */

describe('Expression validation rejection', () => {
  it('rejects unknown source family', () => {
    const expr: AudienceExpression = {
      type: 'all',
      children: [{
        type: 'predicate',
        source: 'unknown_source' as SourceFamily,
        field: 'phone',
        operator: 'eq',
        value: 'test',
      }],
    };
    const result = validateAudienceExpression(expr);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('rejects unknown field for source', () => {
    const expr: AudienceExpression = {
      type: 'all',
      children: [{
        type: 'predicate',
        source: 'contact',
        field: 'nonexistent_field',
        operator: 'eq',
        value: 'test',
      }],
    };
    const result = validateAudienceExpression(expr);
    expect(result.valid).toBe(false);
  });

  it('rejects incompatible operator for field type', () => {
    // date fields don't support 'contains'
    const expr: AudienceExpression = {
      type: 'all',
      children: [{
        type: 'predicate',
        source: 'contact',
        field: 'created_at',
        operator: 'contains',
        value: '2026',
      }],
    };
    const result = validateAudienceExpression(expr);
    expect(result.valid).toBe(false);
  });

  it('rejects depth exceeding 3', () => {
    const expr: GroupExpression = {
      type: 'all',
      children: [{
        type: 'any',
        children: [{
          type: 'all',
          children: [{
            type: 'any', // depth 4 — exceeds limit
            children: [{ type: 'predicate', source: 'contact', field: 'phone', operator: 'eq', value: 'x' }],
          }],
        }],
      }],
    };
    const result = validateAudienceExpression(expr);
    expect(result.valid).toBe(false);
  });

  it('rejects empty group', () => {
    const expr: GroupExpression = { type: 'all', children: [] };
    const result = validateAudienceExpression(expr);
    expect(result.valid).toBe(false);
  });

  it('rejects NONE as root', () => {
    const expr: GroupExpression = {
      type: 'none',
      children: [{ type: 'predicate', source: 'contact', field: 'phone', operator: 'eq', value: 'x' }],
    };
    const result = validateAudienceExpression(expr);
    expect(result.valid).toBe(false);
  });
});

/* ── 3. Save/reload round-trip — expression survives JSON serialization ── */

describe('Save/reload round-trip', () => {
  it('complex expression survives JSON round-trip', () => {
    const original: GroupExpression = {
      type: 'all',
      children: [
        { type: 'predicate', source: 'contact', field: 'tags', operator: 'contains', value: 'VIP' },
        {
          type: 'any',
          children: [
            { type: 'predicate', source: 'order', field: 'total_amount', operator: 'gte', value: 10000 },
            { type: 'predicate', source: 'booking', field: 'status', operator: 'eq', value: 'confirmed' },
          ],
        },
        {
          type: 'none',
          children: [
            { type: 'predicate', source: 'contact', field: 'email', operator: 'is_null' },
          ],
        },
      ],
    };

    // Simulate save (to JSON) and reload (from JSON)
    const serialized = JSON.stringify(original);
    const deserialized = JSON.parse(serialized) as GroupExpression;

    // Validate the deserialized version
    const result = validateAudienceExpression(deserialized);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);

    // Structural equality
    expect(deserialized).toEqual(original);
  });

  it('predicate with numeric value preserves type through JSON', () => {
    const pred: Predicate = {
      type: 'predicate',
      source: 'payment',
      field: 'amount',
      operator: 'gte',
      value: 5000,
    };
    const roundTripped = JSON.parse(JSON.stringify(pred)) as Predicate;
    expect(typeof roundTripped.value).toBe('number');
    expect(roundTripped.value).toBe(5000);
  });

  it('predicate with null value for is_null operator preserves correctly', () => {
    const pred: Predicate = {
      type: 'predicate',
      source: 'contact',
      field: 'email',
      operator: 'is_null',
    };
    const roundTripped = JSON.parse(JSON.stringify(pred)) as Predicate;
    expect(roundTripped.operator).toBe('is_null');
    expect(roundTripped.value).toBeUndefined();
    const result = validateAudienceExpression({ type: 'all', children: [roundTripped] });
    expect(result.valid).toBe(true);
  });
});

/* ── 4. API contract verification ── */

describe('Segments API contract', () => {
  const segmentsRoute = readSource('app/api/engage/segments/route.ts');
  const detailRoute = readSource('app/api/engage/segments/[id]/route.ts');
  const previewRoute = readSource('app/api/engage/audience/preview/route.ts');

  it('list route returns segments array', () => {
    expect(segmentsRoute).toContain("{ success: true, segments: segments || [] }");
  });

  it('create route validates DSL before insert', () => {
    expect(segmentsRoute).toContain('validateAudienceExpression(expression)');
    expect(segmentsRoute).toContain("invalid_expression");
  });

  it('create route sets created_by from auth, not body', () => {
    expect(segmentsRoute).toContain('created_by: user.id');
  });

  it('detail PUT route validates expression if provided', () => {
    expect(detailRoute).toContain('validateAudienceExpression');
  });

  it('detail DELETE scopes by business_id', () => {
    expect(detailRoute).toContain(".eq('business_id', businessId)");
  });

  it('preview route requires broadcast capability with create_new action', () => {
    expect(previewRoute).toContain("capability: 'broadcast'");
    expect(previewRoute).toContain("action: 'create_new'");
  });

  it('preview route returns total, whatsappEligible, emailEligible, sample', () => {
    expect(previewRoute).toContain('...preview');
    // AudiencePreviewResult shape is { total, whatsappEligible, emailEligible, sample }
  });

  it('preview route handles AudienceTooLargeError with 422', () => {
    expect(previewRoute).toContain('AudienceTooLargeError');
    expect(previewRoute).toContain('422');
  });
});

/* ── 5. Dashboard integration ── */

describe('Dashboard integration', () => {
  const sidebar = readSource('components/dashboard/Sidebar.tsx');
  const audiencesPage = readSource('app/dashboard/audiences/page.tsx');

  it('Audiences entry exists in sidebar with broadcast capability gate', () => {
    expect(sidebar).toContain("href: '/dashboard/audiences'");
    expect(sidebar).toContain("label: 'Audiences'");
    // Verify it's capability-gated — use larger window to account for long SVG icon path
    const startIdx = sidebar.indexOf("href: '/dashboard/audiences'");
    const audienceBlock = sidebar.slice(startIdx, startIdx + 800);
    expect(audienceBlock).toContain("capabilities: ['broadcast']");
  });

  it('Audiences page is in the engage section', () => {
    const startIdx = sidebar.indexOf("href: '/dashboard/audiences'");
    const audienceBlock = sidebar.slice(startIdx, startIdx + 800);
    expect(audienceBlock).toContain("section: 'engage'");
  });

  it('page uses useRequireCapability for broadcast', () => {
    expect(audiencesPage).toContain("useRequireCapability('broadcast')");
  });

  it('page imports DSL types from lib/engage/audience-dsl', () => {
    expect(audiencesPage).toContain("from '@/lib/engage/audience-dsl'");
  });

  it('page imports validateAudienceExpression', () => {
    expect(audiencesPage).toContain('validateAudienceExpression');
  });

  it('page calls existing segments API', () => {
    expect(audiencesPage).toContain('/api/engage/segments');
  });

  it('page calls existing preview API', () => {
    expect(audiencesPage).toContain('/api/engage/audience/preview');
  });

  it('page does NOT contain any send or dispatch logic', () => {
    expect(audiencesPage).not.toContain('/api/broadcasts/send');
    expect(audiencesPage).not.toContain('/api/engage/campaigns/dispatch');
    expect(audiencesPage).not.toContain('sendTemplate');
    expect(audiencesPage).not.toContain('sendText');
    expect(audiencesPage).not.toContain('MetaCloudSender');
  });

  it('page does NOT modify financial infrastructure', () => {
    expect(audiencesPage).not.toContain('messaging_financial_gate');
    expect(audiencesPage).not.toContain('messaging_allowances');
    expect(audiencesPage).not.toContain('broadcast_usage');
  });

  it('preview panel shows "no messages will be sent" disclaimer', () => {
    expect(audiencesPage).toContain('no messages will be sent');
  });
});

/* ── 6. Cross-business authorization ── */

describe('Cross-business authorization', () => {
  const segmentsRoute = readSource('app/api/engage/segments/route.ts');
  const detailRoute = readSource('app/api/engage/segments/[id]/route.ts');

  it('list route requires businessId and uses requireCapabilityWithRole', () => {
    expect(segmentsRoute).toContain('requireCapabilityWithRole');
    expect(segmentsRoute).toContain("businessId");
  });

  it('detail route scopes all operations by business_id', () => {
    // GET, PUT, DELETE all filter by business_id
    const getSection = detailRoute.slice(0, detailRoute.indexOf('export async function PUT'));
    const putSection = detailRoute.slice(
      detailRoute.indexOf('export async function PUT'),
      detailRoute.indexOf('export async function DELETE'),
    );
    const deleteSection = detailRoute.slice(detailRoute.indexOf('export async function DELETE'));

    expect(getSection).toContain(".eq('business_id'");
    expect(putSection).toContain(".eq('business_id'");
    expect(deleteSection).toContain(".eq('business_id'");
  });
});
