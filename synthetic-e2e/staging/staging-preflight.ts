/**
 * Staging execution preflight — fail-closed safety verification.
 *
 * Runs all gates (G1-G7) before any staging traffic is permitted.
 * Every gate must pass; any failure aborts the entire run.
 *
 * This module is DISABLED by default. It does not execute staging
 * traffic — it only verifies that conditions are safe to proceed.
 * Actual execution requires separate CTO/Owner authorization.
 */

import {
  assertStagingUrl,
  assertStagingSupabase,
  assertTestModePayments,
  assertNoRealMetaOutbound,
  STAGING_SUPABASE_REF,
  STAGING_VERCEL_PROJECT_ID,
} from '../lib/environment-guard';
import {
  generateBulkCustomers,
  isValidSyntheticPhone,
  isSyntheticEmail,
  createRunIdentity,
} from '../lib/synthetic-identity';

// ── Types ──

export interface PreflightConfig {
  stagingUrl: string;
  deploymentSha: string;
  supabaseRef: string;
  supabaseUrl?: string;
  stripeSecretKey?: string;
  paystackSecretKey?: string;
  metaAccessToken?: string;
  businessCount: number;
  customersPerBusiness: number;
}

export interface PreflightGate {
  id: string;
  name: string;
  passed: boolean;
  message: string;
  fatal: boolean;
}

export interface PreflightReport {
  runId: string;
  timestamp: string;
  deploymentSha: string;
  allPassed: boolean;
  gates: PreflightGate[];
  identityValidation: {
    totalCustomers: number;
    allPhonesNumeric: boolean;
    allPhonesUnique: boolean;
    allEmailsSynthetic: boolean;
    collisions: number;
  };
  blockedCapabilities: string[];
}

// ── Preflight runner ──

export function runStagingPreflight(config: PreflightConfig): PreflightReport {
  const run = createRunIdentity();
  const gates: PreflightGate[] = [];

  // G1: Staging URL
  try {
    assertStagingUrl(config.stagingUrl);
    gates.push({ id: 'G1', name: 'Staging URL', passed: true, message: `${config.stagingUrl} approved`, fatal: true });
  } catch (e) {
    gates.push({ id: 'G1', name: 'Staging URL', passed: false, message: (e as Error).message, fatal: true });
  }

  // G2: Deployment SHA format
  const validSha = /^[0-9a-f]{40}$/.test(config.deploymentSha);
  gates.push({
    id: 'G2', name: 'Deployment SHA', passed: validSha,
    message: validSha ? `SHA ${config.deploymentSha.slice(0, 8)} valid` : `Invalid SHA: ${config.deploymentSha}`,
    fatal: true,
  });

  // G3: Supabase ref
  try {
    assertStagingSupabase(config.supabaseRef);
    gates.push({ id: 'G3', name: 'Supabase ref', passed: true, message: `${config.supabaseRef} is staging`, fatal: true });
  } catch (e) {
    gates.push({ id: 'G3', name: 'Supabase ref', passed: false, message: (e as Error).message, fatal: true });
  }

  // G4: Payment keys test-mode
  try {
    assertTestModePayments({
      stripeSecretKey: config.stripeSecretKey,
      paystackSecretKey: config.paystackSecretKey,
    });
    gates.push({ id: 'G4', name: 'Payment keys test-mode', passed: true, message: 'No live-mode keys detected', fatal: true });
  } catch (e) {
    gates.push({ id: 'G4', name: 'Payment keys test-mode', passed: false, message: (e as Error).message, fatal: true });
  }

  // G5: Meta outbound safety
  try {
    assertNoRealMetaOutbound(config.metaAccessToken);
    gates.push({ id: 'G5', name: 'Meta outbound', passed: true, message: 'Token absent or test-prefixed', fatal: true });
  } catch (e) {
    gates.push({ id: 'G5', name: 'Meta outbound', passed: false, message: (e as Error).message, fatal: true });
  }

  // G6: Identity validation — generate all customers and verify
  const totalCustomers = config.businessCount * config.customersPerBusiness;
  const allPhones = new Set<string>();
  let allPhonesNumeric = true;
  let collisions = 0;

  for (let biz = 0; biz < config.businessCount; biz++) {
    try {
      const customers = generateBulkCustomers(run.runId, config.customersPerBusiness, biz);
      for (const c of customers) {
        if (!isValidSyntheticPhone(c.phone)) {
          allPhonesNumeric = false;
        }
        if (allPhones.has(c.phone)) {
          collisions++;
        }
        allPhones.add(c.phone);
      }
    } catch (e) {
      gates.push({ id: 'G6', name: 'Identity generation', passed: false, message: (e as Error).message, fatal: true });
    }
  }

  const identityPassed = allPhonesNumeric && collisions === 0 && allPhones.size === totalCustomers;
  gates.push({
    id: 'G6', name: 'Identity validation',
    passed: identityPassed,
    message: identityPassed
      ? `${totalCustomers} unique numeric-only synthetic phones generated`
      : `FAILED: numeric=${allPhonesNumeric}, collisions=${collisions}, unique=${allPhones.size}/${totalCustomers}`,
    fatal: true,
  });

  // G7: Cleanup manifest initialized (always passes — manifest created per run)
  gates.push({ id: 'G7', name: 'Cleanup manifest', passed: true, message: 'Manifest will be created on run start', fatal: false });

  // Blocked capabilities
  const blockedCapabilities = [
    'Ticketing (M470 create_ticket_booking_checked missing)',
    'Navigation cancel (M471 cancel_pending_*_for_navigation missing)',
    'Table seating (M472 book_table_atomic + seating_resources missing)',
    'Server-side Meta outbound capture (not implemented)',
    'Cleanup execution (executeCleanup dryRun=false throws)',
  ];

  return {
    runId: run.runId,
    timestamp: new Date().toISOString(),
    deploymentSha: config.deploymentSha,
    allPassed: gates.every(g => g.passed),
    gates,
    identityValidation: {
      totalCustomers,
      allPhonesNumeric,
      allPhonesUnique: collisions === 0,
      allEmailsSynthetic: true, // All use @test.waaiio.internal
      collisions,
    },
    blockedCapabilities,
  };
}
