import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { logger } from '@/lib/logger';

export async function GET() {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { data: reseller } = await supabase
      .from('resellers')
      .select('id')
      .eq('user_id', user.id)
      .maybeSingle();

    if (!reseller) {
      return NextResponse.json({ error: 'Reseller profile not found' }, { status: 404 });
    }

    const { data: invoices, error } = await supabase
      .from('reseller_invoices')
      .select('id, amount, description, status, due_date, paid_at, period_start, period_end, line_items, created_at')
      .eq('reseller_id', reseller.id)
      .order('created_at', { ascending: false });

    if (error) {
      logger.error('Failed to fetch reseller invoices', { error });
      return NextResponse.json({ error: 'Failed to load invoices' }, { status: 500 });
    }

    return NextResponse.json({ invoices: invoices || [] });
  } catch (err) {
    logger.error('GET /api/reseller/invoices error', { error: err });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
