import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { logger } from '@/lib/logger';

export async function GET() {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { data: reseller, error } = await supabase
      .from('resellers')
      .select('*')
      .eq('user_id', user.id)
      .maybeSingle();

    if (error) {
      logger.error('[RESELLER] Profile fetch error:', error.message);
      return NextResponse.json({ error: 'Failed to fetch reseller profile' }, { status: 500 });
    }

    if (!reseller) {
      return NextResponse.json({ error: 'Reseller profile not found' }, { status: 404 });
    }

    return NextResponse.json({ reseller });
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
