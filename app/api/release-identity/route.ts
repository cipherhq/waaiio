import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

const ERR_HEADERS = { 'Cache-Control': 'no-store' } as const;
const SHA_RE = /^[0-9a-f]{40}$/;

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

  return NextResponse.json(
    {
      sha,
      projectId,
      deploymentId,
      vercelEnv,
      timestamp: new Date().toISOString(),
    },
    { status: 200, headers: { 'Cache-Control': 'no-store' } },
  );
}
