/**
 * Release Gate V2 — Machine-Readable Invariant Registry
 *
 * This is the executable source of truth for all release invariants.
 * Each invariant has an ID, a SQL check query (where applicable),
 * and a criticality flag. The baseline capture system runs these
 * checks and records pass/fail evidence in the baseline snapshot.
 *
 * To add a new invariant after an escaped defect:
 * 1. Add the definition here with a unique ID
 * 2. Add a corresponding entry in RELEASE_GATE_V2.md §1
 * 3. Add a test in release-gate-invariants-db.test.ts
 *
 * @see RELEASE_GATE_V2.md §1 (Invariant Registry)
 */

import type { InvariantDefinition, ProtectedObject } from './types';

// ═══════════════════════════════════════════════════════════════════
// Database / Migration Invariants
// ═══════════════════════════════════════════════════════════════════

export const INVARIANTS: InvariantDefinition[] = [
  {
    id: 'DB-001',
    description: 'SECURITY DEFINER functions calling digest() must have search_path = public, extensions',
    category: 'database',
    critical: true,
    required_for: ['release_candidate', 'post_deployment'],
    owner: '#365, M390',
    evidence_type: 'catalog_assertion',
    check_query: `
      SELECT p.proname, n.nspname, p.proconfig,
             pg_get_functiondef(p.oid) AS funcdef
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND p.prosecdef = true
        AND pg_get_functiondef(p.oid) LIKE '%digest(%'
        AND NOT ('search_path=public, extensions' = ANY(COALESCE(p.proconfig, ARRAY[]::text[])))
    `,
  },
  {
    id: 'DB-002',
    description: 'CREATE OR REPLACE must not silently remove protected attributes from critical functions',
    category: 'database',
    critical: true,
    required_for: ['release_candidate', 'post_deployment'],
    owner: '#365, M390→M394',
    evidence_type: 'catalog_assertion',
    // Checked by verifying protected objects retain required properties
  },
  {
    id: 'DB-003',
    description: 'Every table in public schema has RLS enabled',
    category: 'database',
    critical: true,
    required_for: ['release_candidate', 'post_deployment'],
    owner: 'Standing',
    evidence_type: 'catalog_assertion',
    check_query: `
      SELECT c.relname
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relkind = 'r'
        AND NOT c.relrowsecurity
        AND c.relname NOT LIKE 'pg_%'
        AND c.relname NOT LIKE '_realtime%'
        AND c.relname NOT IN ('schema_migrations', 'supabase_migrations', 'extensions')
    `,
  },
  {
    id: 'DB-004',
    description: 'Saved-card RPCs blocked for anon/authenticated/PUBLIC; only service_role may execute',
    category: 'database',
    critical: true,
    required_for: ['release_candidate', 'post_deployment'],
    owner: '#353, M396',
    evidence_type: 'catalog_assertion',
    check_query: `
      -- Check 1: anon, authenticated, and PUBLIC must NOT have EXECUTE
      SELECT r.routine_name, 'UNAUTHORIZED_GRANT' AS violation,
             CASE WHEN acl.grantee = 0 THEN 'PUBLIC' ELSE acl.grantee::regrole::text END AS grantee
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) AS acl
      JOIN information_schema.routines r ON r.routine_schema = n.nspname AND r.routine_name = p.proname
      WHERE n.nspname = 'public'
        AND p.proname IN (
          'accept_saved_card_offer',
          'decline_saved_card_offer',
          'create_provider_consented_offer'
        )
        AND acl.privilege_type = 'EXECUTE'
        AND (acl.grantee = 0 OR acl.grantee::regrole::text IN ('anon', 'authenticated'))
      UNION ALL
      -- Check 2: service_role MUST have EXECUTE (required access)
      SELECT p.proname AS routine_name, 'MISSING_SERVICE_ROLE_GRANT' AS violation, 'service_role' AS grantee
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND p.proname IN (
          'accept_saved_card_offer',
          'decline_saved_card_offer',
          'create_provider_consented_offer'
        )
        AND NOT EXISTS (
          SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) AS acl
          WHERE acl.privilege_type = 'EXECUTE'
            AND acl.grantee::regrole::text = 'service_role'
        )
    `,
  },
  {
    id: 'DB-005',
    description: 'bot_sessions.whatsapp_number stores raw inbound transport key (session lookup uses exact match)',
    category: 'database',
    critical: true,
    required_for: ['release_candidate', 'post_deployment'],
    owner: '#338',
    evidence_type: 'behavioral_test',
  },
  {
    id: 'DB-006',
    description: 'Both initialize_terminal_effects and finalize_payment_confirmation carry search_path = public, extensions',
    category: 'database',
    critical: true,
    required_for: ['release_candidate', 'post_deployment'],
    owner: '#365, M390',
    evidence_type: 'catalog_assertion',
    check_query: `
      SELECT p.proname,
             CASE WHEN 'search_path=public, extensions' = ANY(COALESCE(p.proconfig, ARRAY[]::text[]))
                  THEN 'OK' ELSE 'MISSING' END AS search_path_status
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND p.proname IN ('initialize_terminal_effects', 'finalize_payment_confirmation')
    `,
  },

  // ═══════════════════════════════════════════════════════════════════
  // Payment / Provider Invariants
  // ═══════════════════════════════════════════════════════════════════

  {
    id: 'PAY-001',
    description: 'Stripe Checkout Session includes saved_payment_method_options when customer is provisioned and business is eligible',
    category: 'payment',
    critical: true,
    required_for: ['release_candidate', 'post_deployment'],
    owner: '#353, #366',
    evidence_type: 'behavioral_test',
  },
  // PAY-002 REMOVED: The Stripe-Version header hypothesis for #366 is UNPROVEN.
  // #366 root cause is not yet determined. Possible causes include API version,
  // allow_redisplay_filters behavior, or other Stripe-side suppression. A new
  // PAY-002 will be added when #366 is root-caused with provider-visible evidence.
  // See: #366 issue, CTO R1 BLOCKER 8.
  {
    id: 'PAY-002',
    description: 'Stripe Checkout Save Card: provider-visible behavior matches code intent when eligible (root cause pending #366 investigation)',
    category: 'payment',
    critical: true,
    required_for: ['release_candidate', 'post_deployment'],
    owner: '#366',
    evidence_type: 'provider_check',
    // This invariant requires provider-visible evidence (e.g., retrieving the
    // created Checkout Session from Stripe API and inspecting its actual state),
    // not just verifying that code attempts to send a parameter.
  },
  {
    id: 'PAY-003',
    description: 'Paystack Save Card PIN session uses raw inbound phone (transport key), not canonPhone',
    category: 'payment',
    critical: true,
    required_for: ['release_candidate', 'post_deployment'],
    owner: '#338',
    evidence_type: 'behavioral_test',
  },
  {
    id: 'PAY-004',
    description: 'Saved-card ownership authority uses canonical +E.164 phone, never raw transport key',
    category: 'payment',
    critical: true,
    required_for: ['release_candidate', 'post_deployment'],
    owner: '#353',
    evidence_type: 'behavioral_test',
  },
  {
    id: 'PAY-006',
    description: 'Stage-2 finalization completes before Stage-3 manifest initialization',
    category: 'payment',
    critical: true,
    required_for: ['release_candidate', 'post_deployment'],
    owner: '#358',
    evidence_type: 'code_audit',
  },
  {
    id: 'PAY-007',
    description: 'Stage-3 manifest initialization failure is fail-closed: claim released for retry, no partial effects',
    category: 'payment',
    critical: true,
    required_for: ['release_candidate', 'post_deployment'],
    owner: '#365',
    evidence_type: 'behavioral_test',
  },

  // ═══════════════════════════════════════════════════════════════════
  // Channel / Routing Invariants
  // ═══════════════════════════════════════════════════════════════════

  {
    id: 'CH-001',
    description: 'Channel resolver priority: assigned_channel_id → dedicated → country shared → any shared',
    category: 'channel',
    critical: true,
    required_for: ['release_candidate', 'post_deployment'],
    owner: 'Standing',
    evidence_type: 'behavioral_test',
  },
  {
    id: 'CH-002',
    description: 'Inbound channel provenance recorded in payment metadata for confirmation routing',
    category: 'channel',
    critical: false,
    owner: '#358',
    evidence_type: 'behavioral_test',
  },

  // ═══════════════════════════════════════════════════════════════════
  // Security / Authorization Invariants
  // ═══════════════════════════════════════════════════════════════════

  {
    id: 'SEC-001',
    description: 'Service role key never exposed to client (NEXT_PUBLIC_ prefix forbidden for secrets)',
    category: 'security',
    critical: true,
    required_for: ['release_candidate', 'post_deployment'],
    owner: 'Standing',
    evidence_type: 'code_audit',
  },
  {
    id: 'SEC-004',
    description: 'PIN hash uses bcrypt, never plaintext comparison',
    category: 'security',
    critical: true,
    required_for: ['release_candidate', 'post_deployment'],
    owner: '#353',
    evidence_type: 'code_audit',
  },
];

