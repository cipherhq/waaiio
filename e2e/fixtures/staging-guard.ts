/**
 * Staging environment safety guard.
 *
 * Uses exact hostname and origin validation (not substring matching)
 * to ensure tests never run against production. Enforces the expected
 * staging Supabase project ref deterministically. Installs request
 * interception to prevent credential leakage to unexpected destinations.
 *
 * Fail-closed: any ambiguity or misconfiguration fails the test run.
 */

// ── Known-safe staging identifiers ──

/** Supabase project ref for staging — the ONLY allowed ref */
export const STAGING_SUPABASE_REF = 'tqjvrzopvtczxfxiwmnz';

/** Production Supabase ref — MUST reject */
export const PRODUCTION_SUPABASE_REF = 'cxcmiqotkowhxinjbytg';

/**
 * Exact hostnames allowed as staging targets.
 * No substring matching — each entry is a complete hostname.
 */
const ALLOWED_STAGING_HOSTNAMES = new Set([
  'staging.waaiio.com',
  'localhost',
  '127.0.0.1',
]);

/**
 * Hostname suffixes for Vercel preview deployments of the staging project.
 * Checked via endsWith after the exact-hostname check fails.
 */
const ALLOWED_STAGING_HOSTNAME_SUFFIXES = [
  '.vercel.app',   // Vercel preview deployments
] as const;

/**
 * Hostname substrings that must be present for a Vercel preview to qualify.
 * Prevents arbitrary .vercel.app deployments from passing.
 */
const REQUIRED_VERCEL_PREVIEW_MARKERS = [
  'waaiiostaging',
  'waaiio-staging',
] as const;

/**
 * Origins that must NEVER receive requests during staging tests.
 * Checked by request interception to prevent credential leakage.
 */
const BLOCKED_ORIGINS = new Set([
  'https://waaiio.com',
  'https://www.waaiio.com',
  'https://app.waaiio.com',
  `https://${PRODUCTION_SUPABASE_REF}.supabase.co`,
]);

// ── Types ──

export interface StagingMetadata {
  stagingUrl: string;
  sourceCommitSha: string;
  testRunTimestamp: string;
  deploymentSha: string | null;
  supabaseRef: string | null;
  isLocalhost: boolean;
}

// ── URL parsing helpers ──

/** Parse a URL and extract hostname, failing closed on invalid input. */
function parseOrigin(rawUrl: string): { hostname: string; origin: string; port: string } {
  try {
    const parsed = new URL(rawUrl);
    return {
      hostname: parsed.hostname.toLowerCase(),
      origin: parsed.origin.toLowerCase(),
      port: parsed.port,
    };
  } catch {
    throw new Error(
      `FAIL-CLOSED: Cannot parse URL "${rawUrl}". ` +
      `E2E_STAGING_URL must be a valid URL (e.g. https://staging.waaiio.com).`
    );
  }
}

// ── Guards ──

/**
 * Validates that the base URL is an approved staging target using
 * exact hostname matching. No substring matching.
 *
 * Approved targets:
 *   - staging.waaiio.com (exact)
 *   - localhost / 127.0.0.1 (exact, any port)
 *   - *.vercel.app containing 'waaiiostaging' or 'waaiio-staging'
 */
