/**
 * Migration Repair Guard
 *
 * Prevents unsafe `supabase migration repair` operations by validating
 * proposed repairs against the reconciliation manifest.
 *
 * Rules:
 * 1. NOT_VERIFIABLE_SAFELY versions cannot be repaired
 * 2. SUPERSEDED_WITH_EQUIVALENT_STATE versions cannot be repaired
 * 3. Only versions with repair_eligible=true in the manifest are allowed
 * 4. Bulk repair requires per-version allowlist evidence
 * 5. Versions already in APPLIED_WITHOUT_EXECUTION status cannot be re-repaired
 *
 * Usage:
 *   npx tsx scripts/migration-repair-guard.ts check <version>
 *   npx tsx scripts/migration-repair-guard.ts validate-allowlist
 */

import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

const MANIFEST_PATH = resolve('docs/migrations/101-246-production-reconciliation.json');
const ALLOWLIST_PATH = resolve('docs/migrations/101-246-repair-allowlist.json');
const DEVIATION_VERSIONS = new Set([
  '101', '105', '107', '122', '126', '130', '160', '163', '164', '187', '216', '217', '222', '226',
]);

const BLOCKED_CLASSIFICATIONS = new Set([
  'NOT_VERIFIABLE_SAFELY',
  'SUPERSEDED_WITH_EQUIVALENT_STATE',
]);

interface ManifestEntry {
  version: string;
  filename: string;
  original_classification: string;
  current_classification: string;
  repair_eligible: boolean;
  repair_status: string;
}

function loadManifest(): ManifestEntry[] {
  if (!existsSync(MANIFEST_PATH)) {
    throw new Error(`Manifest not found: ${MANIFEST_PATH}`);
  }
  return JSON.parse(readFileSync(MANIFEST_PATH, 'utf-8'));
}

function loadAllowlist(): string[] {
  if (!existsSync(ALLOWLIST_PATH)) return [];
  const data = JSON.parse(readFileSync(ALLOWLIST_PATH, 'utf-8'));
  return Array.isArray(data) ? data.map((v: { version?: string } | string) => typeof v === 'string' ? v : v.version ?? '') : [];
}

export function checkRepairEligibility(version: string): {
  allowed: boolean;
  reason: string;
  classification: string;
} {
  const manifest = loadManifest();
  const entry = manifest.find((e) => e.version === version);

  if (!entry) {
    return { allowed: false, reason: 'Version not found in manifest', classification: 'UNKNOWN' };
  }

  if (DEVIATION_VERSIONS.has(version)) {
    return {
      allowed: false,
      reason: `Version ${version} is in APPLIED_WITHOUT_EXECUTION status (production deviation). Cannot be re-repaired.`,
      classification: entry.current_classification,
    };
  }

  if (BLOCKED_CLASSIFICATIONS.has(entry.current_classification)) {
    return {
      allowed: false,
      reason: `Version ${version} classified as ${entry.current_classification}. Repair is not safe.`,
      classification: entry.current_classification,
    };
  }

  if (!entry.repair_eligible) {
    return {
      allowed: false,
      reason: `Version ${version} is not marked repair_eligible in the manifest.`,
      classification: entry.current_classification,
    };
  }

  const allowlist = loadAllowlist();
  if (!allowlist.includes(version)) {
    return {
      allowed: false,
      reason: `Version ${version} is not in the active repair allowlist.`,
      classification: entry.current_classification,
    };
  }

  return { allowed: true, reason: 'Repair allowed', classification: entry.current_classification };
}

// CLI entry point
if (process.argv[1]?.endsWith('migration-repair-guard.ts')) {
  const command = process.argv[2];
  const version = process.argv[3];

  if (command === 'check' && version) {
    const result = checkRepairEligibility(version);
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.allowed ? 0 : 1);
  } else if (command === 'validate-allowlist') {
    const allowlist = loadAllowlist();
    if (allowlist.length === 0) {
      console.log('Allowlist is empty. No repairs authorized.');
      process.exit(0);
    }
    let hasError = false;
    for (const v of allowlist) {
      const result = checkRepairEligibility(v);
      if (!result.allowed) {
        console.error(`BLOCKED: ${v} — ${result.reason}`);
        hasError = true;
      } else {
        console.log(`OK: ${v}`);
      }
    }
    process.exit(hasError ? 1 : 0);
  } else {
    console.error('Usage: migration-repair-guard.ts check <version>');
    console.error('       migration-repair-guard.ts validate-allowlist');
    process.exit(1);
  }
}
