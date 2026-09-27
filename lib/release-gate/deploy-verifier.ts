/**
 * Release Gate V2 — Deploy Verifier
 *
 * Post-deploy verification: confirms the running runtime matches
 * the certified release SHA, correct project identity, healthy
 * critical services, and GET-only canary routes respond.
 *
 * Makes only GET requests. No POST/provider/auth/mutation calls.
 */

// ═══════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════

export interface VerifyInput {
  targetUrl: string;
  expectedSha: string;
  expectedProject: string;
  expectedDeploymentId?: string;
  timeoutMs?: number;
}

export interface VerifyResult {
  verdict: 'PASS' | 'FAIL' | 'WARN';
  checks: CheckResult[];
  summary: string;
}

export interface CheckResult {
  name: string;
  status: 'pass' | 'fail' | 'warn';
  detail: string;
}

// ═══════════════════════════════════════════════════════════════════
// HTTP fetch with timeout
// ═══════════════════════════════════════════════════════════════════

interface FetchResult {
  ok: boolean;
  status: number;
  body: string;
  error?: string;
}

export async function fetchWithTimeout(
  url: string,
  timeoutMs: number,
): Promise<FetchResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      redirect: 'manual',
      headers: { 'Accept': 'application/json' },
    });
    const body = await res.text();
    return { ok: res.ok, status: res.status, body };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown';
    if (message.includes('abort')) {
      return { ok: false, status: 0, body: '', error: `Timeout after ${timeoutMs}ms` };
    }
    return { ok: false, status: 0, body: '', error: message };
  } finally {
    clearTimeout(timer);
  }
}

// ═══════════════════════════════════════════════════════════════════
// Identity verification
// ═══════════════════════════════════════════════════════════════════

interface ReleaseIdentity {
  sha: string;
  projectId: string;
  deploymentId: string;
  vercelEnv: string;
  timestamp: string;
}

const SHA_RE = /^[0-9a-f]{40}$/;
const VALID_VERCEL_ENVS = new Set(['production', 'preview', 'development']);

function isValidISOTimestamp(value: string): boolean {
  const d = new Date(value);
  if (isNaN(d.getTime())) return false;
  // Round-trip: a valid ISO string must re-serialize to itself (or a canonical equivalent)
  // Reject impossible dates and trailing junk by checking the parse result is sane
  return d.toISOString() === value;
}

export function parseIdentity(body: string): ReleaseIdentity | null {
  try {
    const json = JSON.parse(body);
    if (typeof json.sha !== 'string' || !SHA_RE.test(json.sha)) return null;
    if (typeof json.projectId !== 'string' || !json.projectId.startsWith('prj_')) return null;
    if (typeof json.deploymentId !== 'string' || !json.deploymentId.startsWith('dpl_')) return null;
    if (typeof json.vercelEnv !== 'string' || !VALID_VERCEL_ENVS.has(json.vercelEnv)) return null;
    if (typeof json.timestamp !== 'string' || !isValidISOTimestamp(json.timestamp)) return null;
    return json as ReleaseIdentity;
  } catch {
    return null;
  }
}

async function checkIdentity(
  targetUrl: string,
  expectedSha: string,
  expectedProject: string,
  timeoutMs: number,
  expectedDeploymentId?: string,
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  const res = await fetchWithTimeout(`${targetUrl}/api/release-identity`, timeoutMs);

  if (res.error) {
    results.push({ name: 'identity-reachable', status: 'fail', detail: `Unreachable: ${res.error}` });
    return results;
  }

  if (res.status >= 500) {
    results.push({ name: 'identity-reachable', status: 'fail', detail: `Server error: HTTP ${res.status}` });
    return results;
  }

  if (res.status === 404) {
    results.push({ name: 'identity-reachable', status: 'fail', detail: 'Endpoint not found (404) — release-identity not deployed' });
    return results;
  }

  if (!res.ok) {
    results.push({ name: 'identity-reachable', status: 'fail', detail: `Unexpected HTTP ${res.status}` });
    return results;
  }

  results.push({ name: 'identity-reachable', status: 'pass', detail: `HTTP ${res.status}` });

  const identity = parseIdentity(res.body);
  if (!identity) {
    results.push({ name: 'identity-parseable', status: 'fail', detail: 'Malformed identity JSON — missing required fields' });
    return results;
  }

  results.push({ name: 'identity-parseable', status: 'pass', detail: 'Valid identity JSON' });

  // SHA comparison
  if (identity.sha === expectedSha) {
    results.push({ name: 'sha-match', status: 'pass', detail: `SHA matches: ${expectedSha.substring(0, 8)}` });
  } else {
    results.push({ name: 'sha-match', status: 'fail', detail: `SHA mismatch: expected ${expectedSha.substring(0, 8)}, got ${identity.sha.substring(0, 8)}` });
  }

  // Project comparison
  if (identity.projectId === expectedProject) {
    results.push({ name: 'project-match', status: 'pass', detail: `Project matches: ${expectedProject}` });
  } else {
    results.push({ name: 'project-match', status: 'fail', detail: `Project mismatch: expected ${expectedProject}, got ${identity.projectId}` });
  }

  // Deployment ID comparison (optional — only when expected ID is provided)
  if (expectedDeploymentId) {
    if (identity.deploymentId === expectedDeploymentId) {
      results.push({ name: 'deployment-id-match', status: 'pass', detail: `Deployment ID matches: ${expectedDeploymentId}` });
    } else {
      results.push({ name: 'deployment-id-match', status: 'fail', detail: `Deployment ID mismatch: expected ${expectedDeploymentId}, got ${identity.deploymentId}` });
    }
  }

  return results;
}

