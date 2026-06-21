import { NextResponse, type NextRequest } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { logger } from '@/lib/logger';

/**
 * GET /api/reseller/setup?token=xxx
 * Validates an invite token and returns reseller info for the setup wizard.
 */
export async function GET(request: NextRequest) {
  try {
    const token = request.nextUrl.searchParams.get('token');
    if (!token) {
      return NextResponse.json({ error: 'Missing token' }, { status: 400 });
    }

    const supabase = createServiceClient();

    const { data: reseller, error } = await supabase
      .from('resellers')
      .select('id, company_name, tier, branding')
      .eq('invite_token', token)
      .maybeSingle();

    if (error) {
      logger.error('[RESELLER_SETUP] Token lookup error:', error.message);
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }

    if (!reseller) {
      return NextResponse.json({ error: 'Invalid or expired invite token' }, { status: 404 });
    }

    return NextResponse.json({
      reseller_id: reseller.id,
      company_name: reseller.company_name,
      tier: reseller.tier,
      branding: reseller.branding,
    });
  } catch (err) {
    logger.error('[RESELLER_SETUP] GET error:', (err as Error).message);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

/**
 * POST /api/reseller/setup
 * Completes reseller onboarding: updates branding, optionally creates a first business.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { token, company_name, branding, first_account } = body as {
      token: string;
      company_name: string;
      branding?: { logo_url?: string; primary_color?: string; accent_color?: string };
      first_account?: { name: string; category: string; email: string; country_code: string };
    };

    if (!token) {
      return NextResponse.json({ error: 'Missing token' }, { status: 400 });
    }

    if (!company_name?.trim()) {
      return NextResponse.json({ error: 'Company name is required' }, { status: 400 });
    }

    const supabase = createServiceClient();

    // Validate token and get reseller
    const { data: reseller, error: lookupError } = await supabase
      .from('resellers')
      .select('id, user_id, max_sub_accounts')
      .eq('invite_token', token)
      .maybeSingle();

    if (lookupError) {
      logger.error('[RESELLER_SETUP] Token lookup error:', lookupError.message);
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }

    if (!reseller) {
      return NextResponse.json({ error: 'Invalid or expired invite token' }, { status: 404 });
    }

    // Update reseller: save branding, mark as onboarded, consume token
    const { error: updateError } = await supabase
      .from('resellers')
      .update({
        company_name: company_name.trim(),
        branding: branding || {},
        onboarded_at: new Date().toISOString(),
        invite_token: null,
      })
      .eq('id', reseller.id);

    if (updateError) {
      logger.error('[RESELLER_SETUP] Update error:', updateError.message);
      return NextResponse.json({ error: 'Failed to complete setup' }, { status: 500 });
    }

    // Optionally create first business (same pattern as POST /api/reseller/accounts)
    let business = null;
    if (first_account) {
      const { name, category, email, country_code } = first_account;

      if (!name || !category || !email || !country_code) {
        return NextResponse.json(
          { error: 'First account requires: name, category, email, country_code' },
          { status: 400 },
        );
      }

      const slug = name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 60);

      const { data: created, error: createError } = await supabase
        .from('businesses')
        .insert({
          name,
          category,
          email,
          country_code,
          subscription_tier: 'free',
          flow_type: 'booking',
          reseller_id: reseller.id,
          owner_id: reseller.user_id,
          slug,
          status: 'active',
        })
        .select()
        .single();

      if (createError) {
        // Log but don't fail the entire setup — branding is already saved
        logger.error('[RESELLER_SETUP] Business create error:', createError.message);
      } else {
        business = created;
      }
    }

    return NextResponse.json({
      success: true,
      reseller_id: reseller.id,
      business,
    });
  } catch (err) {
    logger.error('[RESELLER_SETUP] POST error:', (err as Error).message);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
