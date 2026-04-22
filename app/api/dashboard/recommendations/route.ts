import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { generateRecommendations } from '@/lib/intelligence/recommendations';

export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data: business } = await supabase
    .from('businesses')
    .select('id')
    .eq('owner_id', user.id)
    .in('status', ['active', 'pending'])
    .limit(1)
    .maybeSingle();

  if (!business) return NextResponse.json({ recommendations: [] });

  const recommendations = await generateRecommendations(supabase, business.id);
  return NextResponse.json({ recommendations });
}
