import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { randomBytes } from 'crypto';
import { logger } from '@/lib/logger';

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}

export async function OPTIONS() {
  return NextResponse.json({}, { headers: corsHeaders() });
}

export async function POST(request: NextRequest) {
  // Auth from header (admin app sends Bearer token)
  const authHeader = request.headers.get('Authorization');
  const token = authHeader?.replace('Bearer ', '');

  const supabase = createServiceClient();

  // Verify the token by getting the user from Supabase auth
  let user: { id: string; email?: string } | null = null;
  if (token) {
    const { data } = await supabase.auth.getUser(token);
    user = data?.user || null;
  }
  if (!user) {
    // Fallback: try cookie-based auth
    const { createClient } = await import('@/lib/supabase/server');
    const cookieSupabase = await createClient();
    const { data: { user: cookieUser } } = await cookieSupabase.auth.getUser();
    user = cookieUser;
  }
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: corsHeaders() });
  }

  // Verify admin or support role
  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .maybeSingle();

  if (!profile || !['admin', 'support'].includes(profile.role)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: corsHeaders() });
  }

  const body = await request.json();
  const { business_id } = body;

  if (!business_id) {
    return NextResponse.json({ error: 'Missing business_id' }, { status: 400, headers: corsHeaders() });
  }

  // Verify the business exists
  const { data: business } = await supabase
    .from('businesses')
    .select('id, name')
    .eq('id', business_id)
    .maybeSingle();

  if (!business) {
    return NextResponse.json({ error: 'Business not found' }, { status: 404, headers: corsHeaders() });
  }

  try {
    // Generate a 64-character hex token
    const token = randomBytes(32).toString('hex');

    // Insert token with 30-minute expiry
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000);

    const { error: insertError } = await supabase
      .from('admin_impersonation_tokens')
      .insert({
        admin_id: user.id,
        business_id: business.id,
        token,
        expires_at: expiresAt.toISOString(),
      });

    if (insertError) {
      logger.error('Failed to create impersonation token:', insertError.message);
      return NextResponse.json({ error: 'Failed to create token' }, { status: 500, headers: corsHeaders() });
    }

    // Log to impersonation_logs
    await supabase.from('impersonation_logs').insert({
      admin_id: user.id,
      admin_email: user.email || '',
      target_business_id: business.id,
      target_business_name: business.name,
      action: 'login_as_token_generated',
      changes: null,
    });

    const appUrl = process.env.NEXT_PUBLIC_APP_URL || '';
    const url = `${appUrl}/dashboard/impersonate?token=${token}`;

    return NextResponse.json({ url }, { headers: corsHeaders() });
  } catch (error) {
    logger.error('Impersonate token error:', (error as Error).message);
    return NextResponse.json({ error: 'Failed to generate impersonation token' }, { status: 500, headers: corsHeaders() });
  }
}
