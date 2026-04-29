import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';

type Params = { params: Promise<{ id: string }> };

// GET /api/surveys/[id]/responses — list responses for a survey
export async function GET(request: NextRequest, { params }: Params) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  // Verify ownership via survey → business → owner
  const { data: survey } = await supabase.from('surveys').select('business_id').eq('id', id).single();
  if (!survey) return NextResponse.json({ error: 'Survey not found' }, { status: 404 });

  const { data: biz } = await supabase
    .from('businesses')
    .select('id')
    .eq('id', survey.business_id)
    .eq('owner_id', user.id)
    .single();
  if (!biz) return NextResponse.json({ error: 'Not authorized' }, { status: 403 });

  const page = parseInt(request.nextUrl.searchParams.get('page') || '1', 10);
  const limit = Math.min(parseInt(request.nextUrl.searchParams.get('limit') || '50', 10), 100);
  const offset = (page - 1) * limit;

  const { data: responses, count } = await supabase
    .from('survey_responses')
    .select('*', { count: 'exact' })
    .eq('survey_id', id)
    .order('started_at', { ascending: false })
    .range(offset, offset + limit - 1);

  return NextResponse.json({
    responses: responses || [],
    total: count || 0,
    page,
    limit,
  });
}
