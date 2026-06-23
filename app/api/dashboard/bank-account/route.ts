import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { logger } from '@/lib/logger';

/**
 * GET /api/dashboard/bank-account?business_id=xxx
 * Returns bank accounts for a business (owner-only).
 */
export async function GET(request: NextRequest) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const businessId = request.nextUrl.searchParams.get('business_id');
    if (!businessId) {
      return NextResponse.json({ error: 'business_id is required' }, { status: 400 });
    }

    // Verify ownership
    const { data: business } = await supabase
      .from('businesses')
      .select('id')
      .eq('id', businessId)
      .eq('owner_id', user.id)
      .maybeSingle();

    if (!business) {
      return NextResponse.json({ error: 'Business not found or access denied' }, { status: 403 });
    }

    const service = createServiceClient();
    const { data: accounts, error } = await service
      .from('bank_accounts')
      .select('id, bank_name, account_number, account_name, bank_code, is_default, is_active')
      .eq('business_id', businessId)
      .eq('is_active', true)
      .order('is_default', { ascending: false });

    if (error) {
      logger.error('[BANK_ACCOUNT] GET error:', error.message);
      return NextResponse.json({ error: 'Failed to fetch bank accounts' }, { status: 500 });
    }

    return NextResponse.json({ accounts: accounts || [] });
  } catch (err) {
    logger.error('[BANK_ACCOUNT] GET error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

/**
 * POST /api/dashboard/bank-account
 * Add a new bank account for a business.
 * Requires Growth or Business tier.
 */
export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await request.json();
    const { business_id, bank_name, account_number, account_name, bank_code } = body;

    if (!business_id) {
      return NextResponse.json({ error: 'business_id is required' }, { status: 400 });
    }

    // Verify ownership and get tier
    const { data: business } = await supabase
      .from('businesses')
      .select('id, subscription_tier')
      .eq('id', business_id)
      .eq('owner_id', user.id)
      .maybeSingle();

    if (!business) {
      return NextResponse.json({ error: 'Business not found or access denied' }, { status: 403 });
    }

    // Reject Free tier
    const tier = business.subscription_tier || 'free';
    if (tier === 'free') {
      return NextResponse.json(
        { error: 'Bank account management requires a Growth or Business plan' },
        { status: 403 },
      );
    }

    // Validate fields
    const errors: string[] = [];
    if (!bank_name || typeof bank_name !== 'string' || bank_name.trim().length === 0) {
      errors.push('bank_name is required');
    }
    if (!account_name || typeof account_name !== 'string' || account_name.trim().length === 0) {
      errors.push('account_name is required');
    }
    if (!account_number || typeof account_number !== 'string') {
      errors.push('account_number is required');
    } else if (!/^\d{10}$/.test(account_number)) {
      // 10 digits for NG accounts
      errors.push('account_number must be exactly 10 digits');
    }

    if (errors.length > 0) {
      return NextResponse.json({ error: errors.join('; ') }, { status: 400 });
    }

    const service = createServiceClient();

    // Check if this is the first account (set as default)
    const { count } = await service
      .from('bank_accounts')
      .select('id', { count: 'exact', head: true })
      .eq('business_id', business_id)
      .eq('is_active', true);

    const isFirst = (count ?? 0) === 0;

    const { data: account, error: insertError } = await service
      .from('bank_accounts')
      .insert({
        business_id,
        bank_name: bank_name.trim(),
        account_number,
        account_name: account_name.trim(),
        bank_code: bank_code?.trim() || null,
        is_default: isFirst,
        is_active: true,
      })
      .select('id, bank_name, account_number, account_name, bank_code, is_default, is_active')
      .single();

    if (insertError) {
      logger.error('[BANK_ACCOUNT] POST insert error:', insertError.message);
      return NextResponse.json({ error: 'Failed to add bank account' }, { status: 500 });
    }

    return NextResponse.json({ account }, { status: 201 });
  } catch (err) {
    logger.error('[BANK_ACCOUNT] POST error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

/**
 * PUT /api/dashboard/bank-account
 * Update an existing bank account.
 */
export async function PUT(request: NextRequest) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await request.json();
    const { id, bank_name, account_number, account_name, bank_code, is_default } = body;

    if (!id) {
      return NextResponse.json({ error: 'id is required' }, { status: 400 });
    }

    const service = createServiceClient();

    // Fetch account + verify business ownership
    const { data: existing } = await service
      .from('bank_accounts')
      .select('id, business_id')
      .eq('id', id)
      .eq('is_active', true)
      .maybeSingle();

    if (!existing) {
      return NextResponse.json({ error: 'Bank account not found' }, { status: 404 });
    }

    // Verify ownership
    const { data: business } = await supabase
      .from('businesses')
      .select('id')
      .eq('id', existing.business_id)
      .eq('owner_id', user.id)
      .maybeSingle();

    if (!business) {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 });
    }

    // Validate optional fields
    const errors: string[] = [];
    if (account_number !== undefined && (typeof account_number !== 'string' || !/^\d{10}$/.test(account_number))) {
      errors.push('account_number must be exactly 10 digits');
    }
    if (bank_name !== undefined && (typeof bank_name !== 'string' || bank_name.trim().length === 0)) {
      errors.push('bank_name must be a non-empty string');
    }
    if (account_name !== undefined && (typeof account_name !== 'string' || account_name.trim().length === 0)) {
      errors.push('account_name must be a non-empty string');
    }
    if (errors.length > 0) {
      return NextResponse.json({ error: errors.join('; ') }, { status: 400 });
    }

    // If setting is_default=true, unset other defaults for this business
    if (is_default === true) {
      await service
        .from('bank_accounts')
        .update({ is_default: false })
        .eq('business_id', existing.business_id)
        .eq('is_active', true)
        .neq('id', id);
    }

    // Build update payload (only provided fields)
    const updatePayload: Record<string, unknown> = {};
    if (bank_name !== undefined) updatePayload.bank_name = bank_name.trim();
    if (account_number !== undefined) updatePayload.account_number = account_number;
    if (account_name !== undefined) updatePayload.account_name = account_name.trim();
    if (bank_code !== undefined) updatePayload.bank_code = bank_code?.trim() || null;
    if (is_default !== undefined) updatePayload.is_default = is_default;

    if (Object.keys(updatePayload).length === 0) {
      return NextResponse.json({ error: 'No fields to update' }, { status: 400 });
    }

    const { data: updated, error: updateError } = await service
      .from('bank_accounts')
      .update(updatePayload)
      .eq('id', id)
      .select('id, bank_name, account_number, account_name, bank_code, is_default, is_active')
      .single();

    if (updateError) {
      logger.error('[BANK_ACCOUNT] PUT update error:', updateError.message);
      return NextResponse.json({ error: 'Failed to update bank account' }, { status: 500 });
    }

    return NextResponse.json({ account: updated });
  } catch (err) {
    logger.error('[BANK_ACCOUNT] PUT error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

/**
 * DELETE /api/dashboard/bank-account?id=xxx&business_id=xxx
 * Soft-delete (deactivate) a bank account.
 */
export async function DELETE(request: NextRequest) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const accountId = request.nextUrl.searchParams.get('id');
    const businessId = request.nextUrl.searchParams.get('business_id');

    if (!accountId || !businessId) {
      return NextResponse.json({ error: 'id and business_id are required' }, { status: 400 });
    }

    // Verify ownership
    const { data: business } = await supabase
      .from('businesses')
      .select('id')
      .eq('id', businessId)
      .eq('owner_id', user.id)
      .maybeSingle();

    if (!business) {
      return NextResponse.json({ error: 'Business not found or access denied' }, { status: 403 });
    }

    const service = createServiceClient();
    const { error: updateError } = await service
      .from('bank_accounts')
      .update({ is_active: false, is_default: false })
      .eq('id', accountId)
      .eq('business_id', businessId);

    if (updateError) {
      logger.error('[BANK_ACCOUNT] DELETE error:', updateError.message);
      return NextResponse.json({ error: 'Failed to deactivate bank account' }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    logger.error('[BANK_ACCOUNT] DELETE error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