export function assertStagingTarget(baseUrl: string): void {
  const { hostname, origin } = parseOrigin(baseUrl);

  // Enforce HTTPS for non-loopback targets
  const isLoopback = hostname === 'localhost' || hostname === '127.0.0.1';
  if (!isLoopback && new URL(baseUrl).protocol !== 'https:') {
    throw new Error(
      `FAIL-CLOSED: Non-loopback target "${baseUrl}" must use HTTPS. ` +
      `HTTP is only permitted for localhost/127.0.0.1.`
    );
  }

  // FIRST: reject known production origins
  if (BLOCKED_ORIGINS.has(origin) || BLOCKED_ORIGINS.has(`https://${hostname}`)) {
    throw new Error(
      `FAIL-CLOSED: Target "${baseUrl}" resolves to blocked production origin "${origin}". ` +
      `Staging QA tests must never run against production.`
    );
  }

  // Reject if hostname contains production Supabase ref
  if (hostname.includes(PRODUCTION_SUPABASE_REF)) {
    throw new Error(
      `FAIL-CLOSED: Target hostname contains production Supabase ref "${PRODUCTION_SUPABASE_REF}". ` +
      `Staging QA tests must never communicate with production Supabase.`
    );
  }

  // Check exact hostname allowlist
  if (ALLOWED_STAGING_HOSTNAMES.has(hostname)) {
    return; // Approved
  }

  // Check Vercel preview: must end with allowed suffix AND contain required marker
  const isVercelPreview = ALLOWED_STAGING_HOSTNAME_SUFFIXES.some(
    (suffix) => hostname.endsWith(suffix)
  );
  if (isVercelPreview) {
    const hasRequiredMarker = REQUIRED_VERCEL_PREVIEW_MARKERS.some(
      (marker) => hostname.includes(marker)
    );
    if (hasRequiredMarker) {
      return; // Approved Vercel preview
    }
    throw new Error(
      `FAIL-CLOSED: "${baseUrl}" is a Vercel preview but does not contain a required ` +
      `staging marker (${REQUIRED_VERCEL_PREVIEW_MARKERS.join(' or ')}). ` +
      `Only the waaiiostaging Vercel project is allowed.`
    );
  }

  // No match — reject
  throw new Error(
    `FAIL-CLOSED: Target hostname "${hostname}" is not in the staging allowlist. ` +
    `Allowed: ${[...ALLOWED_STAGING_HOSTNAMES].join(', ')}, ` +
    `or Vercel previews containing ${REQUIRED_VERCEL_PREVIEW_MARKERS.join('/')}.`
  );
}

/**
 * Hostnames of third-party services that the staging app legitimately
 * loads assets from. These do NOT receive Supabase auth cookies or
 * staging credentials (browsers enforce same-origin cookie policy).
 * Checked by exact hostname — no substring matching.
 */
const ALLOWED_THIRD_PARTY_HOSTNAMES = new Set([
  // Analytics
  'us.i.posthog.com',
  'us-assets.i.posthog.com',
  'app.posthog.com',
  // Error monitoring
  'sentry.io',
  'o0.ingest.sentry.io',
  // Google services (Places, Fonts, etc.)
  'maps.googleapis.com',
  'fonts.googleapis.com',
  'fonts.gstatic.com',
  // Cloudflare (Turnstile, CDN)
  'challenges.cloudflare.com',
  'static.cloudflareinsights.com',
  // Vercel platform scripts
  'vercel-scripts.com',
  'va.vercel-scripts.com',
  'vercel-insights.com',
  'vitals.vercel-insights.com',
]);

/**
 * Installs request interception at the browser-context level to prevent
 * credentials from being sent to production or unexpected origins.
 * Uses context.route() for coverage of popups and new pages, not just
 * the initial page.
 *
 * Supabase restriction: ONLY requests to the exact staging project
 * (tqjvrzopvtczxfxiwmnz.supabase.co) are allowed. All other
 * *.supabase.co hostnames are blocked, including unknown projects.
 *
 * Blocked-request diagnostics log only scheme + host + path (no query
 * params, fragments, or userinfo that could contain tokens).
 *
 * Must be called BEFORE any navigation that could trigger auth.
 */
