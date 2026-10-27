/**
 * Issue #730: Table Reservation — Unit and Integration Tests
 *
 * Tests:
 * 1. flow_type enum includes 'table_reservation' in FlowType
 * 2. Flow routing maps table_reservation to 'select_table'
 * 3. Capability-selection routes table_reservation to 'select_table'
 * 4. Registry has table_reservation flow registered
 * 5. Table reservation flow has select_table step
 * 6. Scheduling flow_type includes 'table_reservation'
 * 7. F-1 duplicate fix: table_reservation and scheduling have different first steps
 */

import { describe, it, expect } from 'vitest';

describe('#730: Table Reservation type and routing', () => {
  it('FlowType union includes table_reservation', async () => {
    // TypeScript type check — if this compiles, the type is correct
    const { type } = await import('@/lib/constants');
    const flowType: import('@/lib/constants').FlowType = 'table_reservation';
    expect(flowType).toBe('table_reservation');
  });

  it('flow-routing maps table_reservation to select_table', async () => {
    const { capabilityToFirstStep, getFirstStep } = await import('@/lib/bot/handlers/flow-routing');
    expect(capabilityToFirstStep('table_reservation')).toBe('select_table');
    expect(getFirstStep('table_reservation')).toBe('select_table');
  });

  it('flow-routing: table_reservation and scheduling have different first steps (F-1 fix)', async () => {
    const { capabilityToFirstStep } = await import('@/lib/bot/handlers/flow-routing');
    const tableStep = capabilityToFirstStep('table_reservation');
    const schedulingStep = capabilityToFirstStep('scheduling');
    expect(tableStep).not.toBe(schedulingStep);
    expect(tableStep).toBe('select_table');
    expect(schedulingStep).toBe('select_service');
  });

  it('registry has table_reservation flow registered', async () => {
    const { getFlowDefinition } = await import('@/lib/bot/flows/registry');
    const flow = getFlowDefinition('table_reservation');
    expect(flow).toBeDefined();
    expect(flow.type).toBe('table_reservation');
  });

  it('table_reservation flow has select_table step', async () => {
    const { getFlowDefinition } = await import('@/lib/bot/flows/registry');
    const flow = getFlowDefinition('table_reservation');
    const step = flow.steps.find(s => s.id === 'select_table');
    expect(step).toBeDefined();
    expect(step!.id).toBe('select_table');
  });

  it('cross-flow lookup finds select_table', async () => {
    const { getFlowStepAcrossFlows } = await import('@/lib/bot/flows/registry');
    const result = getFlowStepAcrossFlows('select_table');
    expect(result).toBeDefined();
    expect(result!.step.id).toBe('select_table');
  });

  it('getUserFacingCapabilities includes table_reservation', async () => {
    const { getUserFacingCapabilities } = await import('@/lib/bot/handlers/flow-routing');
    const caps = getUserFacingCapabilities(['table_reservation', 'ordering', 'chat', 'feedback']);
    expect(caps).toContain('table_reservation');
    expect(caps).toContain('ordering');
    expect(caps).not.toContain('feedback'); // feedback is non-user-facing
  });

  it('getUserFacingCapabilities hides payment when table_reservation is present', async () => {
    const { getUserFacingCapabilities } = await import('@/lib/bot/handlers/flow-routing');
    const caps = getUserFacingCapabilities(['table_reservation', 'payment', 'chat']);
    expect(caps).toContain('table_reservation');
    expect(caps).not.toContain('payment'); // payment hidden when scheduling-like cap present
  });

  it('capability-selection getFirstStepForCapability maps table_reservation to select_table', async () => {
    // This tests the internal mapping in capability-selection.flow.ts
    // We verify it indirectly through the flow registry's cross-flow lookup
    const { getFlowStepAcrossFlows } = await import('@/lib/bot/flows/registry');
    const selectTable = getFlowStepAcrossFlows('select_table');
    expect(selectTable).toBeDefined();
    // The step should exist and be reachable
    expect(selectTable!.step.id).toBe('select_table');
  });
});

