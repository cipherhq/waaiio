import { NextResponse } from 'next/server';
import { isSignupOpen } from '@/lib/signup-gate';

/**
 * GET /api/auth/signup-status
 *
 * Returns whether public signup is currently open.
 * Used by the onboarding wizard for client-side gate check.
 * Server-side enforcement at creation boundaries is the real security layer.
 */
export async function GET() {
  const open = await isSignupOpen();
  return NextResponse.json({ signup_open: open });
}