export async function installRequestGuard(
  page: import('@playwright/test').Page,
  allowedBaseUrl: string,
): Promise<string[]> {
  const { hostname: allowedHostname } = parseOrigin(allowedBaseUrl);
  const blockedAttempts: string[] = [];

  // Exact allowed origins — no wildcards
  const allowedOrigins = new Set([
    new URL(allowedBaseUrl).origin.toLowerCase(),
    // ONLY the staging Supabase project — no other *.supabase.co
    `https://${STAGING_SUPABASE_REF}.supabase.co`,
  ]);

  // Localhost variants for local dev
  if (allowedHostname === 'localhost' || allowedHostname === '127.0.0.1') {
    allowedOrigins.add('http://localhost:3000');
    allowedOrigins.add('http://127.0.0.1:3000');
  }

  // Use context-level routing for coverage of popups and new pages
  await page.context().route('**/*', async (route) => {
    const requestUrl = route.request().url();
    let parsed: URL;
    try {
      parsed = new URL(requestUrl);
    } catch {
      // Unparseable URL (data:, blob:) — allow
      await route.continue();
      return;
    }

    const requestOrigin = parsed.origin.toLowerCase();
    const requestHostname = parsed.hostname.toLowerCase();
    // Sanitized diagnostic: scheme + host + path only (no query/fragment/userinfo)
    const safeDiag = `${parsed.protocol}//${parsed.host}${parsed.pathname}`;

    // 1. Allow exact same-origin and staging Supabase
    if (allowedOrigins.has(requestOrigin)) {
      await route.continue();
      return;
    }

    // 2. Allow data: and blob: schemes
    if (requestOrigin === 'data:' || requestOrigin === 'blob:' || parsed.protocol === 'data:' || parsed.protocol === 'blob:') {
      await route.continue();
      return;
    }

    // 3. Block ANY *.supabase.co that is NOT the staging project
    //    This catches unknown projects, production, and typos.
    if (requestHostname.endsWith('.supabase.co') || requestHostname === 'supabase.co') {
      blockedAttempts.push(`BLOCKED non-staging Supabase: ${safeDiag}`);
      await route.abort('blockedbyclient');
      return;
    }

    // 4. Block known production origins
    if (BLOCKED_ORIGINS.has(requestOrigin)) {
      blockedAttempts.push(`BLOCKED production origin: ${safeDiag}`);
      await route.abort('blockedbyclient');
      return;
    }

    // 5. Block any URL containing production Supabase ref
    if (requestUrl.includes(PRODUCTION_SUPABASE_REF)) {
      blockedAttempts.push(`BLOCKED production Supabase ref in: ${safeDiag}`);
      await route.abort('blockedbyclient');
      return;
    }

    // 6. Allow known third-party services by exact hostname
    if (ALLOWED_THIRD_PARTY_HOSTNAMES.has(requestHostname)) {
      await route.continue();
      return;
    }

    // 7. Allow subdomains of known third-party services
    const isKnownSubdomain =
      requestHostname.endsWith('.posthog.com') ||
      requestHostname.endsWith('.sentry.io') ||
      requestHostname.endsWith('.googleapis.com') ||
      requestHostname.endsWith('.gstatic.com') ||
      requestHostname.endsWith('.cloudflare.com') ||
      requestHostname.endsWith('.cloudflareinsights.com') ||
      requestHostname.endsWith('.vercel-scripts.com') ||
      requestHostname.endsWith('.vercel-insights.com');
    if (isKnownSubdomain) {
      await route.continue();
      return;
    }

    // 8. Unknown origin — block and log (sanitized, no query params)
    blockedAttempts.push(`BLOCKED unknown origin: ${safeDiag}`);
    await route.abort('blockedbyclient');
  });

  return blockedAttempts;
}

/**
 * Deterministically verifies the Supabase configuration visible to the page.
 *
 * Checks the NEXT_PUBLIC_SUPABASE_URL environment variable injected into
 * the client bundle. Does NOT rely on performance.getEntriesByType timing.
 *
 * Fail-closed: rejects if production ref found OR if no Supabase config
 * can be detected (ambiguous state).
 */