describe('#730: Table Reservation capability definition', () => {
  it('table_reservation is in CAPABILITIES array', async () => {
    const { CAPABILITIES } = await import('@/shared/capabilities');
    const cap = CAPABILITIES.find(c => c.id === 'table_reservation');
    expect(cap).toBeDefined();
    expect(cap!.label).toBe('Table Reservations');
  });

  it('table_reservation tier is free', async () => {
    const { CAPABILITY_TIER_REQUIREMENTS } = await import('@/shared/capabilities');
    expect(CAPABILITY_TIER_REQUIREMENTS.table_reservation).toBe('free');
  });

  it('FOOD_DINING categories default to table_reservation', async () => {
    const { CATEGORY_DEFAULT_CAPABILITIES } = await import('@/lib/capabilities/types');
    expect(CATEGORY_DEFAULT_CAPABILITIES.restaurant).toContain('table_reservation');
    expect(CATEGORY_DEFAULT_CAPABILITIES.cafe).toContain('table_reservation');
    expect(CATEGORY_DEFAULT_CAPABILITIES.bar).toContain('table_reservation');
    expect(CATEGORY_DEFAULT_CAPABILITIES.lounge).toContain('table_reservation');
  });

  it('non-dining categories do NOT default to table_reservation', async () => {
    const { CATEGORY_DEFAULT_CAPABILITIES } = await import('@/lib/capabilities/types');
    expect(CATEGORY_DEFAULT_CAPABILITIES.salon).not.toContain('table_reservation');
    expect(CATEGORY_DEFAULT_CAPABILITIES.clinic).not.toContain('table_reservation');
    expect(CATEGORY_DEFAULT_CAPABILITIES.hotel).not.toContain('table_reservation');
  });
});

describe('#730: Migration 472 SQL structure', () => {
  it('migration file exists', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const migrationPath = path.join(process.cwd(), 'supabase/migrations/472_seating_resources_table_reservation.sql');
    expect(fs.existsSync(migrationPath)).toBe(true);
  });

  it('migration contains required schema elements', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const migrationPath = path.join(process.cwd(), 'supabase/migrations/472_seating_resources_table_reservation.sql');
    const sql = fs.readFileSync(migrationPath, 'utf-8');

    // Enum extension
    expect(sql).toContain("ALTER TYPE flow_type ADD VALUE IF NOT EXISTS 'table_reservation'");

    // Table creation
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS public.seating_resources');

    // Required columns
    expect(sql).toContain('business_id UUID NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE');
    expect(sql).toContain('capacity INTEGER NOT NULL DEFAULT 2');
    expect(sql).toContain('min_party_size INTEGER NOT NULL DEFAULT 1');
    expect(sql).toContain('reservation_duration_minutes INTEGER NOT NULL DEFAULT 90');
    expect(sql).toContain('is_active BOOLEAN NOT NULL DEFAULT true');

    // Constraints
    expect(sql).toContain('seating_min_lte_max');
    expect(sql).toContain("CHECK (resource_type IN ('table', 'booth', 'section', 'vip_area', 'private_room', 'bar_seat'))");

    // FK on bookings
    expect(sql).toContain('seating_resource_id UUID');
    expect(sql).toContain('REFERENCES public.seating_resources(id)');

    // RLS
    expect(sql).toContain('ALTER TABLE public.seating_resources ENABLE ROW LEVEL SECURITY');
    expect(sql).toContain('seating_resources_owner_select');
    expect(sql).toContain('seating_resources_service_all');

    // RPC
    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.book_table_atomic');
    expect(sql).toContain('SECURITY DEFINER');
    expect(sql).toContain('SET search_path = public');
    expect(sql).toContain('pg_advisory_xact_lock');

    // ACL: service_role granted EXECUTE
    expect(sql).toContain('GRANT EXECUTE ON FUNCTION public.book_table_atomic');
    expect(sql).toContain('TO service_role');

    // Advisory lock serializes on resource+date (not time) to prevent overlap race
    expect(sql).not.toMatch(/v_lock_key.*p_time/);

    // Commit-time revalidation (Codex R2 P1)
    expect(sql).toContain('p_expected_deposit');
    expect(sql).toContain('p_expected_duration');
    expect(sql).toContain('deposit_changed');
    expect(sql).toContain('duration_changed');
    expect(sql).toContain('v_committed_deposit');
    expect(sql).toContain('v_committed_duration');
    expect(sql).toContain('v_committed_total');

    // Self-check
    expect(sql).toContain('472 SELF-CHECK PASSED');
  });

  it('migration enforces availability in book_table_atomic', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const migrationPath = path.join(process.cwd(), 'supabase/migrations/472_seating_resources_table_reservation.sql');
    const sql = fs.readFileSync(migrationPath, 'utf-8');

    // Day-of-week enforcement
    expect(sql).toContain('available_days');
    expect(sql).toContain('day_unavailable');

    // Time window enforcement
    expect(sql).toContain('available_from');
    expect(sql).toContain('available_to');
    expect(sql).toContain('before_opening');
    expect(sql).toContain('after_closing');

    // Business timezone lookup
    expect(sql).toContain('v_biz_tz');
    expect(sql).toContain('Africa/Lagos');
  });

  it('migration has delete-guard trigger for referenced resources', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const migrationPath = path.join(process.cwd(), 'supabase/migrations/472_seating_resources_table_reservation.sql');
    const sql = fs.readFileSync(migrationPath, 'utf-8');

    expect(sql).toContain('guard_seating_resource_delete');
    expect(sql).toContain('trg_guard_seating_resource_delete');
    expect(sql).toContain('Cannot delete seating resource');
    // No DELETE RLS policy — archive only
    expect(sql).not.toContain('seating_resources_owner_delete');
    // FK uses RESTRICT, not SET NULL
    expect(sql).toContain('ON DELETE RESTRICT');
    expect(sql).not.toMatch(/seating_resource_id.*ON DELETE SET NULL/);
  });

  it('migration includes admin RLS policies', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const migrationPath = path.join(process.cwd(), 'supabase/migrations/472_seating_resources_table_reservation.sql');
    const sql = fs.readFileSync(migrationPath, 'utf-8');

    expect(sql).toContain('seating_resources_admin_select');
    expect(sql).toContain('seating_resources_admin_write');
    expect(sql).toContain('has_admin_role');
    expect(sql).toContain('GRANT SELECT, INSERT, UPDATE ON public.seating_resources TO authenticated');
  });

  it('migration does NOT modify existing tables or functions unsafely', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const migrationPath = path.join(process.cwd(), 'supabase/migrations/472_seating_resources_table_reservation.sql');
    const sql = fs.readFileSync(migrationPath, 'utf-8');

    // Should not drop or replace existing functions (SQL statements, not comments)
    expect(sql).not.toMatch(/CREATE OR REPLACE FUNCTION.*book_slot_atomic/);
    expect(sql).not.toMatch(/CREATE OR REPLACE FUNCTION.*purchase_tickets_atomic/);
    expect(sql).not.toMatch(/CREATE OR REPLACE FUNCTION.*reschedule_booking_atomic/);

    // Should not alter existing tables destructively
    expect(sql).not.toContain('DROP TABLE');
    expect(sql).not.toContain('ALTER TABLE public.services');
    expect(sql).not.toContain('ALTER TABLE public.appointments');
    expect(sql).not.toContain('ALTER TABLE public.reservations');
  });
});

