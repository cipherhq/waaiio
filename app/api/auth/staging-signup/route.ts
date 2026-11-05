import { createHash, timingSafeEqual } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { getRateLimitKey, rateLimitResponseAsync } from '@/lib/rate-limit';
import { isStagingTestMode } from '@/lib/staging-test-mode';

// Staging sign-up needs the invite code the Owner gives to testers. If the code
// is not configured (or too short to be safe), sign-up stays closed.
const MIN_INVITE_CODE_LENGTH = 16;

function inviteCodeMatches(given: unknown, configured: string): boolean {
  if (typeof given !== 'string') return false;
  const digest = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(given.trim()), digest(configured));
}

export async function POST(request: NextRequest) {
  if (!isStagingTestMode()) {
    return new NextResponse(null, { status: 404 });
  }

  let body: { email?: unknown; password?: unknown; inviteCode?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ message: 'Invalid request.' }, { status: 400 });
  }

  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const password = typeof body.password === 'string' ? body.password : '';

  if (!email || !email.includes('@')) {
    return NextResponse.json({ message: 'Enter a valid email address.' }, { status: 400 });
  }
  if (password.length < 6) {
    return NextResponse.json({ message: 'Password must be at least 6 characters.' }, { status: 400 });
  }

  const limit = await rateLimitResponseAsync(
    getRateLimitKey(request, 'staging-email-signup'),
    20,
    60 * 60 * 1000,
  );
  if (limit) return limit;

  const configuredCode = (process.env.STAGING_SIGNUP_INVITE_CODE || '').trim();
  if (configuredCode.length < MIN_INVITE_CODE_LENGTH) {
    return NextResponse.json({ message: 'Staging sign-up is closed. Ask the Waaiio team for access.' }, { status: 403 });
  }
  if (!inviteCodeMatches(body.inviteCode, configuredCode)) {
    return NextResponse.json({ message: 'That invite code is not valid.' }, { status: 403 });
  }

  const service = createServiceClient();
  const { error } = await service.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });

  if (error) {
    const message = String(error.message || '').toLowerCase();
    const alreadyExists = message.includes('already') || message.includes('registered');

    return NextResponse.json(
      {
        message: alreadyExists
          ? 'An account with this email already exists. Sign in instead.'
          : 'Unable to create staging account.',
      },
      { status: alreadyExists ? 409 : 400 },
    );
  }

  return NextResponse.json({ created: true }, { status: 201 });
}
