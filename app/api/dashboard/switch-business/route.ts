import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { businessId } = await request.json();

  if (!businessId || typeof businessId !== 'string') {
    return NextResponse.json({ error: 'Missing businessId' }, { status: 400 });
  }

  // Verify ownership — user must own this business
  const { data: business } = await supabase
    .from('businesses')
    .select('id')
    .eq('id', businessId)
    .eq('owner_id', user.id)
    .in('status', ['active', 'pending'])
    .maybeSingle();

  if (!business) {
    return NextResponse.json({ error: 'Business not found' }, { status: 404 });
  }

  // Set cookie for server-side layout to read
  const response = NextResponse.json({ switched: true });
  response.cookies.set('waaiio_business_id', businessId, {
    path: '/',
    maxAge: 60 * 60 * 24 * 365, // 1 year
    httpOnly: false, // Client needs to read it for optimistic UI
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
  });

  return response;
}
