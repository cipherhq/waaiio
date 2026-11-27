import { NextRequest, NextResponse } from 'next/server';
import { createClient as createSupabaseClient } from '@supabase/supabase-js';
import { createClient } from '@/lib/supabase/server';
import { rateLimitResponseAsync } from '@/lib/rate-limit';
import { logger } from '@/lib/logger';

/**
 * POST /api/account/password — change the signed-in user's password.
 *
 * The current password is confirmed on the server before the new one is set,
 * with a throwaway client (same pattern as /api/payouts/setup) so the user's
 * own session cookies are not rotated. Attempts are limited per user.
 * The minimum length matches the Settings form (6); the form keeps its own
 * checks for a quick answer.
 */

const MIN_LENGTH = 6;
const MAX_ATTEMPTS = 5;
const WINDOW_MS = 15 * 60 * 1000;

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const limited = await rateLimitResponseAsync(`account-password:${user.id}`, MAX_ATTEMPTS, WINDOW_MS);
  if (limited) return limited;

  let body: { currentPassword?: unknown; newPassword?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }
  const { currentPassword, newPassword } = body;

  if (typeof currentPassword !== 'string' || currentPassword.length === 0) {
    return NextResponse.json({ error: 'Please enter your current password.' }, { status: 400 });
  }
  if (typeof newPassword !== 'string' || newPassword.length < MIN_LENGTH) {
    return NextResponse.json({ error: `New password must be at least ${MIN_LENGTH} characters.` }, { status: 400 });
  }

  const identity = user.email ? { email: user.email } : user.phone ? { phone: user.phone } : null;
  if (!identity) {
    return NextResponse.json({ error: 'Your account has no email or phone to confirm the password with.' }, { status: 400 });
  }

  // Confirm the current password with a throwaway client.
  const authCheck = createSupabaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
  const { error: checkError } = await authCheck.auth.signInWithPassword({ ...identity, password: currentPassword });
  if (checkError) {
    return NextResponse.json({ error: 'Current password is incorrect.' }, { status: 403 });
  }
  // End the throwaway session; the user's own session is untouched.
  await authCheck.auth.signOut({ scope: 'local' }).catch(() => {});

  const { error: updateError } = await supabase.auth.updateUser({ password: newPassword });
  if (updateError) {
    logger.withContext({ op: 'account.password', userId: user.id }).warn('[ACCOUNT] password update refused');
    return NextResponse.json({ error: updateError.message || 'Failed to update password.' }, { status: 400 });
  }

  return NextResponse.json({ success: true });
}
