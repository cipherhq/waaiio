import { readFileSync } from 'node:fs';
import { PAYOUT_POLICY, digest } from './reduced-release-evidence.mjs';

// Reviewed source inventory; never supplied by a manifest. No path prefixes.
export const PAYOUT_TARGETS = {
  merchant: {
    allowed: [
      "app/api/admin/payouts/[id]/approve/route.ts",
      "app/api/admin/payouts/[id]/confirm-settlement/route.ts",
      "app/api/admin/payouts/[id]/reject/route.ts",
      "app/api/admin/payouts/generate/route.ts",
      "app/api/admin/payouts/route.ts",
      "app/api/admin/step-up/prepare/route.ts",
      "app/api/admin/step-up/verify/route.ts",
      "app/dashboard/payouts/__tests__/calendar-period-display.test.tsx",
      "app/dashboard/payouts/history/page.tsx",
      "app/dashboard/payouts/page.tsx",
      "docs/MIGRATION_REGISTRY.md",
      "lib/__tests__/admin-mfa-transport.test.ts",
      "lib/__tests__/admin-role-escalation.test.ts",
      "lib/__tests__/admin-step-up-verification-609.test.ts",
      "lib/__tests__/calendar-date.test.ts",
      "lib/__tests__/fin-001-containment.test.ts",
      "lib/__tests__/fin-002-atomic-payout.test.ts",
      "lib/__tests__/finance-role-reconciliation.test.ts",
      "lib/__tests__/fixtures/payout-reject-prerequisites.sql",
      "lib/__tests__/m468-payout-safety.test.ts",
      "lib/__tests__/manual-payout-reject-race.pg.test.ts",
      "lib/__tests__/manual-settlement-confirmation.test.ts",
      "lib/__tests__/payout-account-autolink-620.test.ts",
      "lib/__tests__/payout-approve-balance-logging.test.ts",
      "lib/__tests__/payout-custody-formula.test.ts",
      "lib/__tests__/payout-format-amount.test.ts",
      "lib/__tests__/payout-list-currency.test.ts",
      "lib/__tests__/payout-verification-limit-currency.test.ts",
      "lib/__tests__/payout-verification-limit-enforcement.test.ts",
      "lib/__tests__/reduced-admin-auth-runtime.test.ts",
      "lib/__tests__/reduced-step-up-compatibility.test.ts",
      "lib/__tests__/reject-held-payouts-620.test.ts",
      "lib/admin-audit.ts",
      "lib/admin-auth.ts",
      "lib/admin-mfa-transport.ts",
      "lib/admin-step-up.ts",
      "lib/payments/payable-fees.ts",
      "lib/payouts/format-amount.ts",
      "lib/payouts/verification-limit.ts",
      "lib/utils/calendar-date.ts",
      "package-lock.json",
      "package.json",
      "supabase/migrations/498_manual_settlement_rejection_guard.sql"
],
    suites: [
      { tz: 'UTC', files: { 'lib/__tests__/calendar-date.test.ts': 6, 'app/dashboard/payouts/__tests__/calendar-period-display.test.tsx': 2 } },
      { tz: 'America/New_York', files: { 'lib/__tests__/calendar-date.test.ts': 6, 'app/dashboard/payouts/__tests__/calendar-period-display.test.tsx': 2 } },
      {
            "tz": "UTC",
            "files": {
                  "lib/__tests__/admin-cors-routes.test.ts": 27,
                  "lib/__tests__/admin-mfa-transport.test.ts": 10,
                  "lib/__tests__/admin-role-escalation.test.ts": 26,
                  "lib/__tests__/admin-step-up-verification-609.test.ts": 11,
                  "lib/__tests__/admin-team-api.test.ts": 22,
                  "lib/__tests__/fin-001-containment.test.ts": 90,
                  "lib/__tests__/fin-002-atomic-payout.test.ts": 92,
                  "lib/__tests__/finance-role-reconciliation.test.ts": 68,
                  "lib/__tests__/m468-payout-safety.test.ts": 6,
                  "lib/__tests__/manual-settlement-confirmation.test.ts": 12,
                  "lib/__tests__/p0-admin-capability-authority.test.ts": 25,
                  "lib/__tests__/payout-account-autolink-620.test.ts": 6,
                  "lib/__tests__/payout-approve-balance-logging.test.ts": 5,
                  "lib/__tests__/payout-custody-formula.test.ts": 21,
                  "lib/__tests__/payout-format-amount.test.ts": 7,
                  "lib/__tests__/payout-list-currency.test.ts": 2,
                  "lib/__tests__/payout-verification-limit-currency.test.ts": 9,
                  "lib/__tests__/payout-verification-limit-enforcement.test.ts": 1,
                  "lib/__tests__/reduced-admin-auth-runtime.test.ts": 23,
                  "lib/__tests__/reduced-step-up-compatibility.test.ts": 19,
                  "lib/__tests__/reject-held-payouts-620.test.ts": 12,
                  "lib/__tests__/whatsapp-templates-route-auth.test.ts": 14
            }
      },
      {
            "tz": "UTC",
            "postgres": true,
            "files": {
                  "lib/__tests__/manual-payout-reject-race.pg.test.ts": 5
            }
      }
],
  },
  admin: { allowed: ['admin/src/pages/Payouts.tsx', 'admin/src/__tests__/payout-generation-feedback.test.tsx', 'admin/src/hooks/useStepUp.ts', 'admin/src/__tests__/payout-generation-step-up.test.tsx'], suites: [{ tz: 'UTC', files: { 'src/__tests__/payout-generation-feedback.test.tsx': 4, 'src/__tests__/payouts-held-review-620.test.tsx': 19, 'src/__tests__/payout-generation-step-up.test.tsx': 9 } }] },
};

