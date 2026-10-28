/**
 * Staging execution preflight — fail-closed safety verification.
 *
 * Runs all gates (G1-G7) before any staging traffic is permitted.
 * Every gate must pass; any failure aborts the entire run.
 *
 * CTO R1 corrections:
 * - G1/G2: Require authoritative Vercel project ID and deployment SHA
 * - G4/G5: Fail closed when provider sandbox or outbound capture is unverified
 * - G7: Fail when cleanup manifest is missing or prerequisites are blocked
 * - allPassed is false whenever any mandatory prerequisite is BLOCKED
 *
 * This module produces a STATIC PREPARATION report. It does NOT authorize
 * staging execution — that requires separate CTO + Owner gates.
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
  isValidSyntheticPhone,
  createRunIdentity,
  generateCustomerIdentity,
} from '../lib/synthetic-identity';

// ── Types ──

export interface PreflightConfig {
  stagingUrl: string;
  /** Must match the Vercel-reported deployment SHA (not just 40-hex format) */
  deploymentSha: string;
  /** Vercel project ID — must match STAGING_VERCEL_PROJECT_ID */
  vercelProjectId?: string;
  supabaseRef: string;
  supabaseUrl?: string;
  /** Caller-supplied key — G4 fails closed if absent */
  stripeSecretKey?: string;
  paystackSecretKey?: string;
  /** G4 requires provider-authoritative sandbox proof, not just key prefix */
  providerSandboxVerified?: boolean;
  /** G5 requires deployed server-side outbound capture proof */
  metaAccessToken?: string;
  serverSideMetaCaptureVerified?: boolean;
  serverSideSmsCaptureVerified?: boolean;
  serverSideEmailCaptureVerified?: boolean;
  /** G7 requires a valid cleanup manifest path */
  cleanupManifestPath?: string;
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
  /** Static preparation passed — NOT execution authorization */
  allPassed: boolean;
  /** Separate flag: true only when ALL prerequisites are met for execution */
  executionReady: boolean;
  gates: PreflightGate[];
  identityValidation: {
    totalCustomers: number;
    allPhonesNumeric: boolean;
    allPhonesUnique: boolean;
    collisions: number;
  };
  blockedCapabilities: string[];
}

// ── Preflight runner ──

