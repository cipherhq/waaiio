/**
 * Chronological audit logger for synthetic E2E test runs.
 *
 * Produces two output formats:
 * 1. Human-readable Markdown journey logs
 * 2. Machine-readable JSONL event traces
 *
 * Issue #728 requirement D:
 * - Immutable run_id and linked journey_id
 * - Step number, UTC timestamp, duration
 * - Webpage URL, click/field, webhook type, bot reply
 * - DB verification (expected vs actual), assertion PASS/FAIL
 * - Links to screenshots/traces
 * - Sensitive info redaction
 */

import { writeFileSync, mkdirSync, appendFileSync } from 'fs';
import { join } from 'path';

// ── Types ──

export type EventType =
  | 'run_start'
  | 'run_end'
  | 'journey_start'
  | 'journey_end'
  | 'step_start'
  | 'step_end'
  | 'browser_navigate'
  | 'browser_click'
  | 'browser_fill'
  | 'browser_screenshot'
  | 'webhook_send'
  | 'webhook_response'
  | 'bot_reply_captured'
  | 'db_assertion'
  | 'cleanup_action'
  | 'error'
  | 'warning'
  | 'performance_metric';

export interface AuditEvent {
  schemaVersion: '1.0.0';
  runId: string;
  journeyId: string;
  stepIndex: number;
  eventType: EventType;
  timestamp: string;
  durationMs?: number;
  data: Record<string, unknown>;
  /** PASS, FAIL, or SKIP */
  outcome?: 'PASS' | 'FAIL' | 'SKIP';
  /** Reference to artifact (screenshot path, trace file, etc.) */
  artifactRef?: string;
}

export interface JourneyStep {
  index: number;
  name: string;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  outcome: 'PASS' | 'FAIL' | 'SKIP' | 'PENDING';
  events: AuditEvent[];
  screenshotPath?: string;
}

export interface JourneyLog {
  runId: string;
  journeyId: string;
  persona: string;
  scenario: string;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  outcome: 'PASS' | 'FAIL' | 'PARTIAL' | 'PENDING';
  steps: JourneyStep[];
  metadata: Record<string, unknown>;
}

// ── Redaction ──

