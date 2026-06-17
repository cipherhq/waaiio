import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { logger } from '@/lib/logger';
import { isCampaignKeywordBlacklisted } from '@/lib/bot/campaign-blacklist';

type Params = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, { params }: Params) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  // Load campaign
  const { data: campaign } = await supabase
    .from('keyword_campaigns')
    .select('*')
    .eq('id', id)
    .single();
  if (!campaign) return NextResponse.json({ error: 'Campaign not found' }, { status: 404 });

  // Verify ownership
  const { data: biz } = await supabase
    .from('businesses')
    .select('id')
    .eq('id', campaign.business_id)
    .eq('owner_id', user.id)
    .single();
  if (!biz) return NextResponse.json({ error: 'Not authorized' }, { status: 403 });

  // Get response count
  const { count } = await supabase
    .from('keyword_campaign_responses')
    .select('*', { count: 'exact', head: true })
    .eq('campaign_id', id);

  return NextResponse.json({
    campaign: { ...campaign, response_count: count || 0 },
  });
}

export async function PATCH(request: NextRequest, { params }: Params) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  // Load existing campaign
  const { data: existing } = await supabase
    .from('keyword_campaigns')
    .select('*')
    .eq('id', id)
    .single();
  if (!existing) return NextResponse.json({ error: 'Campaign not found' }, { status: 404 });

  // Verify ownership
  const { data: biz } = await supabase
    .from('businesses')
    .select('id')
    .eq('id', existing.business_id)
    .eq('owner_id', user.id)
    .single();
  if (!biz) return NextResponse.json({ error: 'Not authorized' }, { status: 403 });

  const body = await request.json();
  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };

  // Allowed fields
  const allowedFields = [
    'name', 'keyword', 'description', 'response_type', 'response_text',
    'response_media_url', 'is_active', 'starts_at', 'ends_at', 'opt_in_message',
  ] as const;

  for (const field of allowedFields) {
    if (body[field] !== undefined) {
      updates[field] = body[field];
    }
  }

  // If keyword is being changed, validate blacklist
  if (body.keyword !== undefined) {
    const newKeyword = (body.keyword as string).toLowerCase().trim();
    if (isCampaignKeywordBlacklisted(newKeyword)) {
      return NextResponse.json(
        { error: `The keyword "${newKeyword}" is reserved and cannot be used for campaigns` },
        { status: 400 },
      );
    }
    updates.keyword = newKeyword;
  }

  // Validate response_type if changed
  if (body.response_type !== undefined) {
    const validTypes = ['text', 'image', 'link', 'buttons'];
    if (!validTypes.includes(body.response_type)) {
      return NextResponse.json({ error: 'Invalid response_type' }, { status: 400 });
    }
  }

  const { data: campaign, error } = await supabase
    .from('keyword_campaigns')
    .update(updates)
    .eq('id', id)
    .select()
    .single();

  if (error) {
    if (error.code === '23505') {
      return NextResponse.json({ error: 'A campaign with this keyword already exists for this business' }, { status: 409 });
    }
    logger.error('[KEYWORD_CAMPAIGNS] Update error:', error.message);
    return NextResponse.json({ error: 'Update failed' }, { status: 500 });
  }

  // Sync bot_keywords if keyword or is_active changed
  if (body.keyword !== undefined || body.is_active !== undefined) {
    const kwUpdates: Record<string, unknown> = {};
    if (body.keyword !== undefined) {
      kwUpdates.keyword = (body.keyword as string).toLowerCase().trim();
    }
    if (body.is_active !== undefined) {
      kwUpdates.is_active = body.is_active;
    }
    if (body.keyword !== undefined) {
      kwUpdates.description = `Campaign: ${campaign.name}`;
    }

    const { error: kwError } = await supabase
      .from('bot_keywords')
      .update(kwUpdates)
      .eq('campaign_id', id);

    if (kwError) {
      logger.error('[KEYWORD_CAMPAIGNS] bot_keywords sync error:', kwError.message);
    }
  }

  return NextResponse.json({ campaign });
}

export async function DELETE(request: NextRequest, { params }: Params) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  // Load campaign
  const { data: campaign } = await supabase
    .from('keyword_campaigns')
    .select('business_id')
    .eq('id', id)
    .single();
  if (!campaign) return NextResponse.json({ error: 'Campaign not found' }, { status: 404 });

  // Verify ownership
  const { data: biz } = await supabase
    .from('businesses')
    .select('id')
    .eq('id', campaign.business_id)
    .eq('owner_id', user.id)
    .single();
  if (!biz) return NextResponse.json({ error: 'Not authorized' }, { status: 403 });

  // CASCADE handles bot_keywords and responses
  await supabase.from('keyword_campaigns').delete().eq('id', id);
  return NextResponse.json({ success: true });
}
