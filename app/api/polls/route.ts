import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { logger } from '@/lib/logger';

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const businessId = request.nextUrl.searchParams.get('business_id');
  if (!businessId) return NextResponse.json({ error: 'Missing business_id' }, { status: 400 });

  const { data: biz } = await supabase.from('businesses').select('id').eq('id', businessId).eq('owner_id', user.id).single();
  if (!biz) return NextResponse.json({ error: 'Business not found' }, { status: 404 });

  const { data: polls } = await supabase
    .from('polls')
    .select('*')
    .eq('business_id', businessId)
    .order('created_at', { ascending: false });

  const response = NextResponse.json({ polls: polls || [] });
  response.headers.set('Cache-Control', 'private, max-age=30, stale-while-revalidate=120');
  return response;
}

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await request.json();
  const { business_id, question, options, allow_change_vote, show_results, closes_at } = body as {
    business_id: string;
    question: string;
    options: string[];
    allow_change_vote?: boolean;
    show_results?: string;
    closes_at?: string;
  };

  if (!business_id || !question || !options?.length || options.length < 2) {
    return NextResponse.json({ error: 'Need business_id, question, and at least 2 options' }, { status: 400 });
  }
  if (options.length > 10) {
    return NextResponse.json({ error: 'Maximum 10 options' }, { status: 400 });
  }

  const { data: biz } = await supabase.from('businesses').select('id').eq('id', business_id).eq('owner_id', user.id).single();
  if (!biz) return NextResponse.json({ error: 'Business not found' }, { status: 404 });

  const { data: poll, error } = await supabase
    .from('polls')
    .insert({
      business_id,
      question,
      options,
      status: 'draft',
      allow_change_vote: allow_change_vote || false,
      show_results: show_results || 'after_vote',
      closes_at: closes_at || null,
    })
    .select()
    .single();

  if (error) {
    logger.error('[POLLS] Create error:', error.message);
    return NextResponse.json({ error: 'Failed to create poll' }, { status: 500 });
  }

  return NextResponse.json({ poll }, { status: 201 });
}