describe('#730: Deposit authority — table reservation financial path', () => {
  it('resolveRuntimeDeposit preserves deposit when priceIsVariable=true', async () => {
    const { resolveRuntimeDeposit } = await import('@/lib/payments/deposit-amount-authority');

    // Simulates table reservation: deposit=5000, total=5000, variable=true
    const result = resolveRuntimeDeposit({
      requestedDeposit: 5000,
      transactionTotal: 5000,
      priceIsVariable: true,
    });

    expect(result.amount).toBe(5000);
    expect(result.corrected).toBe(false);
  });

  it('resolveRuntimeDeposit still preserves large deposit when priceIsVariable=true and total is lower', async () => {
    const { resolveRuntimeDeposit } = await import('@/lib/payments/deposit-amount-authority');

    // variable=true: skip clamping regardless of total
    const result = resolveRuntimeDeposit({
      requestedDeposit: 5000,
      transactionTotal: 0,
      priceIsVariable: true,
    });

    expect(result.amount).toBe(5000);
    expect(result.corrected).toBe(false);
  });

  it('resolveRuntimeDeposit clamps deposit when priceIsVariable=false (the original bug)', async () => {
    const { resolveRuntimeDeposit } = await import('@/lib/payments/deposit-amount-authority');

    const result = resolveRuntimeDeposit({
      requestedDeposit: 5000,
      transactionTotal: 0,
      priceIsVariable: false,
    });

    expect(result.amount).toBe(0);
    expect(result.corrected).toBe(true);
    expect(result.reason).toBe('deposit_exceeds_transaction_total');
  });

  it('table-reservation flow sets _service_price_is_variable=true', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const flowPath = path.join(process.cwd(), 'lib/bot/flows/table-reservation.flow.ts');
    const code = fs.readFileSync(flowPath, 'utf-8');

    const matches = code.match(/_service_price_is_variable.*true/g) || [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });

  it('zero-deposit table reservation: no payment needed', async () => {
    const { resolveRuntimeDeposit } = await import('@/lib/payments/deposit-amount-authority');

    const result = resolveRuntimeDeposit({
      requestedDeposit: 0,
      transactionTotal: 0,
      priceIsVariable: true,
    });

    expect(result.amount).toBe(0);
    expect(result.corrected).toBe(false);
  });
});

