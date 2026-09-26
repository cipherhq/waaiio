import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

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

  // Fail closed: required identity fields must be present and well-formed
  if (!sha || sha.length < 7) {
    return NextResponse.json(
      { error: 'Missing or malformed deployment SHA' },
      { status: 500, headers: { 'Cache-Control': 'no-store' } },
    );
  }
  if (!projectId) {
    return NextResponse.json(
      { error: 'Missing deployment project identity' },
      { status: 500, headers: { 'Cache-Control': 'no-store' } },
    );
  }
  if (!deploymentId) {
    return NextResponse.json(
      { error: 'Missing deployment identity' },
      { status: 500, headers: { 'Cache-Control': 'no-store' } },
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
