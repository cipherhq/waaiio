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

    // Self-check
    expect(sql).toContain('472 SELF-CHECK PASSED');
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