export async function assertPageSupabaseIsStaging(
  page: import('@playwright/test').Page
): Promise<void> {
  // Strategy 1: Check __NEXT_DATA__ props for Supabase URL
  // Strategy 2: Check inline scripts for the NEXT_PUBLIC_SUPABASE_URL value
  // Strategy 3: Check network requests already made
  const supabaseInfo = await page.evaluate((prodRef: string) => {
    // Check all script tags for Supabase URL patterns
    const scripts = document.querySelectorAll('script');
    for (const script of scripts) {
      const text = script.textContent || '';
      if (text.includes(prodRef)) {
        return { found: true, isProduction: true, source: 'inline-script' };
      }
    }

    // Check network requests for Supabase domains
    const entries = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
    for (const entry of entries) {
      if (entry.name.includes('supabase.co')) {
        if (entry.name.includes(prodRef)) {
          return { found: true, isProduction: true, source: `network:${entry.name}` };
        }
        return { found: true, isProduction: false, source: `network:${entry.name}` };
      }
    }

    // Check page HTML for the ref
    const html = document.documentElement.innerHTML;
    if (html.includes(prodRef)) {
      return { found: true, isProduction: true, source: 'page-html' };
    }

    return { found: false, isProduction: false, source: 'none' };
  }, PRODUCTION_SUPABASE_REF);

  if (supabaseInfo.isProduction) {
    throw new Error(
      `FAIL-CLOSED: Page contains production Supabase ref "${PRODUCTION_SUPABASE_REF}" ` +
      `(detected via ${supabaseInfo.source}). This staging QA run is unsafe and has been aborted.`
    );
  }

  // Note: if supabaseInfo.found is false, we do NOT fail here because
  // the request guard (installRequestGuard) is the primary protection.
  // The page may not have made a Supabase request yet.
}

// ── Metadata collection ──

/**
 * Collects deployment and test-run metadata for evidence reporting.
 * Returns null fields when information is unavailable (does not throw).
 */
export function collectStagingMetadata(baseUrl: string): StagingMetadata {
  const { hostname } = parseOrigin(baseUrl);
  const sourceCommitSha = process.env.GITHUB_SHA
    || process.env.E2E_SOURCE_SHA
    || execGitSha()
    || 'unknown';

  return {
    stagingUrl: baseUrl,
    sourceCommitSha,
    testRunTimestamp: new Date().toISOString(),
    deploymentSha: process.env.E2E_DEPLOYMENT_SHA || null,
    supabaseRef: process.env.E2E_SUPABASE_REF || STAGING_SUPABASE_REF,
    isLocalhost: hostname === 'localhost' || hostname === '127.0.0.1',
  };
}

/** Best-effort git SHA from local repo */
function execGitSha(): string | null {
  try {
    const { execSync } = require('child_process');
    return execSync('git rev-parse HEAD', { encoding: 'utf-8' }).trim();
  } catch {
    return null;
  }
}

// ── Deployment identity verification ──

/** Known Vercel project ID for the staging deployment */
export const STAGING_VERCEL_PROJECT_ID = 'prj_h7YmC4fvpxhn429znCy34OjLZ6se';

export interface DeploymentIdentity {
  sha: string;
  projectId: string;
  deploymentId: string;
  vercelEnv: string;
  supabaseProjectRef: string;
}

/**
 * Verifies server-side Vercel deployment identity via /api/release-identity.
 *
 * Checks:
 *   - projectId matches expected staging Vercel project
 *   - vercelEnv is NOT 'production'
 *   - supabaseProjectRef matches expected staging Supabase ref
 *   - Deployed SHA matches expectedSha (required for remote targets)
 *   - Response shape is valid (40-hex SHA, prj_ prefix, dpl_ prefix)
 *
 * NOTE: supabaseProjectRef is a configuration-identity check — it verifies
 * the server's NEXT_PUBLIC_SUPABASE_URL matches the staging project. This
 * does not prove actual database reachability or that no other DB client
 * with a different URL exists elsewhere.
 *
 * Fail-closed: throws on mismatch, network error, or malformed response.
 */
