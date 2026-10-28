/**
 * Report templates for Phase 2 staging execution.
 *
 * Generates the four mandatory documents from actual execution traces:
 * 1. Master summary (Markdown + JSON)
 * 2. Per-customer chronological log (Markdown + JSONL)
 * 3. Defect register
 * 4. Safety/cleanup manifest
 *
 * All templates are labeled SAMPLE until actual execution data is available.
 */

// ── Types ──

export type DefectClassification =
  | 'CONFIRMED BUG'
  | 'EXPECTED BEHAVIOR'
  | 'TEST DATA ISSUE'
  | 'NEEDS FURTHER EVIDENCE'
  | 'BLOCKED';

export type DefectSeverity = 'P0' | 'P1' | 'P2' | 'P3';

export interface DefectEntry {
  id: string;
  classification: DefectClassification;
  severity?: DefectSeverity;
  business: string;
  customerId: string;
  scenario: string;
  firstFailingStep: number;
  stepName: string;
  expected: string;
  actual: string;
  sourcePath: string;
  sha: string;
  reproduction: string;
  evidence: string[];
  impact: string;
  proposedFix: string;
  ownerLane: string;
}

export interface RunSummary {
  runId: string;
  deploymentSha: string;
  timestamp: string;
  businesses: Array<{ id: string; name: string; category: string; country: string }>;
  totalCustomers: number;
  executed: number;
  passed: number;
  failed: number;
  blocked: number;
  defects: DefectEntry[];
  blockedCapabilities: string[];
  performanceSummary: {
    medianResponseMs: number;
    p95ResponseMs: number;
    p99ResponseMs: number;
    errorRate: number;
  };
}

// ── Template generators ──

export function generateMasterSummaryMarkdown(summary: RunSummary): string {
  const lines: string[] = [];
  lines.push('# Synthetic E2E Staging Run — Master Summary');
  lines.push('');
  lines.push('> **SAMPLE** — This template shows the structure. Actual data from execution.');
  lines.push('');
  lines.push(`| Item | Value |`);
  lines.push(`|------|-------|`);
  lines.push(`| Run ID | \`${summary.runId}\` |`);
  lines.push(`| Deployment SHA | \`${summary.deploymentSha}\` |`);
  lines.push(`| Timestamp | ${summary.timestamp} |`);
  lines.push(`| Businesses | ${summary.businesses.length} |`);
  lines.push(`| Total Customers | ${summary.totalCustomers} |`);
  lines.push(`| Executed | ${summary.executed} |`);
  lines.push(`| Passed | ${summary.passed} |`);
  lines.push(`| Failed | ${summary.failed} |`);
  lines.push(`| Blocked | ${summary.blocked} |`);
  lines.push('');
  lines.push('## Business Results');
  lines.push('');
  lines.push('| # | Business | Category | Country | Customers |');
  lines.push('|---|----------|----------|---------|-----------|');
  for (let i = 0; i < summary.businesses.length; i++) {
    const b = summary.businesses[i];
    lines.push(`| ${i + 1} | ${b.name} | ${b.category} | ${b.country} | 100 |`);
  }
  lines.push('');

  if (summary.defects.length > 0) {
    lines.push('## Defect Summary');
    lines.push('');
    lines.push('| # | Classification | Severity | Business | Scenario | First Fail |');
    lines.push('|---|---------------|----------|----------|----------|------------|');
    for (let i = 0; i < summary.defects.length; i++) {
      const d = summary.defects[i];
      lines.push(`| ${i + 1} | ${d.classification} | ${d.severity || '-'} | ${d.business} | ${d.scenario} | Step ${d.firstFailingStep} |`);
    }
  }

  if (summary.blockedCapabilities.length > 0) {
    lines.push('');
    lines.push('## Blocked Capabilities');
    lines.push('');
    for (const cap of summary.blockedCapabilities) {
      lines.push(`- ${cap}`);
    }
  }

  return lines.join('\n');
}

export function generateDefectRegisterMarkdown(defects: DefectEntry[]): string {
  const lines: string[] = [];
  lines.push('# Defect Register');
  lines.push('');
  lines.push('> **SAMPLE** — Populated from actual execution traces.');
  lines.push('');

  for (const d of defects) {
    lines.push(`## ${d.id}: ${d.scenario}`);
    lines.push('');
    lines.push(`- **Classification:** ${d.classification}`);
    lines.push(`- **Severity:** ${d.severity || 'Unclassified'}`);
    lines.push(`- **Business:** ${d.business}`);
    lines.push(`- **Customer:** ${d.customerId}`);
    lines.push(`- **First Failing Step:** ${d.firstFailingStep} — ${d.stepName}`);
    lines.push(`- **Expected:** ${d.expected}`);
    lines.push(`- **Actual:** ${d.actual}`);
    lines.push(`- **Source:** \`${d.sourcePath}\` at SHA \`${d.sha}\``);
    lines.push(`- **Reproduction:** ${d.reproduction}`);
    lines.push(`- **Impact:** ${d.impact}`);
    lines.push(`- **Proposed Fix:** ${d.proposedFix}`);
    lines.push(`- **Owner Lane:** ${d.ownerLane}`);
    if (d.evidence.length > 0) {
      lines.push(`- **Evidence:**`);
      for (const e of d.evidence) {
        lines.push(`  - ${e}`);
      }
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Generate a SAMPLE master summary for documentation purposes.
 */
export function generateSampleSummary(): RunSummary {
  return {
    runId: 'synth-e2e-SAMPLE-00000000',
    deploymentSha: '39d86a93f65ca5e38d52e37f5b29a9675a68d4bc',
    timestamp: new Date().toISOString(),
    businesses: [
      { id: 'SAMPLE-B1', name: 'SynthShop-NG', category: 'shop', country: 'NG' },
      { id: 'SAMPLE-B2', name: 'SynthBarber-US', category: 'barber', country: 'US' },
      { id: 'SAMPLE-B3', name: 'SynthEvents-NG', category: 'event_planner', country: 'NG' },
      { id: 'SAMPLE-B4', name: 'SynthStays-US', category: 'hospitality', country: 'US' },
      { id: 'SAMPLE-B5', name: 'SynthDining-US', category: 'restaurant', country: 'US' },
    ],
    totalCustomers: 500,
    executed: 0,
    passed: 0,
    failed: 0,
    blocked: 200, // B3 (100) + B5 table seating (10) + M471 cases
    defects: [],
    blockedCapabilities: [
      'Ticketing (M470 missing)',
      'Navigation cancel (M471 missing)',
      'Table seating (M472 missing)',
    ],
    performanceSummary: {
      medianResponseMs: 0,
      p95ResponseMs: 0,
      p99ResponseMs: 0,
      errorRate: 0,
    },
  };
}
