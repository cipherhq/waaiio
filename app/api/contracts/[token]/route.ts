import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;

  if (!token || token.length < 32) {
    return NextResponse.json({ error: 'Invalid token' }, { status: 400 });
  }

  const supabase = await createClient();

  const { data: contract, error } = await supabase
    .from('contracts')
    .select('id, title, signer_name, status, token_expires_at, template_url, business_id')
    .eq('token', token)
    .single();

  if (error || !contract) {
    return NextResponse.json({ error: 'Contract not found' }, { status: 404 });
  }

  // Check if expired
  if (new Date(contract.token_expires_at) < new Date()) {
    // Auto-expire
    await supabase
      .from('contracts')
      .update({ status: 'expired' })
      .eq('id', contract.id);
    return NextResponse.json({ error: 'This signing link has expired' }, { status: 410 });
  }

  if (contract.status !== 'pending') {
    return NextResponse.json({
      error: contract.status === 'signed'
        ? 'This document has already been signed'
        : 'This signing link is no longer valid',
    }, { status: 410 });
  }

  // Get business name
  const { data: business } = await supabase
    .from('businesses')
    .select('name')
    .eq('id', contract.business_id)
    .single();

  return NextResponse.json({
    id: contract.id,
    title: contract.title,
    signer_name: contract.signer_name,
    business_name: business?.name || 'Business',
    status: contract.status,
    expires_at: contract.token_expires_at,
  });
}
