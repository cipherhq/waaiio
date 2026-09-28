import { NextResponse, type NextRequest } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { getRateLimitKey, rateLimitResponseAsync } from '@/lib/rate-limit';
import { isStagingTestMode } from '@/lib/staging-test-mode';

export async function POST(request: NextRequest) {
  if (!isStagingTestMode()) {
    return new NextResponse(null, { status: 404 });
  }

  let body: { email?: unknown; password?: unknown };
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