const REDACT_PATTERNS = [
  // Passwords
  { pattern: /password["']?\s*[:=]\s*["'][^"']+["']/gi, replacement: 'password: "[REDACTED]"' },
  // API keys / tokens
  { pattern: /(?:sk_|pk_|Bearer\s+)[a-zA-Z0-9_-]{10,}/g, replacement: '[REDACTED_KEY]' },
  // Email addresses (keep synthetic ones)
  { pattern: /(?!synth-e2e)[a-zA-Z0-9._%+-]+@(?!test\.waaiio\.internal)[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, replacement: '[REDACTED_EMAIL]' },
  // Phone numbers (keep synthetic 1555000 prefix)
  { pattern: /(?<!\d)(?!1555000)\+?\d{10,15}(?!\d)/g, replacement: '[REDACTED_PHONE]' },
];

export function redactSensitive(input: string): string {
  let result = input;
  for (const { pattern, replacement } of REDACT_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

// ── Logger ──

export class AuditLogger {
  private events: AuditEvent[] = [];
  private journeys: Map<string, JourneyLog> = new Map();
  private outputDir: string;
  private jsonlPath: string;

  constructor(
    private runId: string,
    outputDir?: string,
  ) {
    this.outputDir = outputDir || join(process.cwd(), 'synthetic-e2e', 'reports', runId);
    mkdirSync(this.outputDir, { recursive: true });
    this.jsonlPath = join(this.outputDir, 'events.jsonl');
  }

  /**
   * Record an event and append to JSONL.
   */
  log(event: Omit<AuditEvent, 'schemaVersion' | 'timestamp'>): AuditEvent {
    const full: AuditEvent = {
      ...event,
      schemaVersion: '1.0.0',
      timestamp: new Date().toISOString(),
    };
    this.events.push(full);

    // Append to JSONL file immediately for durability
    const line = JSON.stringify(full) + '\n';
    appendFileSync(this.jsonlPath, redactSensitive(line));

    // Add to journey if tracked
    const journey = this.journeys.get(event.journeyId);
    if (journey) {
      const step = journey.steps[event.stepIndex];
      if (step) {
        step.events.push(full);
      }
    }

    return full;
  }

  /**
   * Start tracking a new journey.
   */
  startJourney(params: {
    journeyId: string;
    persona: string;
    scenario: string;
    metadata?: Record<string, unknown>;
  }): JourneyLog {
    const journey: JourneyLog = {
      runId: this.runId,
      journeyId: params.journeyId,
      persona: params.persona,
      scenario: params.scenario,
      startedAt: new Date().toISOString(),
      outcome: 'PENDING',
      steps: [],
      metadata: params.metadata || {},
    };
    this.journeys.set(params.journeyId, journey);

    this.log({
      runId: this.runId,
      journeyId: params.journeyId,
      stepIndex: -1,
      eventType: 'journey_start',
      data: { persona: params.persona, scenario: params.scenario },
    });

    return journey;
  }

  /**
   * End a journey and compute its outcome.
   */
  endJourney(journeyId: string, outcome: JourneyLog['outcome']): void {
    const journey = this.journeys.get(journeyId);
    if (!journey) return;

    journey.endedAt = new Date().toISOString();
    journey.durationMs = new Date(journey.endedAt).getTime() - new Date(journey.startedAt).getTime();
    journey.outcome = outcome;

    this.log({
      runId: this.runId,
      journeyId,
      stepIndex: -1,
      eventType: 'journey_end',
      data: { outcome, durationMs: journey.durationMs },
      outcome: outcome === 'PASS' ? 'PASS' : outcome === 'FAIL' ? 'FAIL' : 'SKIP',
    });
  }

  /**
   * Start a new step within a journey.
   */
  startStep(journeyId: string, name: string): number {
    const journey = this.journeys.get(journeyId);
    if (!journey) throw new Error(`Journey ${journeyId} not found`);

    const index = journey.steps.length;
    journey.steps.push({
      index,
      name,
      startedAt: new Date().toISOString(),
      outcome: 'PENDING',
      events: [],
    });

    this.log({
      runId: this.runId,
      journeyId,
      stepIndex: index,
      eventType: 'step_start',
      data: { name },
    });

    return index;
  }

  /**
   * End a step with its outcome.
   */
  endStep(journeyId: string, stepIndex: number, outcome: 'PASS' | 'FAIL' | 'SKIP'): void {
    const journey = this.journeys.get(journeyId);
    if (!journey) return;

    const step = journey.steps[stepIndex];
    if (!step) return;

    step.endedAt = new Date().toISOString();
    step.durationMs = new Date(step.endedAt).getTime() - new Date(step.startedAt).getTime();
    step.outcome = outcome;

    this.log({
      runId: this.runId,
      journeyId,
      stepIndex,
      eventType: 'step_end',
      data: { name: step.name, durationMs: step.durationMs },
      outcome,
    });
  }

  /**
   * Generate a human-readable Markdown report for a journey.
   */
  generateMarkdownReport(journeyId: string): string {
    const journey = this.journeys.get(journeyId);
    if (!journey) return `# Journey ${journeyId} — NOT FOUND\n`;

    const lines: string[] = [];
    lines.push(`# Journey: ${journey.scenario}`);
    lines.push(`**Persona:** ${journey.persona}`);
    lines.push(`**Journey ID:** ${journey.journeyId}`);
    lines.push(`**Run ID:** ${journey.runId}`);
    lines.push(`**Started:** ${journey.startedAt}`);
    lines.push(`**Ended:** ${journey.endedAt || 'In Progress'}`);
    lines.push(`**Duration:** ${journey.durationMs ? `${journey.durationMs}ms` : 'N/A'}`);
    lines.push(`**Outcome:** ${journey.outcome}`);
    lines.push('');
    lines.push('## Steps');
    lines.push('');

    for (const step of journey.steps) {
      const icon = step.outcome === 'PASS' ? 'PASS' : step.outcome === 'FAIL' ? 'FAIL' : 'SKIP';
      lines.push(`### Step ${step.index + 1}: ${step.name} [${icon}]`);
      lines.push(`- **Started:** ${step.startedAt}`);
      lines.push(`- **Duration:** ${step.durationMs ? `${step.durationMs}ms` : 'N/A'}`);
      lines.push('');

      for (const event of step.events) {
        if (event.eventType === 'step_start' || event.eventType === 'step_end') continue;

        const ts = event.timestamp.split('T')[1]?.slice(0, 12) || event.timestamp;
        lines.push(`  - **${ts}** \`${event.eventType}\` ${formatEventData(event)}`);
        if (event.outcome) {
          lines.push(`    - Outcome: **${event.outcome}**`);
        }
        if (event.artifactRef) {
          lines.push(`    - Artifact: [${event.artifactRef}](${event.artifactRef})`);
        }
      }
      lines.push('');
    }

    return redactSensitive(lines.join('\n'));
  }

  /**
   * Generate the master summary report.
   */
  generateSummaryReport(): string {
    const journeys = Array.from(this.journeys.values());
    const passed = journeys.filter(j => j.outcome === 'PASS').length;
    const failed = journeys.filter(j => j.outcome === 'FAIL').length;
    const partial = journeys.filter(j => j.outcome === 'PARTIAL').length;

    const lines: string[] = [];
    lines.push('# Synthetic E2E Test Run Summary');
    lines.push(`**Run ID:** ${this.runId}`);
    lines.push(`**Generated:** ${new Date().toISOString()}`);
    lines.push(`**Total Journeys:** ${journeys.length}`);
    lines.push(`**Passed:** ${passed} | **Failed:** ${failed} | **Partial:** ${partial}`);
    lines.push('');
    lines.push('## Journey Results');
    lines.push('');
    lines.push('| # | Persona | Scenario | Outcome | Duration | Steps |');
    lines.push('|---|---------|----------|---------|----------|-------|');

    for (let i = 0; i < journeys.length; i++) {
      const j = journeys[i];
      const duration = j.durationMs ? `${j.durationMs}ms` : 'N/A';
      const stepSummary = `${j.steps.filter(s => s.outcome === 'PASS').length}/${j.steps.length}`;
      lines.push(`| ${i + 1} | ${j.persona} | ${j.scenario} | ${j.outcome} | ${duration} | ${stepSummary} |`);
    }

    lines.push('');

    // List failures with first failing step
    const failures = journeys.filter(j => j.outcome === 'FAIL');
    if (failures.length > 0) {
      lines.push('## Failures');
      lines.push('');
      for (const j of failures) {
        const firstFail = j.steps.find(s => s.outcome === 'FAIL');
        lines.push(`### ${j.scenario} (${j.persona})`);
        if (firstFail) {
          lines.push(`- **First failing step:** Step ${firstFail.index + 1}: ${firstFail.name}`);
          const failEvents = firstFail.events.filter(e => e.outcome === 'FAIL');
          for (const e of failEvents) {
            lines.push(`  - ${e.eventType}: ${JSON.stringify(e.data)}`);
          }
        }
        lines.push('');
      }
    }

    return redactSensitive(lines.join('\n'));
  }

  /**
   * Write all reports to the output directory.
   */
  writeReports(): string[] {
    const files: string[] = [];

    // Summary
    const summaryPath = join(this.outputDir, 'summary.md');
    writeFileSync(summaryPath, this.generateSummaryReport());
    files.push(summaryPath);

    // Per-journey reports
    for (const [journeyId] of this.journeys) {
      const journeyPath = join(this.outputDir, `journey-${journeyId}.md`);
      writeFileSync(journeyPath, this.generateMarkdownReport(journeyId));
      files.push(journeyPath);
    }

    // Summary JSON
    const summaryJsonPath = join(this.outputDir, 'summary.json');
    const journeys = Array.from(this.journeys.values());
    writeFileSync(summaryJsonPath, redactSensitive(JSON.stringify({
      runId: this.runId,
      generatedAt: new Date().toISOString(),
      totalJourneys: journeys.length,
      passed: journeys.filter(j => j.outcome === 'PASS').length,
      failed: journeys.filter(j => j.outcome === 'FAIL').length,
      journeys: journeys.map(j => ({
        journeyId: j.journeyId,
        persona: j.persona,
        scenario: j.scenario,
        outcome: j.outcome,
        durationMs: j.durationMs,
        stepCount: j.steps.length,
        passedSteps: j.steps.filter(s => s.outcome === 'PASS').length,
      })),
    }, null, 2)));
    files.push(summaryJsonPath);

    return files;
  }

  /**
   * Get all events for a specific run.
   */
  getEvents(): AuditEvent[] {
    return [...this.events];
  }

  /**
   * Get a specific journey log.
   */
  getJourney(journeyId: string): JourneyLog | undefined {
    return this.journeys.get(journeyId);
  }
}

// ── Helpers ──

function formatEventData(event: AuditEvent): string {
  const { data } = event;
  switch (event.eventType) {
    case 'browser_navigate':
      return `→ ${data.url || 'unknown'}`;
    case 'browser_click':
      return `click: ${data.selector || data.text || 'unknown'}`;
    case 'browser_fill':
      return `fill: ${data.field || 'unknown'} = ${data.masked ? '[MASKED]' : data.value}`;
    case 'webhook_send':
      return `POST webhook: ${data.type || 'unknown'} from ${data.from || 'unknown'}`;
    case 'webhook_response':
      return `response: HTTP ${data.status || 'unknown'}`;
    case 'bot_reply_captured':
      return `bot says: "${truncate(String(data.text || ''), 80)}"`;
    case 'db_assertion':
      return `${data.table}.${data.column}: expected=${JSON.stringify(data.expected)}, actual=${JSON.stringify(data.actual)}`;
    default:
      return JSON.stringify(data).slice(0, 100);
  }
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '...' : s;
}
