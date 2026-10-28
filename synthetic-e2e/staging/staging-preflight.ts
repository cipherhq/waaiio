/**
 * Staging execution preflight — static preparation report.
 *
 * CTO R2 corrections:
 * - Gates that require runtime evidence (G2 deployment SHA, G4 provider
 *   sandbox, G5 outbound capture, G7 cleanup manifest) report UNVERIFIED
 *   until actual sourced evidence exists. Caller-supplied booleans and
 *   strings are NOT treated as authoritative proof.
 * - G6 uses the same generateBulkCustomers() allocator validated by tests.
 * - allPassed requires all statically verifiable gates to pass.
 * - executionReady is always false — requires separate authorization.
 *
 * This is a STATIC PREPARATION check. It identifies what has been verified
 * and what remains UNVERIFIED for future execution authorization.
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
  createRunIdentity,
} from '../lib/synthetic-identity';

// ── Types ──

export type GateStatus = 'PASSED' | 'FAILED' | 'UNVERIFIED';

export interface PreflightConfig {
  stagingUrl: string;
  deploymentSha: string;
  vercelProjectId?: string;
  supabaseRef: string;
  stripeSecretKey?: string;
  paystackSecretKey?: string;
  metaAccessToken?: string;
  /** Caller-claimed flags — reported but NOT treated as authoritative proof */
  callerClaims?: {
    providerSandboxVerified?: boolean;
    serverSideMetaCaptureVerified?: boolean;
    serverSideSmsCaptureVerified?: boolean;
    serverSideEmailCaptureVerified?: boolean;
    cleanupManifestPath?: string;
  };
  businessCount: number;
  customersPerBusiness: number;
}

export interface PreflightGate {
  id: string;
  name: string;
  status: GateStatus;
  message: string;
  /** Whether this gate can be verified statically or requires runtime evidence */
  requiresRuntimeEvidence: boolean;
}

export interface PreflightReport {
  runId: string;
  timestamp: string;
  deploymentSha: string;
  /** All statically verifiable gates passed */
  staticChecksPassed: boolean;
  /** Always false — execution requires separate CTO + Owner authorization */
  executionReady: false;
  gates: PreflightGate[];
  identityValidation: {
    totalCustomers: number;
    allPhonesNumeric: boolean;
    allPhonesUnique: boolean;
    collisions: number;
  };
  unverifiedPrerequisites: string[];
  blockedCapabilities: string[];
}

// ── Preflight runner ──

