import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

const ERR_HEADERS = { 'Cache-Control': 'no-store' } as const;
const SHA_RE = /^[0-9a-f]{40}$/;
const SUPABASE_REF_RE = /^[a-z]{20}$/;

/**
 * GET /api/release-identity
 *
 * Returns non-secret deployment metadata for post-deploy verification.
 * Fails closed (500) if required identity fields are missing/malformed.
 * Never exposes secrets, tokens, provider keys, or DB credentials.
 */
export async function GET() {
  const sha = process.env.VERCEL_GIT_COMMIT_SHA || '';
  const projectId = process.env.VERCEL_PROJECT_ID || '';
  const deploymentId = process.env.VERCEL_DEPLOYMENT_ID || '';
  const vercelEnv = process.env.VERCEL_ENV || '';

  // Strict validation: SHA must be exactly 40 hex chars
  if (!SHA_RE.test(sha)) {
    return NextResponse.json(
      { error: 'Missing or malformed deployment SHA' },
      { status: 500, headers: ERR_HEADERS },
    );
  }

  // Project ID must have prj_ prefix
  if (!projectId.startsWith('prj_')) {
    return NextResponse.json(
      { error: 'Missing or malformed deployment project identity' },
      { status: 500, headers: ERR_HEADERS },
    );
  }

  // Deployment ID must have dpl_ prefix
  if (!deploymentId.startsWith('dpl_')) {
    return NextResponse.json(
      { error: 'Missing or malformed deployment identity' },
      { status: 500, headers: ERR_HEADERS },
    );
  }

  // Vercel env must be a known value
  if (!vercelEnv || !['production', 'preview', 'development'].includes(vercelEnv)) {
    return NextResponse.json(
      { error: 'Missing or invalid VERCEL_ENV' },
      { status: 500, headers: ERR_HEADERS },
    );
  }

  // Supabase project ref — derived from the same NEXT_PUBLIC_SUPABASE_URL
  // used by lib/supabase/server.ts and lib/supabase/service.ts.
  // Reports only the 20-char project ref (already public), never keys.
  // Parsed with URL constructor and validated with anchored hostname match
  // to prevent substring/suffix spoofing (e.g. ref.supabase.co.evil.com).
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
  let supabaseProjectRef = '';
  try {
    const parsed = new URL(supabaseUrl);
    if (parsed.protocol !== 'https:') {
      return NextResponse.json(
        { error: 'NEXT_PUBLIC_SUPABASE_URL must use HTTPS' },
        { status: 500, headers: ERR_HEADERS },
      );
    }
    // Anchored match: hostname must be exactly <ref>.supabase.co
    const hostMatch = parsed.hostname.match(/^([a-z]{20})\.supabase\.co$/);
    if (!hostMatch) {
      return NextResponse.json(
        { error: 'NEXT_PUBLIC_SUPABASE_URL hostname is not a valid <ref>.supabase.co' },
        { status: 500, headers: ERR_HEADERS },
      );
    }
    supabaseProjectRef = hostMatch[1];
  } catch {
    return NextResponse.json(
      { error: 'NEXT_PUBLIC_SUPABASE_URL is not a valid URL' },
      { status: 500, headers: ERR_HEADERS },
    );
  }

  return NextResponse.json(
    {
      sha,
      projectId,
      deploymentId,
      vercelEnv,
      supabaseProjectRef,
      timestamp: new Date().toISOString(),
    },
    { status: 200, headers: { 'Cache-Control': 'no-store' } },
  );
}