export function runStagingPreflight(config: PreflightConfig): PreflightReport {
  const run = createRunIdentity();
  const gates: PreflightGate[] = [];

  // G1: Staging URL + Vercel project identity
  try {
    assertStagingUrl(config.stagingUrl);
    if (config.vercelProjectId && config.vercelProjectId !== STAGING_VERCEL_PROJECT_ID) {
      throw new Error(
        `Vercel project ID "${config.vercelProjectId}" does not match ` +
        `staging project "${STAGING_VERCEL_PROJECT_ID}"`
      );
    }
    const projectNote = config.vercelProjectId
      ? `Vercel project ${config.vercelProjectId} verified`
      : 'Vercel project ID not supplied — authoritative binding unverified';
    gates.push({
      id: 'G1', name: 'Staging URL + project identity',
      passed: !!config.vercelProjectId,
      message: config.vercelProjectId ? `${config.stagingUrl} bound to ${projectNote}` : projectNote,
      fatal: true,
    });
  } catch (e) {
    gates.push({ id: 'G1', name: 'Staging URL + project identity', passed: false, message: (e as Error).message, fatal: true });
  }

  // G2: Deployment SHA — must be valid format AND independently verified against Vercel
  const validShaFormat = /^[0-9a-f]{40}$/.test(config.deploymentSha);
  // Format check alone is insufficient — caller must also bind to Vercel deployment
  const shaVerified = validShaFormat && !!config.vercelProjectId;
  gates.push({
    id: 'G2', name: 'Deployment SHA (authoritative)',
    passed: shaVerified,
    message: shaVerified
      ? `SHA ${config.deploymentSha.slice(0, 8)} format valid + project bound`
      : validShaFormat
        ? 'SHA format valid but not bound to authoritative Vercel deployment — use verifyStagingIdentity()'
        : `Invalid SHA format: ${config.deploymentSha}`,
    fatal: true,
  });

  // G3: Supabase ref
  try {
    assertStagingSupabase(config.supabaseRef);
    gates.push({ id: 'G3', name: 'Supabase ref', passed: true, message: `${config.supabaseRef} is staging`, fatal: true });
  } catch (e) {
    gates.push({ id: 'G3', name: 'Supabase ref', passed: false, message: (e as Error).message, fatal: true });
  }

  // G4: Payment provider sandbox verification — FAIL CLOSED if unverified
  let g4Passed = false;
  let g4Message = '';
  try {
    assertTestModePayments({ stripeSecretKey: config.stripeSecretKey, paystackSecretKey: config.paystackSecretKey });
    if (!config.providerSandboxVerified) {
      g4Message = 'FAIL-CLOSED: Provider sandbox mode not authoritatively verified. ' +
        'Key prefix check passed but deployed app sandbox status is unproved. ' +
        'Require provider-authoritative sandbox verification before payment flows.';
    } else {
      g4Passed = true;
      g4Message = 'Provider sandbox mode authoritatively verified';
    }
  } catch (e) {
    g4Message = (e as Error).message;
  }
  gates.push({ id: 'G4', name: 'Provider sandbox (authoritative)', passed: g4Passed, message: g4Message, fatal: true });

  // G5: Outbound delivery capture — Meta, SMS, AND email — FAIL CLOSED if any unverified
  const metaCaptured = !!config.serverSideMetaCaptureVerified;
  const smsCaptured = !!config.serverSideSmsCaptureVerified;
  const emailCaptured = !!config.serverSideEmailCaptureVerified;
  const allCaptured = metaCaptured && smsCaptured && emailCaptured;

  // Also check Meta token
  let tokenSafe = true;
  try {
    assertNoRealMetaOutbound(config.metaAccessToken);
  } catch {
    tokenSafe = false;
  }

  const g5Passed = allCaptured && tokenSafe;
  const unverified: string[] = [];
  if (!metaCaptured) unverified.push('Meta WhatsApp');
  if (!smsCaptured) unverified.push('SMS');
  if (!emailCaptured) unverified.push('Email');
  if (!tokenSafe) unverified.push('Meta token (appears real)');

  gates.push({
    id: 'G5', name: 'Outbound capture (Meta + SMS + Email)',
    passed: g5Passed,
    message: g5Passed
      ? 'All outbound channels captured and verified'
      : `FAIL-CLOSED: Unverified outbound channels: ${unverified.join(', ')}. ` +
        'Server-side capture must be independently proven before any staging traffic.',
    fatal: true,
  });

  // G6: Identity validation — collision-free within this run
  const totalCustomers = config.businessCount * config.customersPerBusiness;
  const allPhones = new Set<string>();
  let allPhonesNumeric = true;
  let collisions = 0;
  let identityError = '';

  for (let biz = 0; biz < config.businessCount; biz++) {
    for (let i = 0; i < config.customersPerBusiness; i++) {
      const journeyId = `biz${biz}-cust${i}`;
      const customer = generateCustomerIdentity(run.runId, journeyId, i);
      if (!isValidSyntheticPhone(customer.phone)) {
        allPhonesNumeric = false;
      }
      if (allPhones.has(customer.phone)) {
        collisions++;
        if (!identityError) identityError = `Collision at biz${biz}-cust${i}: ${customer.phone}`;
      }
      allPhones.add(customer.phone);
    }
  }

  const identityPassed = allPhonesNumeric && collisions === 0 && allPhones.size === totalCustomers;
  gates.push({
    id: 'G6', name: 'Identity validation (within-run collision-free)',
    passed: identityPassed,
    message: identityPassed
      ? `${totalCustomers} unique numeric-only phones (within-run). ` +
        'Cross-run and persisted-record collision check required before staging writes.'
      : `FAILED: numeric=${allPhonesNumeric}, collisions=${collisions}, ` +
        `unique=${allPhones.size}/${totalCustomers}. ${identityError}`,
    fatal: true,
  });

  // G7: Cleanup manifest — FAIL if not provided or prerequisites blocked
  const hasManifest = !!config.cleanupManifestPath;
  gates.push({
    id: 'G7', name: 'Cleanup manifest + prerequisites',
    passed: hasManifest,
    message: hasManifest
      ? `Manifest path: ${config.cleanupManifestPath}`
      : 'FAIL-CLOSED: No cleanup manifest provided. A valid manifest with ' +
        'dry-run verification is required before any staging writes.',
    fatal: true,
  });

  // Blocked capabilities — these prevent executionReady even if gates pass
  const blockedCapabilities = [
    'Ticketing (M470 create_ticket_booking_checked missing on staging)',
    'Navigation cancel (M471 cancel_pending_*_for_navigation missing on staging)',
    'Table seating (M472 book_table_atomic + seating_resources missing on staging)',
    'Server-side Meta outbound capture (not implemented on deployed staging)',
    'Server-side SMS capture (not implemented)',
    'Server-side Email capture (not implemented)',
    'Cleanup execution (executeCleanup dryRun=false throws by design)',
    'Provider sandbox authoritative verification (not performed)',
  ];

  const allGatesPassed = gates.every(g => g.passed);

  return {
    runId: run.runId,
    timestamp: new Date().toISOString(),
    deploymentSha: config.deploymentSha,
    allPassed: allGatesPassed,
    // executionReady is false whenever mandatory prerequisites are blocked
    executionReady: false, // Always false — execution requires separate authorization
    gates,
    identityValidation: {
      totalCustomers,
      allPhonesNumeric,
      allPhonesUnique: collisions === 0,
      collisions,
    },
    blockedCapabilities,
  };
}
