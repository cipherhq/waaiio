import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get('code');
  const token_hash = searchParams.get('token_hash');
  const type = searchParams.get('type') as 'signup' | 'email' | 'recovery' | 'invite' | 'magiclink' | undefined;
  const rawNext = searchParams.get('next') || '/get-started';
  // Prevent open redirect — only allow relative paths, not protocol-relative or absolute URLs
  const next = (rawNext.startsWith('/') && !rawNext.startsWith('//')) ? rawNext : '/get-started';

  const supabase = await createClient();

  if (code) {
    await supabase.auth.exchangeCodeForSession(code);
  } else if (token_hash && type) {
    await supabase.auth.verifyOtp({ token_hash, type });
  }

  return NextResponse.redirect(new URL(next, request.url));
}