// ═══════════════════════════════════════════════════════════════════
// Health verification
// ═══════════════════════════════════════════════════════════════════

async function checkHealth(
  targetUrl: string,
  timeoutMs: number,
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  const res = await fetchWithTimeout(`${targetUrl}/api/health`, timeoutMs);

  if (res.error) {
    results.push({ name: 'health-reachable', status: 'fail', detail: `Unreachable: ${res.error}` });
    return results;
  }

  results.push({ name: 'health-reachable', status: 'pass', detail: `HTTP ${res.status}` });

  let parsed: { status?: string } = {};
  try { parsed = JSON.parse(res.body); } catch { /* use empty */ }

  if (res.status === 503 || parsed.status === 'critical') {
    results.push({ name: 'health-status', status: 'fail', detail: `Critical: HTTP ${res.status}, status=${parsed.status || 'unknown'}` });
  } else if (parsed.status === 'degraded') {
    results.push({ name: 'health-status', status: 'warn', detail: 'Degraded: non-critical services may be down' });
  } else if (parsed.status === 'ok') {
    results.push({ name: 'health-status', status: 'pass', detail: 'All services healthy' });
  } else {
    results.push({ name: 'health-status', status: 'fail', detail: `Unexpected health response: HTTP ${res.status}, status=${parsed.status || 'missing'}` });
  }

  return results;
}

// ═══════════════════════════════════════════════════════════════════
// GET-only canary
// ═══════════════════════════════════════════════════════════════════

const CANARY_ROUTES = [
  { path: '/', expect: 'Waaiio' },
  { path: '/pricing', expect: 'Starter|pricing' },
  { path: '/features', expect: 'Features' },
  { path: '/login', expect: 'Sign' },
  { path: '/terms', expect: '' },
  { path: '/privacy', expect: '' },
];

async function checkCanary(
  targetUrl: string,
  timeoutMs: number,
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  for (const route of CANARY_ROUTES) {
    const res = await fetchWithTimeout(`${targetUrl}${route.path}`, timeoutMs);

    if (res.error) {
      results.push({ name: `canary:${route.path}`, status: 'fail', detail: `Unreachable: ${res.error}` });
      continue;
    }

    // Require 2xx — any non-2xx (3xx redirect, 4xx, 5xx) is a failure
    if (res.status < 200 || res.status >= 300) {
      results.push({ name: `canary:${route.path}`, status: 'fail', detail: `Non-2xx response: HTTP ${res.status}` });
      continue;
    }

    if (route.expect) {
      const pattern = new RegExp(route.expect, 'i');
      if (!pattern.test(res.body)) {
        results.push({ name: `canary:${route.path}`, status: 'fail', detail: `Content check failed: expected /${route.expect}/i` });
        continue;
      }
    }

    results.push({ name: `canary:${route.path}`, status: 'pass', detail: `HTTP ${res.status}` });
  }

  return results;
}

// ═══════════════════════════════════════════════════════════════════
// Main verifier
// ═══════════════════════════════════════════════════════════════════

export async function verifyDeployment(input: VerifyInput): Promise<VerifyResult> {
  const { targetUrl, expectedSha, expectedProject, timeoutMs = 10000 } = input;
  const base = targetUrl.replace(/\/+$/, '');

  const allChecks: CheckResult[] = [];

  // Phase 1: Identity
  const identityChecks = await checkIdentity(base, expectedSha, expectedProject, timeoutMs, input.expectedDeploymentId);
  allChecks.push(...identityChecks);

  // Phase 2: Health
  const healthChecks = await checkHealth(base, timeoutMs);
  allChecks.push(...healthChecks);

  // Phase 3: Canary (only if identity and health passed)
  const hasFail = allChecks.some(c => c.status === 'fail');
  if (!hasFail) {
    const canaryChecks = await checkCanary(base, timeoutMs);
    allChecks.push(...canaryChecks);
  }

  const fails = allChecks.filter(c => c.status === 'fail');
  const warns = allChecks.filter(c => c.status === 'warn');

  let verdict: VerifyResult['verdict'] = 'PASS';
  if (fails.length > 0) verdict = 'FAIL';
  else if (warns.length > 0) verdict = 'WARN';

  const summary = verdict === 'PASS'
    ? `All ${allChecks.length} checks passed`
    : verdict === 'WARN'
      ? `${allChecks.length} checks: ${warns.length} warning(s)`
      : `${allChecks.length} checks: ${fails.length} failure(s)`;

  return { verdict, checks: allChecks, summary };
}
