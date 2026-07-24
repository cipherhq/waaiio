import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { logger } from '@/lib/logger';
import { isCampaignKeywordBlacklisted } from '@/lib/bot/campaign-blacklist';

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

  // Fetch campaigns with response count
  const { data: campaigns, error } = await supabase
    .from('keyword_campaigns')
    .select('*, keyword_campaign_responses(count)')
    .eq('business_id', businessId)
    .order('created_at', { ascending: false });

  if (error) {
    logger.error('[KEYWORD_CAMPAIGNS] List error:', error.message);
    return NextResponse.json({ error: 'Failed to fetch campaigns' }, { status: 500 });
  }

  // Flatten response count
  const result = (campaigns || []).map((c) => {
    const responseCount =
      Array.isArray(c.keyword_campaign_responses) && c.keyword_campaign_responses.length > 0
        ? (c.keyword_campaign_responses[0] as { count: number }).count
        : 0;
    const { keyword_campaign_responses: _, ...rest } = c;
    return { ...rest, response_count: responseCount };
  });

  return NextResponse.json({ campaigns: result });
}

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await request.json();
  const {
    business_id,
    name,
    keyword,
    description,
    response_type,
    response_text,
    response_media_url,
    is_active,
    starts_at,
    ends_at,
    opt_in_message,
  } = body as {
    business_id: string;
    name: string;
    keyword: string;
    description?: string;
    response_type?: string;
    response_text: string;
    response_media_url?: string;
    is_active?: boolean;
    starts_at?: string;
    ends_at?: string;
    opt_in_message?: string;
  };

  if (!business_id || !name || !keyword || !response_text) {
    return NextResponse.json({ error: 'Missing required fields: business_id, name, keyword, response_text' }, { status: 400 });
  }

  // Verify ownership
  const { data: biz } = await supabase
    .from('businesses')
    .select('id')
    .eq('id', business_id)
    .eq('owner_id', user.id)
    .single();
  if (!biz) return NextResponse.json({ error: 'Business not found' }, { status: 404 });

  // ── Capability check: crowdfunding ──
  const { data: campaignCap } = await supabase
    .from('business_capabilities')
    .select('id')
    .eq('business_id', business_id)
    .eq('capability_id', 'crowdfunding')
    .eq('is_enabled', true)
    .maybeSingle();
  if (!campaignCap) return NextResponse.json({ error: 'Feature not enabled' }, { status: 403 });

  // Validate keyword not blacklisted
  if (isCampaignKeywordBlacklisted(keyword)) {
    return NextResponse.json(
      { error: `The keyword "${keyword}" is reserved and cannot be used for campaigns` },
      { status: 400 },
    );
  }

  // Validate response_type
  const validTypes = ['text', 'image', 'link', 'buttons'];
  const rType = response_type || 'text';
  if (!validTypes.includes(rType)) {
    return NextResponse.json({ error: 'Invalid response_type' }, { status: 400 });
  }

  // Create campaign
  const { data: campaign, error: campaignError } = await supabase
    .from('keyword_campaigns')
    .insert({
      business_id,
      name,
      keyword: keyword.toLowerCase().trim(),
      description: description || null,
      response_type: rType,
      response_text,
      response_media_url: response_media_url || null,
      is_active: is_active !== false,
      starts_at: starts_at || null,
      ends_at: ends_at || null,
      opt_in_message: opt_in_message || null,
    })
    .select()
    .single();

  if (campaignError) {
    if (campaignError.code === '23505') {
      return NextResponse.json({ error: 'A campaign with this keyword already exists for this business' }, { status: 409 });
    }
    logger.error('[KEYWORD_CAMPAIGNS] Create error:', campaignError.message);
    return NextResponse.json({ error: 'Failed to create campaign' }, { status: 500 });
  }

  // Auto-create bot_keywords row for this campaign
  const { error: kwError } = await supabase
    .from('bot_keywords')
    .insert({
      business_id,
      keyword: keyword.toLowerCase().trim(),
      match_type: 'exact',
      action_type: 'campaign_reply',
      payload: JSON.stringify({ campaign_id: campaign.id }),
      is_active: is_active !== false,
      priority: 5,
      scope: 'business',
      campaign_id: campaign.id,
      description: `Campaign: ${name}`,
    });

  if (kwError) {
    logger.error('[KEYWORD_CAMPAIGNS] bot_keywords insert error:', kwError.message);
    // Campaign was created but keyword failed — clean up
    await supabase.from('keyword_campaigns').delete().eq('id', campaign.id);
    return NextResponse.json({ error: 'Failed to register keyword' }, { status: 500 });
  }

  return NextResponse.json({ campaign }, { status: 201 });
}
