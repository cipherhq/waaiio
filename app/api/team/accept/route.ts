import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';

// GET /api/team/accept?token=xxx — get invite details
export async function GET(request: NextRequest) {
  const token = request.nextUrl.searchParams.get('token');
  if (!token) return NextResponse.json({ error: 'Missing token' }, { status: 400 });

  const service = createServiceClient();
  const { data: member } = await service
    .from('business_members')
    .select('id, email, role, status, invited_at, business_id')
    .eq('invite_token', token)
    .maybeSingle();

  if (!member) return NextResponse.json({ error: 'Invalid or expired invitation', expired: true }, { status: 404 });
  if (member.status !== 'invited') return NextResponse.json({ error: 'Invitation already accepted' }, { status: 400 });

  // Check if expired (7 days)
  const invitedAt = new Date(member.invited_at);
  if (Date.now() - invitedAt.getTime() > 7 * 24 * 60 * 60 * 1000) {
    return NextResponse.json({ error: 'Invitation has expired', expired: true }, { status: 410 });
  }

  const { data: biz } = await service.from('businesses').select('name').eq('id', member.business_id).single();

  return NextResponse.json({
    business_name: biz?.name || 'Business',
    role: member.role,
    email: member.email,
  });
}

// POST /api/team/accept — accept the invitation
export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Please log in first' }, { status: 401 });

  const { token } = await request.json();
  if (!token) return NextResponse.json({ error: 'Missing token' }, { status: 400 });

  const service = createServiceClient();
  const { data: member } = await service
    .from('business_members')
    .select('id, email, role, status, invited_at, business_id')
    .eq('invite_token', token)
    .maybeSingle();

  if (!member) return NextResponse.json({ error: 'Invalid invitation' }, { status: 404 });
  if (member.status !== 'invited') return NextResponse.json({ error: 'Already accepted' }, { status: 400 });

  // Check expiry
  const invitedAt = new Date(member.invited_at);
  if (Date.now() - invitedAt.getTime() > 7 * 24 * 60 * 60 * 1000) {
    return NextResponse.json({ error: 'Invitation has expired' }, { status: 410 });
  }

  // Activate membership
  await service.from('business_members').update({
    user_id: user.id,
    status: 'active',
    joined_at: new Date().toISOString(),
    invite_token: null, // clear token after use
    updated_at: new Date().toISOString(),
  }).eq('id', member.id);

  const { data: biz } = await service.from('businesses').select('name').eq('id', member.business_id).single();

  return NextResponse.json({
    success: true,
    business_name: biz?.name,
    role: member.role,
  });
}