// Fixed canonical object contract and bounded hosted acceptance. Migration labels
// identify source provenance, not instructions to replay existing equivalent DDL.
const schemaBytes = readFileSync(new URL('./reduced-payout-schema-contract.json', import.meta.url), 'utf8');
export const PAYOUT_EVIDENCE_POLICY = {
  id: PAYOUT_POLICY, production_project_ref: 'cxcmiqotkowhxinjbytg',
  schema_contract_sha256: digest(schemaBytes), schema_contracts: JSON.parse(schemaBytes),
  require_disabled_payout_cron: true,
  staging_projects: {
    merchant: { project_id: 'prj_h7YmC4fvpxhn429znCy34OjLZ6se', supabase_project_ref: 'tqjvrzopvtczxfxiwmnz' },
    admin: { project_id: 'prj_wLF7TDNN7BrjGFyIlen2IR8SvorM', supabase_project_ref: 'tqjvrzopvtczxfxiwmnz' },
  },
  acceptance_cases: [
    { id: 'merchant-runtime-and-public-config', observed: { four_field_identity: true, pinned_public_config_ref: true } },
    { id: 'admin-control-plane-and-assets', observed: { pinned_project_deployment: true, asset_mapping: true, proof_scope: 'control-plane-and-assets' } },
    { id: 'owner-aal2-login', observed: { role: 'admin', aal: 'aal2', actual_hosted_auth: true } },
    { id: 'operation-bound-mfa', observed: { action: 'payout_generate', target_id: null, params: { action: 'generate' }, actual_prepare_verify: true, session_factor_challenge_correlated: true, grant_unconsumed: true, rotated_session_before_interception: true } },
    { id: 'generation-ui-fixtures', observed: { proof_scope: 'intercepted-ui-fixtures-only', success_200: true, partial_207: true, no_eligible_200: true, fatal_500: true } },
    { id: 'financial-request-boundary', observed: { forwarded_generation: 0, forwarded_approve: 0, forwarded_reject: 0, forwarded_confirm: 0, forwarded_provider: 0, generation_intercepted: true } },
  ],
};

// Canonical integration SQL proofs are separate from merchant handler tests.
export const INTEGRATION_SQL_TESTS = {
  'lib/__tests__/admin-step-up-concurrency.pg.test.ts': 4,
  'lib/__tests__/m469-settlement-currency.pg.test.ts': 16,
};

export const INTEGRATION_RUNTIME_SOURCES = ['lib/admin-step-up.ts'];
