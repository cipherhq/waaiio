import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { logger } from '@/lib/logger';

// GET /api/surveys — list surveys for a business
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const businessId = request.nextUrl.searchParams.get('business_id');
  if (!businessId) return NextResponse.json({ error: 'Missing business_id' }, { status: 400 });

  // Verify ownership
  const { data: biz } = await supabase
    .from('businesses')
    .select('id')
    .eq('id', businessId)
    .eq('owner_id', user.id)
    .single();
  if (!biz) return NextResponse.json({ error: 'Business not found' }, { status: 404 });

  const { data: surveys, error } = await supabase
    .from('surveys')
    .select('*')
    .eq('business_id', businessId)
    .order('created_at', { ascending: false });

  if (error) {
    logger.error('[SURVEYS] List error:', error.message);
    return NextResponse.json({ error: 'Failed to fetch surveys' }, { status: 500 });
  }

  return NextResponse.json({ surveys: surveys || [] });
}

// POST /api/surveys — create a new survey
export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await request.json();
  const { business_id, title, description, questions } = body as {
    business_id: string;
    title: string;
    description?: string;
    questions: Array<{ id: string; type: string; text: string; options?: string[]; required?: boolean }>;
  };

  if (!business_id || !title || !questions?.length) {
    return NextResponse.json({ error: 'Missing required fields: business_id, title, questions' }, { status: 400 });
  }

  // Validate questions
  const validTypes = ['choice', 'rating', 'text', 'yes_no'];
  for (const q of questions) {
    if (!q.id || !q.type || !q.text) {
      return NextResponse.json({ error: 'Each question must have id, type, and text' }, { status: 400 });
    }
    if (!validTypes.includes(q.type)) {
      return NextResponse.json({ error: `Invalid question type: ${q.type}` }, { status: 400 });
    }
    if (q.type === 'choice' && (!q.options || q.options.length < 2)) {
      return NextResponse.json({ error: 'Choice questions must have at least 2 options' }, { status: 400 });
    }
  }

  // Verify ownership
  const { data: biz } = await supabase
    .from('businesses')
    .select('id')
    .eq('id', business_id)
    .eq('owner_id', user.id)
    .single();
  if (!biz) return NextResponse.json({ error: 'Business not found' }, { status: 404 });

  const { data: survey, error } = await supabase
    .from('surveys')
    .insert({
      business_id,
      title,
      description: description || null,
      questions,
      status: 'draft',
    })
    .select()
    .single();

  if (error) {
    logger.error('[SURVEYS] Create error:', error.message);
    return NextResponse.json({ error: 'Failed to create survey' }, { status: 500 });
  }

  return NextResponse.json({ survey }, { status: 201 });
}
