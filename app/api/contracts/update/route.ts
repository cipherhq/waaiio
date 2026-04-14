import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';

export async function PATCH(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await request.json();
  const { contract_id, title, signer_name, signer_phone, signer_email } = body;

  if (!contract_id) {
    return NextResponse.json({ error: 'contract_id is required' }, { status: 400 });
  }

  const service = createServiceClient();

  // Fetch contract and verify ownership
  const { data: contract, error } = await service
    .from('contracts')
    .select('id, business_id, status')
    .eq('id', contract_id)
    .single();

  if (error || !contract) {
    return NextResponse.json({ error: 'Contract not found' }, { status: 404 });
  }

  // Only allow editing pending or expired contracts
  if (contract.status === 'signed') {
    return NextResponse.json({ error: 'Cannot edit a signed contract' }, { status: 400 });
  }

  // Verify user owns the business
  const { data: biz } = await supabase
    .from('businesses')
    .select('id')
    .eq('id', contract.business_id)
    .eq('owner_id', user.id)
    .maybeSingle();

  if (!biz) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
  }

  // Build update object with only provided fields
  const updates: Record<string, string | null> = {};
  if (title !== undefined) updates.title = title;
  if (signer_name !== undefined) updates.signer_name = signer_name || null;
  if (signer_phone !== undefined) updates.signer_phone = signer_phone;
  if (signer_email !== undefined) updates.signer_email = signer_email || null;

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: 'No fields to update' }, { status: 400 });
  }

  const { error: updateError } = await service
    .from('contracts')
    .update(updates)
    .eq('id', contract_id);

  if (updateError) {
    return NextResponse.json({ error: 'Failed to update contract' }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