// ═══════════════════════════════════════════════════════════════════
// Protected Objects Registry
//
// These objects have properties that must not change without an
// explicit release manifest entry with field-level specificity.
// The baseline diff engine checks every protected property and
// flags unauthorized changes.
//
// `required: true` means the object MUST exist in the catalog.
// Absence of a required object is a FAIL, not a skip.
// ═══════════════════════════════════════════════════════════════════

export const PROTECTED_OBJECTS: ProtectedObject[] = [
  {
    type: 'function',
    identifier: 'public.initialize_terminal_effects(uuid, uuid, text[], text[], text[], text[], integer)',
    protected_properties: {
      security: 'definer',
      'proconfig:search_path': 'public, extensions',
    },
    invariant_ids: ['DB-001', 'DB-002', 'DB-006'],
    required: true,
  },
  {
    type: 'function',
    identifier: 'public.finalize_payment_confirmation(uuid, uuid)',
    protected_properties: {
      security: 'definer',
      'proconfig:search_path': 'public, extensions',
    },
    invariant_ids: ['DB-001', 'DB-002', 'DB-006'],
    required: true,
  },
  {
    type: 'function',
    identifier: 'public.accept_saved_card_offer(uuid, text, text)',
    protected_properties: {
      security: 'definer',
    },
    invariant_ids: ['DB-004'],
    required: true,
  },
  {
    type: 'function',
    identifier: 'public.decline_saved_card_offer(uuid, text, text)',
    protected_properties: {
      security: 'definer',
    },
    invariant_ids: ['DB-004'],
    required: true,
  },
  {
    type: 'function',
    identifier: 'public.create_provider_consented_offer(uuid, text, uuid, text, text, text, text, uuid, uuid)',
    protected_properties: {
      security: 'definer',
    },
    invariant_ids: ['DB-004'],
    required: true,
  },
];

/**
 * Get invariant definitions by ID.
 */
export function getInvariant(id: string): InvariantDefinition | undefined {
  return INVARIANTS.find(i => i.id === id);
}

/**
 * Get all critical invariants.
 */
export function getCriticalInvariants(): InvariantDefinition[] {
  return INVARIANTS.filter(i => i.critical);
}

/**
 * Get protected objects for a given invariant.
 */
export function getProtectedObjectsForInvariant(invariantId: string): ProtectedObject[] {
  return PROTECTED_OBJECTS.filter(o => o.invariant_ids.includes(invariantId));
}
