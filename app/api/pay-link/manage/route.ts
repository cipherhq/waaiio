import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest } from '@/lib/api-auth';

/**
 * CRUD for payment links — auth required, business ownership verified.
 */

/** GET — list payment links for the authenticated business */
export async function GET(request: NextRequest) {
  const businessId = request.nextUrl.searchParams.get('businessId');
  if (!businessId) {
    return NextResponse.json({ error: 'businessId required' }, { status: 400 });
  }

  const auth = await authenticateRequest(request, {
    requireBusinessOwnership: true,
    businessIdKey: 'businessId',
    body: { businessId },
  });
  if (auth instanceof NextResponse) return auth;

  const { service } = auth;

  const { data, error } = await service
    .from('payment_links')
    .select('*')
    .eq('business_id', businessId)
    .order('created_at', { ascending: false });

  if (error) {
    return NextResponse.json({ error: 'Failed to fetch payment links' }, { status: 500 });
  }

  return NextResponse.json(data || []);
}

/** POST — create a new payment link */
export async function POST(request: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const auth = await authenticateRequest(request, {
    requireBusinessOwnership: true,
    businessIdKey: 'businessId',
    body,
  });
  if (auth instanceof NextResponse) return auth;

  const { service, businessId } = auth;

  const title = (body.title as string)?.trim();
  if (!title || title.length > 200) {
    return NextResponse.json({ error: 'Title is required (max 200 chars)' }, { status: 400 });
  }

  const amount = body.amount ? Number(body.amount) : null;
  if (amount !== null && (amount <= 0 || amount > 10_000_000)) {
    return NextResponse.json({ error: 'Invalid amount' }, { status: 400 });
  }

  // Optional expiry and max uses
  const expiresAt = body.expires_at ? new Date(body.expires_at as string).toISOString() : null;
  const maxUses = body.max_uses ? Math.max(1, Math.floor(Number(body.max_uses))) : null;

  const { data, error } = await service
    .from('payment_links')
    .insert({
      business_id: businessId,
      title,
      amount,
      currency: (body.currency as string) || null,
      description: ((body.description as string) || '').slice(0, 500) || null,
      expires_at: expiresAt,
      max_uses: maxUses,
    })
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: 'Failed to create payment link' }, { status: 500 });
  }

  return NextResponse.json(data, { status: 201 });
}

/** PATCH — update a payment link */
export async function PATCH(request: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const auth = await authenticateRequest(request, {
    requireBusinessOwnership: true,
    businessIdKey: 'businessId',
    body,
  });
  if (auth instanceof NextResponse) return auth;

  const { service, businessId } = auth;
  const linkId = body.id as string;

  if (!linkId) {
    return NextResponse.json({ error: 'Payment link id required' }, { status: 400 });
  }

  const updates: Record<string, unknown> = {};
  if (body.title !== undefined) {
    const title = (body.title as string)?.trim();
    if (!title || title.length > 200) {
      return NextResponse.json({ error: 'Title is required (max 200 chars)' }, { status: 400 });
    }
    updates.title = title;
  }
  if (body.amount !== undefined) {
    updates.amount = body.amount ? Number(body.amount) : null;
  }
  if (body.description !== undefined) {
    updates.description = ((body.description as string) || '').slice(0, 500) || null;
  }
  if (body.is_active !== undefined) {
    updates.is_active = !!body.is_active;
  }
  if (body.expires_at !== undefined) {
    updates.expires_at = body.expires_at ? new Date(body.expires_at as string).toISOString() : null;
  }
  if (body.max_uses !== undefined) {
    updates.max_uses = body.max_uses ? Math.max(1, Math.floor(Number(body.max_uses))) : null;
  }

  const { data, error } = await service
    .from('payment_links')
    .update(updates)
    .eq('id', linkId)
    .eq('business_id', businessId)
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: 'Failed to update payment link' }, { status: 500 });
  }

  return NextResponse.json(data);
}

/** DELETE — deactivate a payment link (soft delete) */
export async function DELETE(request: NextRequest) {
  const linkId = request.nextUrl.searchParams.get('id');
  const businessId = request.nextUrl.searchParams.get('businessId');

  if (!linkId || !businessId) {
    return NextResponse.json({ error: 'id and businessId required' }, { status: 400 });
  }

  const auth = await authenticateRequest(request, {
    requireBusinessOwnership: true,
    businessIdKey: 'businessId',
    body: { businessId },
  });
  if (auth instanceof NextResponse) return auth;

  const { service } = auth;

  const { error } = await service
    .from('payment_links')
    .update({ is_active: false })
    .eq('id', linkId)
    .eq('business_id', businessId);

  if (error) {
    return NextResponse.json({ error: 'Failed to deactivate payment link' }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