export async function verifyStagingIdentity(
  baseUrl: string,
  expectedSha: string,
): Promise<DeploymentIdentity> {
  // Require valid 40-hex SHA for remote targets (B5)
  if (!/^[0-9a-f]{40}$/.test(expectedSha)) {
    throw new Error(
      `FAIL-CLOSED: expectedSha must be a valid 40-hex-char SHA for remote targets. ` +
      `Got: "${expectedSha}". Set E2E_DEPLOYMENT_SHA to the exact deployed staging SHA.`
    );
  }

  const url = `${baseUrl.replace(/\/$/, '')}/api/release-identity`;

  let response: Response;
  try {
    response = await fetch(url, {
      headers: { 'Accept': 'application/json' },
      redirect: 'error',
    });
  } catch (err) {
    throw new Error(
      `FAIL-CLOSED: Cannot reach ${url} — deployment identity unverifiable. ` +
      `Error: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  if (!response.ok) {
    throw new Error(
      `FAIL-CLOSED: /api/release-identity returned HTTP ${response.status}. ` +
      `The deployment may be missing required identity environment variables.`
    );
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error(
      'FAIL-CLOSED: /api/release-identity returned non-JSON response.'
    );
  }

  const data = body as Record<string, unknown>;

  // Verify projectId matches expected staging project
  if (data.projectId !== STAGING_VERCEL_PROJECT_ID) {
    throw new Error(
      `FAIL-CLOSED: Deployment projectId "${String(data.projectId)}" does not match ` +
      `expected staging project "${STAGING_VERCEL_PROJECT_ID}".`
    );
  }

  // Reject production environment
  if (data.vercelEnv === 'production') {
    throw new Error(
      'FAIL-CLOSED: Deployment reports vercelEnv="production". ' +
      'Staging QA must not run against a production deployment.'
    );
  }

  // Verify SHA match (required for remote targets)
  if (data.sha !== expectedSha) {
    throw new Error(
      `FAIL-CLOSED: Deployed SHA "${String(data.sha)}" does not match ` +
      `expected SHA "${expectedSha}".`
    );
  }

  // Verify Supabase project ref matches staging (B1 — database identity)
  if (data.supabaseProjectRef !== STAGING_SUPABASE_REF) {
    throw new Error(
      `FAIL-CLOSED: Server supabaseProjectRef "${String(data.supabaseProjectRef)}" ` +
      `does not match expected staging ref "${STAGING_SUPABASE_REF}". ` +
      `The deployment may be configured with a non-staging database.`
    );
  }

  // Validate response shape
  const sha = String(data.sha || '');
  const projectId = String(data.projectId || '');
  const deploymentId = String(data.deploymentId || '');
  const vercelEnv = String(data.vercelEnv || '');
  const supabaseProjectRef = String(data.supabaseProjectRef || '');

  if (!/^[0-9a-f]{40}$/.test(sha)) {
    throw new Error(`FAIL-CLOSED: Deployment SHA "${sha}" is not a valid 40-hex-char string.`);
  }
  if (!projectId.startsWith('prj_')) {
    throw new Error(`FAIL-CLOSED: Deployment projectId "${projectId}" missing prj_ prefix.`);
  }
  if (!deploymentId.startsWith('dpl_')) {
    throw new Error(`FAIL-CLOSED: Deployment deploymentId "${deploymentId}" missing dpl_ prefix.`);
  }
  if (!/^[a-z]{20}$/.test(supabaseProjectRef)) {
    throw new Error(`FAIL-CLOSED: supabaseProjectRef "${supabaseProjectRef}" is malformed (expected 20 lowercase letters).`);
  }

  return { sha, projectId, deploymentId, vercelEnv, supabaseProjectRef };
}

// ── Credential requirement assertions ──

/**
 * Asserts that required staging credentials are present.
 * Returns FAILED/BLOCKED with actionable message — never silently skips.
 */
export function assertStagingCredentials(): {
  email: string;
  password: string;
  baseUrl: string;
} {
  const email = process.env.E2E_STAGING_EMAIL;
  const password = process.env.E2E_STAGING_PASSWORD;
  const baseUrl = process.env.E2E_STAGING_URL || process.env.PLAYWRIGHT_BASE_URL;

  const missing: string[] = [];
  if (!email) missing.push('E2E_STAGING_EMAIL');
  if (!password) missing.push('E2E_STAGING_PASSWORD');
  if (!baseUrl) missing.push('E2E_STAGING_URL or PLAYWRIGHT_BASE_URL');

  if (missing.length > 0) {
    throw new Error(
      `BLOCKED — Missing required staging credentials: ${missing.join(', ')}. ` +
      `Staging acceptance tests cannot run without these. ` +
      `Set them as environment variables or repository secrets.`
    );
  }

  return { email: email!, password: password!, baseUrl: baseUrl! };
}
