import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';

type Params = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, { params }: Params) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data: poll } = await supabase.from('polls').select('business_id, options').eq('id', id).single();
  if (!poll) return NextResponse.json({ error: 'Poll not found' }, { status: 404 });

  const { data: biz } = await supabase.from('businesses').select('id').eq('id', poll.business_id).eq('owner_id', user.id).single();
  if (!biz) return NextResponse.json({ error: 'Not authorized' }, { status: 403 });

  const { data: votes } = await supabase
    .from('poll_votes')
    .select('option_index, customer_phone, customer_name, voted_at')
    .eq('poll_id', id)
    .order('voted_at', { ascending: false });

  const options = (poll.options as string[]) || [];
  const counts: Record<number, number> = {};
  options.forEach((_, i) => { counts[i] = 0; });
  for (const v of votes || []) { counts[v.option_index] = (counts[v.option_index] || 0) + 1; }

  const total = (votes || []).length;

  return NextResponse.json({
    results: options.map((opt, i) => ({
      option: opt,
      votes: counts[i] || 0,
      percentage: total > 0 ? Math.round(((counts[i] || 0) / total) * 100) : 0,
    })),
    total_votes: total,
    voters: votes || [],
  });
}
