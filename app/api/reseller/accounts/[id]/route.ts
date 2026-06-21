import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { logger } from '@/lib/logger';

/**
 * Helper: verify current user is a reseller and the business belongs to them.
 */
async function verifyResellerOwnership(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
  businessId: string,
) {
  const { data: reseller } = await supabase
    .from('resellers')
    .select('id')
    .eq('user_id', userId)
    .maybeSingle();

  if (!reseller) return { reseller: null, business: null };

  const { data: business } = await supabase
    .from('businesses')
    .select('*')
    .eq('id', businessId)
    .eq('reseller_id', reseller.id)
    .maybeSingle();

  return { reseller, business };
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { reseller, business } = await verifyResellerOwnership(supabase, user.id, id);
    if (!reseller) return NextResponse.json({ error: 'Reseller profile not found' }, { status: 404 });
    if (!business) return NextResponse.json({ error: 'Sub-account not found' }, { status: 404 });

    return NextResponse.json({ business });
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { reseller, business } = await verifyResellerOwnership(supabase, user.id, id);
    if (!reseller) return NextResponse.json({ error: 'Reseller profile not found' }, { status: 404 });
    if (!business) return NextResponse.json({ error: 'Sub-account not found' }, { status: 404 });

    const body = await request.json();

    // Only allow specific fields to be updated by reseller
    const ALLOWED_FIELDS = [
      'name', 'status', 'subscription_tier', 'category',
      'description', 'address', 'phone', 'email', 'slug', 'flow_type',
    ] as const;
    const updates: Record<string, unknown> = {};
    const errors: string[] = [];

    for (const field of ALLOWED_FIELDS) {
      if (body[field] !== undefined) {
        updates[field] = body[field];
      }
    }

    // Field-specific validation
    if (updates.slug !== undefined) {
      const slug = String(updates.slug);
      if (!/^[a-z0-9-]+$/.test(slug)) {
        errors.push('slug must be lowercase alphanumeric with hyphens only');
      } else if (slug.length > 60) {
        errors.push('slug must be 60 characters or fewer');
      }
    }

    if (updates.email !== undefined && updates.email !== null) {
      const email = String(updates.email);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        errors.push('email must be a valid email address');
      }
    }

    if (updates.phone !== undefined && updates.phone !== null) {
      if (String(updates.phone).length > 30) {
        errors.push('phone must be 30 characters or fewer');
      }
    }

    if (updates.description !== undefined && updates.description !== null) {
      if (String(updates.description).length > 500) {
        errors.push('description must be 500 characters or fewer');
      }
    }

    if (updates.address !== undefined && updates.address !== null) {
      if (String(updates.address).length > 300) {
        errors.push('address must be 300 characters or fewer');
      }
    }

    if (errors.length > 0) {
      return NextResponse.json({ error: errors.join('; ') }, { status: 400 });
    }

    if (Object.keys(updates).length === 0) {
      return NextResponse.json({ error: 'No valid fields to update' }, { status: 400 });
    }

    const { data: updated, error: updateError } = await supabase
      .from('businesses')
      .update(updates)
      .eq('id', id)
      .eq('reseller_id', reseller.id)
      .select()
      .single();

    if (updateError) {
      logger.error('[RESELLER_ACCOUNTS] Update error:', updateError.message);
      return NextResponse.json({ error: 'Failed to update sub-account' }, { status: 500 });
    }

    return NextResponse.json({ business: updated });
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { reseller, business } = await verifyResellerOwnership(supabase, user.id, id);
    if (!reseller) return NextResponse.json({ error: 'Reseller profile not found' }, { status: 404 });
    if (!business) return NextResponse.json({ error: 'Sub-account not found' }, { status: 404 });

    // Soft-delete: set status to suspended
    const { error: suspendError } = await supabase
      .from('businesses')
      .update({ status: 'suspended' })
      .eq('id', id)
      .eq('reseller_id', reseller.id);

    if (suspendError) {
      logger.error('[RESELLER_ACCOUNTS] Suspend error:', suspendError.message);
      return NextResponse.json({ error: 'Failed to suspend sub-account' }, { status: 500 });
    }

    return NextResponse.json({ message: 'Sub-account suspended' });
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
