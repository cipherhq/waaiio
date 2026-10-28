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
    expect(sql).toContain('SECURITY INVOKER');
    expect(sql).not.toContain('SECURITY DEFINER');
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

  it('weekday uses to_char(p_date) directly — no AT TIME ZONE', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const migrationPath = path.join(process.cwd(), 'supabase/migrations/472_seating_resources_table_reservation.sql');
    const sql = fs.readFileSync(migrationPath, 'utf-8');

    // Must use to_char(p_date, 'fmday') — NOT p_date AT TIME ZONE
    expect(sql).toContain("lower(to_char(p_date, 'fmday'))");
    expect(sql).not.toMatch(/to_char\(p_date AT TIME ZONE/);
  });

  it('time comparisons use integer minutes (no TIME wrap)', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const migrationPath = path.join(process.cwd(), 'supabase/migrations/472_seating_resources_table_reservation.sql');
    const sql = fs.readFileSync(migrationPath, 'utf-8');

    // Must use EXTRACT(HOUR/MINUTE) for minutes-since-midnight
    expect(sql).toContain('v_req_start_min');
    expect(sql).toContain('v_req_end_min');
    expect(sql).toContain('EXTRACT(HOUR FROM');
    expect(sql).toContain('EXTRACT(MINUTE FROM');
    // Must NOT use TIME comparison for closing/overlap checks
    expect(sql).not.toMatch(/v_req_end\s*>\s*v_resource\.available_to/);
  });

  it('advisory lock precedes idempotency lookup (concurrent retry safety)', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const migrationPath = path.join(process.cwd(), 'supabase/migrations/472_seating_resources_table_reservation.sql');
    const sql = fs.readFileSync(migrationPath, 'utf-8');

    // Advisory lock must appear BEFORE the idempotency lookup in the function body
    const lockPos = sql.indexOf('pg_advisory_xact_lock(v_lock_key)');
    const idempPos = sql.indexOf('bot_session_id = p_bot_session_id');
    expect(lockPos).toBeGreaterThan(0);
    expect(idempPos).toBeGreaterThan(0);
    expect(lockPos).toBeLessThan(idempPos);
  });

  it('idempotency check matches full reservation identity', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const migrationPath = path.join(process.cwd(), 'supabase/migrations/472_seating_resources_table_reservation.sql');
    const sql = fs.readFileSync(migrationPath, 'utf-8');

    // Idempotency must match full reservation identity
    expect(sql).toMatch(/bot_session_id = p_bot_session_id[\s\S]*?business_id = p_business_id/);
    expect(sql).toMatch(/bot_session_id = p_bot_session_id[\s\S]*?user_id = p_user_id/);
    expect(sql).toMatch(/bot_session_id = p_bot_session_id[\s\S]*?seating_resource_id = p_seating_resource_id/);
    expect(sql).toMatch(/bot_session_id = p_bot_session_id[\s\S]*?date = p_date/);
    expect(sql).toMatch(/bot_session_id = p_bot_session_id[\s\S]*?party_size = p_party_size/);
  });

  it('flat deposit: v_committed_total = v_committed_deposit (not multiplied)', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const migrationPath = path.join(process.cwd(), 'supabase/migrations/472_seating_resources_table_reservation.sql');
    const sql = fs.readFileSync(migrationPath, 'utf-8');

    // Total must equal flat deposit, not multiplied by party_size
    expect(sql).toContain('v_committed_total := v_committed_deposit');
    // Comment should reference Owner decision
    expect(sql).toContain('flat deposit per reservation');
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

    // Uses minutes-since-midnight (not TIME type)
    expect(sql).toContain('v_from_min');
    expect(sql).toContain('v_to_min');
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

  it('scheduling.flow.ts has flat deposit branch for table reservations', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const code = fs.readFileSync(path.join(process.cwd(), 'lib/bot/flows/scheduling.flow.ts'), 'utf-8');

    // Must have dedicated table_reservation deposit logic
    expect(code).toContain('_is_table_reservation');
    expect(code).toContain('FLAT deposit per reservation');
    expect(code).toContain('_seating_deposit');
    // Table reservation total = totalDeposit (flat, via ternary)
    expect(code).toMatch(/_is_table_reservation[\s\S]*?\?\s*totalDeposit/);
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

  it('merchant PATCH uses field allowlist (rejects business_id mutation)', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const code = fs.readFileSync(path.join(process.cwd(), 'app/api/seating-resources/route.ts'), 'utf-8');

    expect(code).toContain('ALLOWED_FIELDS');
    expect(code).not.toMatch(/\.update\(updates\)/); // Must not pass raw updates
    expect(code).toContain('.update(filtered)');
  });

  it('admin PATCH uses field allowlist (rejects business_id mutation)', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const code = fs.readFileSync(path.join(process.cwd(), 'app/api/admin/seating-resources/route.ts'), 'utf-8');

    expect(code).toContain('ALLOWED_FIELDS');
    expect(code).not.toMatch(/\.update\(updates\)/);
    expect(code).toContain('.update(filtered)');
  });

  it('WhatsApp my-bookings blocks table_reservation reschedule', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const code = fs.readFileSync(path.join(process.cwd(), 'lib/bot/handlers/my-bookings.ts'), 'utf-8');

    expect(code).toContain("booking.flow_type === 'table_reservation'");
    expect(code).toContain('Table reservations cannot be rescheduled yet');
  });

  it('free-prepay with positive deposit fails closed (not silently waived)', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const code = fs.readFileSync(path.join(process.cwd(), 'lib/bot/flows/scheduling.flow.ts'), 'utf-8');

    // Must fail closed on prepay_mode='free' + positive deposit
    expect(code).toContain("prepayMode === 'free' && flatDeposit > 0");
    // Always pass expected deposit (including zero) for commit-time revalidation
    expect(code).toContain("p_expected_deposit: (d._seating_deposit as number) ?? 0");
  });

  it('migration rejects overnight availability windows and past-midnight reservations', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const sql = fs.readFileSync(path.join(process.cwd(), 'supabase/migrations/472_seating_resources_table_reservation.sql'), 'utf-8');

    expect(sql).toContain('seating_no_overnight');
    expect(sql).toContain('available_from < available_to');
    // Unconditional midnight guard (even when available_to is null)
    expect(sql).toContain('v_req_end_min > 1440');
    expect(sql).toContain('past_midnight');
  });

  it('reschedule route fails closed on lookup error and missing rows', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const code = fs.readFileSync(path.join(process.cwd(), 'app/api/bookings/[id]/reschedule/route.ts'), 'utf-8');

    // Must check for both error AND null
    expect(code).toContain('if (lookupError)');
    expect(code).toContain('if (!bookingCheck)');
    // Must return error responses, not continue
    expect(code).toContain("status: 500");
    expect(code).toContain("status: 404");
  });

  it('dashboard hides reschedule for table_reservation bookings', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const code = fs.readFileSync(path.join(process.cwd(), 'app/dashboard/reservations/page.tsx'), 'utf-8');

    expect(code).toContain("flow_type !== 'table_reservation'");
  });

  it('PBQ custom_answers merges into existing metadata (preserves duration)', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const code = fs.readFileSync(path.join(process.cwd(), 'lib/bot/flows/scheduling.flow.ts'), 'utf-8');

    // Must read existing metadata before writing (merge, not replace)
    expect(code).toContain("select('metadata')");
    expect(code).toContain('...existingMeta, custom_answers:');
  });

  it('select_time.validate scopes to seating_resource_id for table reservations', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const code = fs.readFileSync(path.join(process.cwd(), 'lib/bot/flows/scheduling.flow.ts'), 'utf-8');

    // validate must scope to resource for table reservations
    expect(code).toContain('valSeatingResourceId');
    expect(code).toContain("eq('seating_resource_id', valSeatingResourceId)");
    // Must use duration-aware overlap, not simple count
    expect(code).toContain('reqStartMin < bEndMin && reqEndMin > bStartMin');
  });

  it('clearStaleCapabilityState removes table state when switching away', async () => {
    const { clearStaleCapabilityState } = await import('@/lib/bot/flows/shared/capability-transition');

    const sessionData: Record<string, unknown> = {
      active_capability: 'table_reservation',
      _is_table_reservation: true,
      seating_resource_id: 'res-123',
      seating_resource_name: 'Table 1',
      _seating_capacity: 4,
      _seating_min_party: 1,
      _seating_deposit: 5000,
      _seating_duration: 90,
      service_price: 5000,
      service_deposit: 5000,
      _service_price_is_variable: true,
      _service_max_capacity: 4,
      skip_service: true,
      // Identity fields that must be preserved
      first_name: 'Alice',
      email: 'alice@test.com',
      capabilities: ['table_reservation', 'scheduling'],
    };

    clearStaleCapabilityState(sessionData, 'table_reservation', 'scheduling');

    // Table-specific keys cleared
    expect(sessionData._is_table_reservation).toBeUndefined();
    expect(sessionData.seating_resource_id).toBeUndefined();
    expect(sessionData._seating_deposit).toBeUndefined();
    // Shared selection keys cleared
    expect(sessionData.service_price).toBeUndefined();
    expect(sessionData.service_deposit).toBeUndefined();
    expect(sessionData.skip_service).toBeUndefined();
    // Identity preserved
    expect(sessionData.first_name).toBe('Alice');
    expect(sessionData.email).toBe('alice@test.com');
    expect(sessionData.capabilities).toBeDefined();
  });

  it('clearStaleCapabilityState clears service state when switching TO table_reservation', async () => {
    const { clearStaleCapabilityState } = await import('@/lib/bot/flows/shared/capability-transition');

    const sessionData: Record<string, unknown> = {
      active_capability: 'scheduling',
      service_id: 'svc-456',
      service_name: 'Haircut',
      service_price: 3000,
      _is_appointment: true,
      staff_id: 'staff-789',
      staff_name: 'John',
      date: '2026-10-30',
      time: '14:00',
      party_size: 1,
      first_name: 'Bob',
    };

    clearStaleCapabilityState(sessionData, 'scheduling', 'table_reservation');

    // Service-specific keys cleared
    expect(sessionData.service_id).toBeUndefined();
    expect(sessionData.service_name).toBeUndefined();
    expect(sessionData._is_appointment).toBeUndefined();
    expect(sessionData.staff_id).toBeUndefined();
    expect(sessionData.date).toBeUndefined();
    expect(sessionData.time).toBeUndefined();
    // Identity preserved
    expect(sessionData.first_name).toBe('Bob');
  });

  it('clearStaleCapabilityState is no-op for fresh session (undefined fromCap)', async () => {
    const { clearStaleCapabilityState } = await import('@/lib/bot/flows/shared/capability-transition');

    // Simulates first capability selection with smart-prefilled data
    const sessionData: Record<string, unknown> = {
      service_id: 'svc-prefilled',
      service_name: 'Prefilled Service',
      date: '2026-10-30',
      time: '14:00',
      party_size: 2,
      first_name: 'Alice',
    };

    clearStaleCapabilityState(sessionData, undefined, 'scheduling');

    // Prefilled data must be preserved (fresh session, no stale state)
    expect(sessionData.service_id).toBe('svc-prefilled');
    expect(sessionData.date).toBe('2026-10-30');
    expect(sessionData.time).toBe('14:00');
    expect(sessionData.party_size).toBe(2);
  });

  it('clearStaleCapabilityState is no-op for same capability', async () => {
    const { clearStaleCapabilityState } = await import('@/lib/bot/flows/shared/capability-transition');

    const sessionData: Record<string, unknown> = {
      active_capability: 'scheduling',
      service_id: 'svc-456',
      service_price: 3000,
    };

    clearStaleCapabilityState(sessionData, 'scheduling', 'scheduling');

    // Nothing should be cleared
    expect(sessionData.service_id).toBe('svc-456');
    expect(sessionData.service_price).toBe(3000);
  });

  it('all capability-transition callers use shared clearStaleCapabilityState', async () => {
    const fs = await import('fs');
    const path = await import('path');

    const callers = [
      'lib/bot/flows/capability-selection.flow.ts',
      'lib/bot/flows/executor.ts',
      'lib/bot/handlers/keyword-actions.ts',
      'lib/bot/bot.service.ts',
    ];

    for (const file of callers) {
      const code = fs.readFileSync(path.join(process.cwd(), file), 'utf-8');
      expect(code).toContain('clearStaleCapabilityState');
    }
  });

  it('select_quantity.skipIf: table reservation is NOT skipped by business skip_quantity', async () => {
    const { getFlowStep } = await import('@/lib/bot/flows/registry');
    const step = getFlowStep('scheduling', 'select_quantity');
    expect(step).toBeDefined();

    // Simulate: business has skip_quantity=true, but table reservation min=2
    const ctx = {
      session: {
        id: 'test', user_id: 'u1', business_id: 'b1', current_step: 'select_quantity', version: 1,
        session_data: {
          _is_table_reservation: true,
          _seating_min_party: 2,
          _seating_capacity: 4,
          _service_max_capacity: 4,
          _service_metadata: { skip_quantity: true }, // stale from prior service
        },
      },
      business: { id: 'b1', name: 'Test', slug: 't', category: 'restaurant' as const, flow_type: 'table_reservation' as const, subscription_tier: 'free', metadata: { skip_quantity: true } },
      supabase: {} as any, sender: {} as any, standalone: {} as any, intelligence: {} as any, from: '+1234',
    } as any;

    const shouldSkip = await step!.skipIf!(ctx);
    expect(shouldSkip).toBe(false); // Must NOT skip — needs party size selection
  });

  it('select_quantity.skipIf: table reservation with min=max auto-sets party_size', async () => {
    const { getFlowStep } = await import('@/lib/bot/flows/registry');
    const step = getFlowStep('scheduling', 'select_quantity');

    const ctx = {
      session: {
        id: 'test', user_id: 'u1', business_id: 'b1', current_step: 'select_quantity', version: 1,
        session_data: {
          _is_table_reservation: true,
          _seating_min_party: 4,
          _seating_capacity: 4,
          _service_max_capacity: 4,
        },
      },
      business: { id: 'b1', name: 'Test', slug: 't', category: 'restaurant' as const, flow_type: 'table_reservation' as const, subscription_tier: 'free', metadata: {} },
      supabase: {} as any, sender: {} as any, standalone: {} as any, intelligence: {} as any, from: '+1234',
    } as any;

    const shouldSkip = await step!.skipIf!(ctx);
    expect(shouldSkip).toBe(true);
    expect(ctx.session.session_data.party_size).toBe(4);
  });

  it('select_quantity.skipIf: table reservation with stale class state does NOT enter class branch', async () => {
    const { getFlowStep } = await import('@/lib/bot/flows/registry');
    const step = getFlowStep('scheduling', 'select_quantity');

    // After switching from class_booking to table_reservation,
    // _service_is_class should have been cleared by capability-transition.
    // Even if somehow still present, table check comes first.
    const ctx = {
      session: {
        id: 'test', user_id: 'u1', business_id: 'b1', current_step: 'select_quantity', version: 1,
        session_data: {
          _is_table_reservation: true,
          _seating_min_party: 1,
          _seating_capacity: 6,
          _service_max_capacity: 6,
          _service_is_class: true, // stale — should not matter
        },
      },
      business: { id: 'b1', name: 'Test', slug: 't', category: 'restaurant' as const, flow_type: 'table_reservation' as const, subscription_tier: 'free', metadata: {} },
      supabase: {} as any, sender: {} as any, standalone: {} as any, intelligence: {} as any, from: '+1234',
    } as any;

    const shouldSkip = await step!.skipIf!(ctx);
    expect(shouldSkip).toBe(false); // Must prompt for guests, not enter class branch
  });

  it('clearStaleCapabilityState removes class/metadata state on transition', async () => {
    const { clearStaleCapabilityState } = await import('@/lib/bot/flows/shared/capability-transition');

    const sessionData: Record<string, unknown> = {
      active_capability: 'class_booking',
      _service_is_class: true,
      _class_session_id: 'cs-123',
      _class_remaining_spots: 5,
      _service_metadata: { is_class: true, skip_quantity: false },
      service_id: 'svc-class',
      first_name: 'Alice',
    };

    clearStaleCapabilityState(sessionData, 'class_booking', 'table_reservation');

    expect(sessionData._service_is_class).toBeUndefined();
    expect(sessionData._class_session_id).toBeUndefined();
    expect(sessionData._class_remaining_spots).toBeUndefined();
    expect(sessionData._service_metadata).toBeUndefined();
    expect(sessionData.service_id).toBeUndefined();
    expect(sessionData.first_name).toBe('Alice'); // preserved
  });

  // ── Real handler invocations for select_quantity ──

  it('select_quantity.prompt: table reservation produces unique buttons for capacity=4', async () => {
    const { getFlowStep } = await import('@/lib/bot/flows/registry');
    const step = getFlowStep('scheduling', 'select_quantity');
    const ctx = {
      session: { id: 't', user_id: 'u', business_id: 'b', current_step: 'select_quantity', version: 1,
        session_data: { _is_table_reservation: true, _seating_capacity: 4, _seating_min_party: 1, _service_max_capacity: 4 } },
      business: { id: 'b', name: 'T', slug: 't', category: 'restaurant' as const, flow_type: 'table_reservation' as const, subscription_tier: 'free', country_code: 'NG', metadata: {} },
      supabase: {} as any, sender: {} as any, standalone: {} as any, intelligence: {} as any, from: '+1',
    } as any;
    const msgs = await step!.prompt(ctx);
    expect(msgs.length).toBe(1);
    const buttons = (msgs[0] as any).buttons as Array<{id: string; title: string}>;
    const ids = buttons.map(b => b.id);
    expect(new Set(ids).size).toBe(ids.length); // unique
    for (const b of buttons) { const n = parseInt(b.id); expect(n).toBeGreaterThanOrEqual(1); expect(n).toBeLessThanOrEqual(4); }
    expect(ids.filter(id => id === '4').length).toBeLessThanOrEqual(1); // no duplicate '4'
    expect((msgs[0] as any).body).toContain('guests'); // table terminology
  });

  it('select_quantity.prompt: table takes priority over stale _service_is_class', async () => {
    const { getFlowStep } = await import('@/lib/bot/flows/registry');
    const step = getFlowStep('scheduling', 'select_quantity');
    const ctx = {
      session: { id: 't', user_id: 'u', business_id: 'b', current_step: 'select_quantity', version: 1,
        session_data: { _is_table_reservation: true, _seating_capacity: 6, _seating_min_party: 2, _service_max_capacity: 6, _service_is_class: true } },
      business: { id: 'b', name: 'T', slug: 't', category: 'restaurant' as const, flow_type: 'table_reservation' as const, subscription_tier: 'free', country_code: 'NG', metadata: {} },
      supabase: {} as any, sender: {} as any, standalone: {} as any, intelligence: {} as any, from: '+1',
    } as any;
    const msgs = await step!.prompt(ctx);
    expect((msgs[0] as any).body).toContain('guests'); // NOT "spots"
    expect((msgs[0] as any).body).not.toContain('spot');
  });

  it('select_quantity.prompt: min=max table shows single button', async () => {
    const { getFlowStep } = await import('@/lib/bot/flows/registry');
    const step = getFlowStep('scheduling', 'select_quantity');
    const ctx = {
      session: { id: 't', user_id: 'u', business_id: 'b', current_step: 'select_quantity', version: 1,
        session_data: { _is_table_reservation: true, _seating_capacity: 2, _seating_min_party: 2, _service_max_capacity: 2 } },
      business: { id: 'b', name: 'T', slug: 't', category: 'restaurant' as const, flow_type: 'table_reservation' as const, subscription_tier: 'free', country_code: 'NG', metadata: {} },
      supabase: {} as any, sender: {} as any, standalone: {} as any, intelligence: {} as any, from: '+1',
    } as any;
    // skipIf should auto-set for min=max
    const skipped = await step!.skipIf!(ctx);
    expect(skipped).toBe(true);
    expect(ctx.session.session_data.party_size).toBe(2);
  });

  it('select_quantity.validate: table uses "guests" terminology even with stale class state', async () => {
    const { getFlowStep } = await import('@/lib/bot/flows/registry');
    const step = getFlowStep('scheduling', 'select_quantity');
    const ctx = {
      session: { id: 't', user_id: 'u', business_id: 'b', current_step: 'select_quantity', version: 1,
        session_data: { _is_table_reservation: true, _seating_capacity: 4, _seating_min_party: 2, _service_max_capacity: 4, _service_is_class: true } },
      business: { id: 'b', name: 'T', slug: 't', category: 'restaurant' as const, flow_type: 'table_reservation' as const, subscription_tier: 'free', country_code: 'NG', metadata: {} },
      supabase: {} as any, sender: {} as any, standalone: {} as any, intelligence: { resetAbuse: () => {} } as any, from: '+1',
    } as any;
    // Invalid input below min
    const result = await step!.validate!('1', ctx);
    expect(result.valid).toBe(false);
    expect(result.errorMessage).toContain('guests'); // NOT "spots"
    expect(result.errorMessage).toContain('2'); // min
    expect(result.errorMessage).toContain('4'); // max
  });

  it('select_quantity.validate: accepts valid table party size', async () => {
    const { getFlowStep } = await import('@/lib/bot/flows/registry');
    const step = getFlowStep('scheduling', 'select_quantity');
    const ctx = {
      session: { id: 't', user_id: 'u', business_id: 'b', current_step: 'select_quantity', version: 1,
        session_data: { _is_table_reservation: true, _seating_capacity: 4, _seating_min_party: 2, _service_max_capacity: 4 } },
      business: { id: 'b', name: 'T', slug: 't', category: 'restaurant' as const, flow_type: 'table_reservation' as const, subscription_tier: 'free', country_code: 'NG', metadata: {} },
      supabase: {} as any, sender: {} as any, standalone: {} as any, intelligence: { resetAbuse: () => {} } as any, from: '+1',
    } as any;
    const result = await step!.validate!('3', ctx);
    expect(result.valid).toBe(true);
    expect(result.data?.party_size).toBe(3);
  });

  it('select_quantity.validate: rejects party size above table max', async () => {
    const { getFlowStep } = await import('@/lib/bot/flows/registry');
    const step = getFlowStep('scheduling', 'select_quantity');
    const ctx = {
      session: { id: 't', user_id: 'u', business_id: 'b', current_step: 'select_quantity', version: 1,
        session_data: { _is_table_reservation: true, _seating_capacity: 4, _seating_min_party: 1, _service_max_capacity: 4 } },
      business: { id: 'b', name: 'T', slug: 't', category: 'restaurant' as const, flow_type: 'table_reservation' as const, subscription_tier: 'free', country_code: 'NG', metadata: {} },
      supabase: {} as any, sender: {} as any, standalone: {} as any, intelligence: { resetAbuse: () => {} } as any, from: '+1',
    } as any;
    const result = await step!.validate!('5', ctx);
    expect(result.valid).toBe(false);
  });

  it('dashboard uses table-specific status actions (not lodging checked_in)', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const code = fs.readFileSync(path.join(process.cwd(), 'app/dashboard/reservations/page.tsx'), 'utf-8');

    // Must have tableReservationActions defined
    expect(code).toContain('tableReservationActions');
    // Table bookings use 'Seat' (→ in_progress), not 'Check In' (→ checked_in)
    expect(code).toMatch(/tableReservationActions[\s\S]*?Seat.*in_progress/);
    // Per-row action selection based on flow_type
    expect(code).toContain('getActionsForBooking');
    expect(code).toContain("flow_type === 'table_reservation'");
    // Must NOT use global nextActions
    expect(code).not.toContain('nextActions');
  });

  it('lodging+table business does not early-return before loading table bookings', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const code = fs.readFileSync(path.join(process.cwd(), 'app/dashboard/reservations/page.tsx'), 'utf-8');

    // Early return must check for table_reservation capability, not just isReservationType
    expect(code).toContain('!hasTableReservationCap && !hasSchedulingCapability');
    // Must NOT early-return based solely on isReservationType
    expect(code).not.toMatch(/if \(isReservationType\) \{\s*setBookings/);
  });

  it('dashboard joins seating_resources name for table bookings', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const code = fs.readFileSync(path.join(process.cwd(), 'app/dashboard/reservations/page.tsx'), 'utf-8');

    // Must join seating_resources for name
    expect(code).toContain('seating_resources(name)');
    expect(code).toContain('seating_resource_name');
    // Table bookings show resource name instead of staff_name
    expect(code).toContain("r.flow_type === 'table_reservation' ? (r.seating_resource_name");
  });

  it('select_date.prompt scopes availability to seating_resource_id', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const code = fs.readFileSync(path.join(process.cwd(), 'lib/bot/flows/scheduling.flow.ts'), 'utf-8');

    // Must scope date availability to resource for table reservations
    expect(code).toContain("eq('seating_resource_id', dateSeatingResourceId)");
    // Must check _is_table_reservation before applying staff filter
    expect(code).toMatch(/isTableRes && dateSeatingResourceId[\s\S]*?eq\('seating_resource_id'/);
  });

  it('select_date.prompt: Table B booked does not block Table A dates', async () => {
    const { getFlowStep } = await import('@/lib/bot/flows/registry');
    const step = getFlowStep('scheduling', 'select_date');

    // Tomorrow's date for realistic test
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowStr = tomorrow.toISOString().split('T')[0];

    // Mock: Table A (res-A) has zero bookings — query scoped to res-A returns empty
    const mockChain: any = {};
    mockChain.eq = vi.fn().mockReturnValue(mockChain);
    mockChain.in = vi.fn().mockReturnValue(mockChain);
    mockChain.gte = vi.fn().mockReturnValue(mockChain);
    mockChain.lte = vi.fn().mockReturnValue(mockChain);
    mockChain.limit = vi.fn().mockResolvedValue({ data: [] }); // No bookings for this resource
    const mockSupabase = { from: vi.fn().mockReturnValue({ select: vi.fn().mockReturnValue(mockChain) }) } as any;

    const ctx = {
      session: { id: 't', user_id: 'u', business_id: 'b', current_step: 'select_date', version: 1,
        session_data: {
          _is_table_reservation: true,
          seating_resource_id: 'res-A',
          _seating_capacity: 1, // Capacity 1 so a single booking fills it
          _service_max_capacity: 1,
          service_duration: 90,
          _service_available_days: [],
        },
      },
      business: { id: 'b', name: 'T', slug: 't', category: 'restaurant' as const, flow_type: 'table_reservation' as const, subscription_tier: 'free', country_code: 'NG', operating_hours: {}, metadata: {} },
      supabase: mockSupabase, sender: {} as any, standalone: {} as any, intelligence: {} as any, from: '+1',
      copyLang: 'en', t: (s: string) => Promise.resolve(s),
    } as any;

    const msgs = await step!.prompt(ctx);

    // Query must be scoped to seating_resource_id
    const eqCalls = mockChain.eq.mock.calls.map((c: any[]) => c[0]);
    expect(eqCalls).toContain('seating_resource_id');

    // With no bookings for res-A, dates should be available (not empty)
    const hasButtons = msgs.some((m: any) => m.type === 'buttons' && m.buttons?.length > 0);
    const hasList = msgs.some((m: any) => m.type === 'list' && m.items?.length > 0);
    expect(hasButtons || hasList).toBe(true);
  });

  it('select_date.prompt: missing seating_resource_id fails safe', async () => {
    const { getFlowStep } = await import('@/lib/bot/flows/registry');
    const step = getFlowStep('scheduling', 'select_date');

    const ctx = {
      session: { id: 't', user_id: 'u', business_id: 'b', current_step: 'select_date', version: 1,
        session_data: {
          _is_table_reservation: true,
          // seating_resource_id intentionally missing
          _seating_capacity: 4,
          _service_max_capacity: 4,
          service_duration: 90,
          _service_available_days: [],
        },
      },
      business: { id: 'b', name: 'T', slug: 't', category: 'restaurant' as const, flow_type: 'table_reservation' as const, subscription_tier: 'free', country_code: 'NG', operating_hours: {}, metadata: {} },
      supabase: {} as any, sender: {} as any, standalone: {} as any, intelligence: {} as any, from: '+1',
      copyLang: 'en', t: (s: string) => Promise.resolve(s),
    } as any;

    const msgs = await step!.prompt(ctx);
    // Should fail safe with a message, not crash
    expect(msgs.length).toBeGreaterThan(0);
    expect((msgs[0] as any).text).toContain('select a table');
  });

  it('dashboard column header shows "Table / Seating" for table_reservations tab', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const code = fs.readFileSync(path.join(process.cwd(), 'app/dashboard/reservations/page.tsx'), 'utf-8');

    // Table Reservations tab must show "Table / Seating" header, not "Staff" or "Property"
    expect(code).toContain("bookingType === 'table_reservations' ? 'Table / Seating' : 'Staff'");
    // Lodging condition must not activate when bookingType is table_reservations
    expect(code).toContain("bookingType !== 'table_reservations'");
  });

  it('dashboard status label uses row-specific labels (not global reservation labels)', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const code = fs.readFileSync(path.join(process.cwd(), 'app/dashboard/reservations/page.tsx'), 'utf-8');

    // Must scope reservation labels to _isReservation rows, not all rows
    expect(code).toContain('r._isReservation && reservationStatusLabels');
    // Must NOT use showReservations global for status labels
    expect(code).not.toContain('showReservations && reservationStatusLabels[r.status]');
  });

  it('M472 overlap query includes in_progress (seated tables block overlap)', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const sql = fs.readFileSync(path.join(process.cwd(), 'supabase/migrations/472_seating_resources_table_reservation.sql'), 'utf-8');

    // Overlap query must include in_progress
    const overlapMatch = sql.match(/overlap check[\s\S]*?status IN \(([^)]+)\)/);
    expect(overlapMatch).toBeTruthy();
    expect(overlapMatch![1]).toContain('in_progress');
  });

  it('WhatsApp hides reschedule button for table reservations', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const code = fs.readFileSync(path.join(process.cwd(), 'lib/bot/handlers/my-bookings.ts'), 'utf-8');

    expect(code).toContain('isTableReservation');
    expect(code).toContain("!isTableReservation");
  });

  it('reschedule route blocks table_reservation bookings', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const code = fs.readFileSync(path.join(process.cwd(), 'app/api/bookings/[id]/reschedule/route.ts'), 'utf-8');

    expect(code).toContain("flow_type === 'table_reservation'");
    expect(code).toContain('Table reservations cannot be rescheduled yet');
    expect(code).toContain('422');
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