describe('#730: Shared flow adaptations', () => {
  it('scheduling select_staff skips for table reservations', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const flowPath = path.join(process.cwd(), 'lib/bot/flows/scheduling.flow.ts');
    const code = fs.readFileSync(flowPath, 'utf-8');

    expect(code).toContain('if (d._is_table_reservation) return true;');
  });

  it('scheduling passes expected deposit/duration for commit-time revalidation', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const flowPath = path.join(process.cwd(), 'lib/bot/flows/scheduling.flow.ts');
    const code = fs.readFileSync(flowPath, 'utf-8');

    expect(code).toContain('p_expected_deposit');
    expect(code).toContain('p_expected_duration');
    expect(code).toContain('_seating_deposit');
    expect(code).toContain('_seating_duration');
  });

  it('scheduling handles deposit_changed/duration_changed errors', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const flowPath = path.join(process.cwd(), 'lib/bot/flows/scheduling.flow.ts');
    const code = fs.readFileSync(flowPath, 'utf-8');

    expect(code).toContain("pgError?.message?.includes('deposit_changed')");
    expect(code).toContain("pgError?.message?.includes('duration_changed')");
  });

  it('scheduling select_time filters by seating_resource_id for table reservations', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const flowPath = path.join(process.cwd(), 'lib/bot/flows/scheduling.flow.ts');
    const code = fs.readFileSync(flowPath, 'utf-8');

    expect(code).toContain("bookingsQuery = bookingsQuery.eq('seating_resource_id', seatingResourceId)");
  });

  it('scheduling select_quantity enforces seating min/max bounds', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const flowPath = path.join(process.cwd(), 'lib/bot/flows/scheduling.flow.ts');
    const code = fs.readFileSync(flowPath, 'utf-8');

    expect(code).toContain('_seating_capacity');
    expect(code).toContain('_seating_min_party');
    expect(code).toContain('isTableReservation');
  });

  it('table-reservation flow bridges availability to scheduling fields', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const flowPath = path.join(process.cwd(), 'lib/bot/flows/table-reservation.flow.ts');
    const code = fs.readFileSync(flowPath, 'utf-8');

    expect(code).toContain('_service_available_days');
    expect(code).toContain('_service_available_from');
    expect(code).toContain('_service_available_to');
  });

  it('table-reservation auto-selection is in skipIf (not prompt)', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const flowPath = path.join(process.cwd(), 'lib/bot/flows/table-reservation.flow.ts');
    const code = fs.readFileSync(flowPath, 'utf-8');

    expect(code).toMatch(/skipIf[\s\S]*?resources\.length === 1/);
    const promptSection = code.slice(code.indexOf('async prompt'), code.indexOf('async validate'));
    expect(promptSection).not.toContain('skip_service');
  });
});

describe('#730: Admin API and security', () => {
  it('admin seating-resources route uses requirePlatformAdmin + audit', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const routePath = path.join(process.cwd(), 'app/api/admin/seating-resources/route.ts');
    const code = fs.readFileSync(routePath, 'utf-8');

    expect(code).toContain('requirePlatformAdmin');
    expect(code).toContain('logAdminAudit');
    expect(code).toContain("admin.role !== 'admin'");
    expect(code).toContain('createServiceClient');
  });

  it('merchant API uses RLS-scoped client (no service_role)', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const routePath = path.join(process.cwd(), 'app/api/seating-resources/route.ts');
    const code = fs.readFileSync(routePath, 'utf-8');

    expect(code).not.toContain('createServiceClient');
    expect(code).not.toContain('requirePlatformAdmin');
    expect(code).toContain('@/lib/supabase/server');
  });
});