export function runStagingPreflight(config: PreflightConfig): PreflightReport {
  const run = createRunIdentity();
  const gates: PreflightGate[] = [];

  // ── G1: Staging URL (statically verifiable) ──
  try {
    assertStagingUrl(config.stagingUrl);
    gates.push({
      id: 'G1', name: 'Staging URL format',
      status: 'PASSED',
      message: `${config.stagingUrl} matches staging allowlist`,
      requiresRuntimeEvidence: false,
    });
  } catch (e) {
    gates.push({
      id: 'G1', name: 'Staging URL format',
      status: 'FAILED',
      message: (e as Error).message,
      requiresRuntimeEvidence: false,
    });
  }

  // ── G2: Deployment SHA + Vercel project binding (REQUIRES runtime evidence) ──
  // A caller-supplied SHA and project ID are NOT authoritative.
  // Actual verification requires querying the Vercel API at runtime.
  const validShaFormat = /^[0-9a-f]{40}$/.test(config.deploymentSha);
  const projectIdMatches = config.vercelProjectId === STAGING_VERCEL_PROJECT_ID;
  gates.push({
    id: 'G2', name: 'Deployment SHA + Vercel binding',
    status: 'UNVERIFIED',
    message: validShaFormat && projectIdMatches
      ? `SHA format valid and project ID matches staging, but NOT authoritatively ` +
        `verified against Vercel API. Use verifyStagingIdentity() at runtime.`
      : !validShaFormat
        ? `Invalid SHA format: "${config.deploymentSha}"`
        : `Project ID "${config.vercelProjectId || 'missing'}" does not match staging "${STAGING_VERCEL_PROJECT_ID}"`,
    requiresRuntimeEvidence: true,
  });

  // ── G3: Supabase ref (statically verifiable) ──
  try {
    assertStagingSupabase(config.supabaseRef);
    gates.push({
      id: 'G3', name: 'Supabase staging ref',
      status: 'PASSED',
      message: `${config.supabaseRef} is the recognized staging project`,
      requiresRuntimeEvidence: false,
    });
  } catch (e) {
    gates.push({
      id: 'G3', name: 'Supabase staging ref',
      status: 'FAILED',
      message: (e as Error).message,
      requiresRuntimeEvidence: false,
    });
  }

  // ── G4: Provider sandbox (REQUIRES runtime evidence) ──
  // Key prefix check is a static defense-in-depth, not authoritative sandbox proof.
  let keyPrefixSafe = true;
  try {
    assertTestModePayments({ stripeSecretKey: config.stripeSecretKey, paystackSecretKey: config.paystackSecretKey });
  } catch {
    keyPrefixSafe = false;
  }
  gates.push({
    id: 'G4', name: 'Provider sandbox mode',
    status: keyPrefixSafe ? 'UNVERIFIED' : 'FAILED',
    message: keyPrefixSafe
      ? 'No live-mode key prefix detected (defense-in-depth). ' +
        'Provider-authoritative sandbox verification NOT yet performed. ' +
        'Requires Stripe/Paystack API mode check at runtime.'
      : 'FAILED: Live-mode payment key prefix detected.',
    requiresRuntimeEvidence: true,
  });

  // ── G5: Outbound capture — Meta, SMS, Email (REQUIRES runtime evidence) ──
  let tokenSafe = true;
  try {
    assertNoRealMetaOutbound(config.metaAccessToken);
  } catch {
    tokenSafe = false;
  }
  gates.push({
    id: 'G5', name: 'Outbound capture (Meta + SMS + Email)',
    status: tokenSafe ? 'UNVERIFIED' : 'FAILED',
    message: tokenSafe
      ? 'Meta token absent or test-prefixed (defense-in-depth). ' +
        'Server-side deployed outbound capture for Meta, SMS, and Email is ' +
        'NOT verified. Requires independent runtime proof before staging traffic.'
      : 'FAILED: Meta token appears to be a real credential.',
    requiresRuntimeEvidence: true,
  });

  // ── G6: Identity allocation (statically verifiable via bulk allocator) ──
  const totalCustomers = config.businessCount * config.customersPerBusiness;
  const allPhones = new Set<string>();
  let allPhonesNumeric = true;
  let collisions = 0;
  let identityError = '';

  // Use the SAME generateBulkCustomers() allocator that the bulk tests validate
  for (let biz = 0; biz < config.businessCount; biz++) {
    try {
      const customers = generateBulkCustomers(run.runId, config.customersPerBusiness, biz);
      for (const c of customers) {
        if (!isValidSyntheticPhone(c.phone)) allPhonesNumeric = false;
        if (allPhones.has(c.phone)) {
          collisions++;
          if (!identityError) identityError = `Cross-business collision: ${c.phone}`;
        }
        allPhones.add(c.phone);
      }
    } catch (e) {
      identityError = (e as Error).message;
    }
  }

  const identityPassed = allPhonesNumeric && collisions === 0 && allPhones.size === totalCustomers && !identityError;
  gates.push({
    id: 'G6', name: 'Identity allocation (within-run, bulk allocator)',
    status: identityPassed ? 'PASSED' : 'FAILED',
    message: identityPassed
      ? `${totalCustomers} collision-free numeric phones via generateBulkCustomers(). ` +
        'Cross-run and persisted-record check required before staging writes.'
      : `FAILED: ${identityError || `collisions=${collisions}, unique=${allPhones.size}/${totalCustomers}`}`,
    requiresRuntimeEvidence: false,
  });

  // ── G7: Cleanup manifest (REQUIRES runtime evidence) ──
  // A nonempty path string is NOT a validated, initialized manifest.
  gates.push({
    id: 'G7', name: 'Cleanup manifest',
    status: 'UNVERIFIED',
    message: 'Cleanup manifest initialization and validation requires runtime setup. ' +
      'A manifest file path alone is not proof of a valid, initialized manifest. ' +
      'executeCleanup(dryRun=false) throws by design.',
    requiresRuntimeEvidence: true,
  });

  // ── Unverified prerequisites ──
  const unverifiedPrerequisites = [
    'Vercel deployment SHA binding (G2) — requires verifyStagingIdentity() API call',
    'Provider sandbox mode (G4) — requires Stripe/Paystack API mode verification',
    'Server-side Meta outbound capture (G5) — not implemented on deployed staging',
    'Server-side SMS capture (G5) — not implemented',
    'Server-side Email capture (G5) — not implemented',
    'Cleanup manifest (G7) — requires runtime initialization and dry-run verification',
    'Cross-run identity collision check — requires persisted-record query',
  ];

  const blockedCapabilities = [
    'Ticketing (M470 create_ticket_booking_checked missing on staging)',
    'Navigation cancel (M471 cancel_pending_*_for_navigation missing on staging)',
    'Table seating (M472 book_table_atomic + seating_resources missing on staging)',
  ];

  // Static checks: only gates that DON'T require runtime evidence
  const staticGates = gates.filter(g => !g.requiresRuntimeEvidence);
  const staticChecksPassed = staticGates.every(g => g.status === 'PASSED');

  return {
    runId: run.runId,
    timestamp: new Date().toISOString(),
    deploymentSha: config.deploymentSha,
    staticChecksPassed,
    executionReady: false, // Always false — separate authorization required
    gates,
    identityValidation: {
      totalCustomers,
      allPhonesNumeric,
      allPhonesUnique: collisions === 0,
      collisions,
    },
    unverifiedPrerequisites,
    blockedCapabilities,
  };
}
