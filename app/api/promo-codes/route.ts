import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';

async function authenticateAndVerifyOwnership(businessId: string) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  }

  const { data: business } = await supabase
    .from('businesses')
    .select('id')
    .eq('id', businessId)
    .eq('owner_id', user.id)
    .maybeSingle();

  if (!business) {
    return { error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };
  }

  return { user, business };
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const businessId = searchParams.get('businessId');
    if (!businessId) return NextResponse.json({ error: 'businessId required' }, { status: 400 });

    const auth = await authenticateAndVerifyOwnership(businessId);
    if ('error' in auth) return auth.error;

    const supabase = createServiceClient();
    const { data, error } = await supabase
      .from('promo_codes')
      .select('*')
      .eq('business_id', businessId)
      .order('created_at', { ascending: false });

    if (error) return NextResponse.json({ error: 'Failed to fetch promo codes' }, { status: 500 });
    return NextResponse.json({ codes: data });
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { businessId, code, description, discountType, discountValue, minOrderAmount, maxUses, validFrom, validUntil, applicableServices, applicableFlowTypes } = body;

    if (!businessId || !code || !discountType || discountValue === undefined) {
      return NextResponse.json({ error: 'businessId, code, discountType, discountValue required' }, { status: 400 });
    }

    if (discountValue <= 0) {
      return NextResponse.json({ error: 'Discount value must be greater than 0' }, { status: 400 });
    }
    if (discountType === 'percentage' && discountValue > 100) {
      return NextResponse.json({ error: 'Percentage discount cannot exceed 100%' }, { status: 400 });
    }

    const auth = await authenticateAndVerifyOwnership(businessId);
    if ('error' in auth) return auth.error;

    const supabase = createServiceClient();
    const { data, error } = await supabase
      .from('promo_codes')
      .insert({
        business_id: businessId,
        code: code.toUpperCase().trim(),
        description: description || null,
        discount_type: discountType,
        discount_value: discountValue,
        min_order_amount: minOrderAmount || 0,
        max_uses: maxUses || null,
        valid_from: validFrom || new Date().toISOString(),
        valid_until: validUntil || null,
        applicable_services: applicableServices || [],
        applicable_flow_types: applicableFlowTypes || [],
        is_active: true,
      })
      .select()
      .single();

    if (error) {
      if (error.code === '23505') return NextResponse.json({ error: 'Code already exists' }, { status: 409 });
      return NextResponse.json({ error: 'Failed to create promo code' }, { status: 500 });
    }
    return NextResponse.json({ promoCode: data });
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  try {
    const body = await request.json();
    const { id, businessId, ...updates } = body;
    if (!id || !businessId) return NextResponse.json({ error: 'id and businessId required' }, { status: 400 });

    const auth = await authenticateAndVerifyOwnership(businessId);
    if ('error' in auth) return auth.error;

    const supabase = createServiceClient();
    const updateData: Record<string, unknown> = {};
    if (updates.code !== undefined) updateData.code = updates.code.toUpperCase().trim();
    if (updates.description !== undefined) updateData.description = updates.description;
    if (updates.discountType !== undefined) updateData.discount_type = updates.discountType;
    if (updates.discountValue !== undefined) updateData.discount_value = updates.discountValue;
    if (updates.minOrderAmount !== undefined) updateData.min_order_amount = updates.minOrderAmount;
    if (updates.maxUses !== undefined) updateData.max_uses = updates.maxUses;
    if (updates.validUntil !== undefined) updateData.valid_until = updates.validUntil;
    if (updates.isActive !== undefined) updateData.is_active = updates.isActive;

    const { error } = await supabase
      .from('promo_codes')
      .update(updateData)
      .eq('id', id)
      .eq('business_id', businessId);

    if (error) return NextResponse.json({ error: 'Failed to update' }, { status: 500 });
    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    // Support both query params and JSON body
    let id: string | null = null;
    let businessId: string | null = null;
    const { searchParams } = new URL(request.url);
    id = searchParams.get('id');
    businessId = searchParams.get('businessId');
    if (!id || !businessId) {
      try {
        const body = await request.json();
        id = body.id || id;
        businessId = body.businessId || businessId;
      } catch { /* no body */ }
    }
    if (!id || !businessId) return NextResponse.json({ error: 'id and businessId required' }, { status: 400 });

    const auth = await authenticateAndVerifyOwnership(businessId);
    if ('error' in auth) return auth.error;

    const supabase = createServiceClient();
    await supabase.from('promo_codes').delete().eq('id', id).eq('business_id', businessId);
    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
