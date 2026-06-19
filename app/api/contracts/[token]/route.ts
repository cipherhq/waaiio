import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { rateLimitResponse, getRateLimitKey } from '@/lib/rate-limit';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const rl = rateLimitResponse(getRateLimitKey(_request, 'public-contract'), 30, 60_000);
  if (rl) return rl;

  const { token } = await params;

  if (!token || token.length < 16) {
    return NextResponse.json({ error: 'Invalid token' }, { status: 400 });
  }

  const supabase = createServiceClient();

  // Try contracts table first
  const { data: contract, error } = await supabase
    .from('contracts')
    .select('id, title, signer_name, signer_email, status, token_expires_at, template_url, business_id, document_content, signed_at, signed_url, require_otp, otp_verified, reference_code')
    .eq('token', token)
    .single();

  // If not found in contracts, check contract_signers
  if (error || !contract) {
    const { data: signer } = await supabase
      .from('contract_signers')
      .select('id, contract_id, signer_name, signer_email, status, token_expires_at, signature_data, signed_at, otp_code, otp_expires_at, otp_verified, otp_attempts')
      .eq('token', token)
      .single();

    if (!signer) {
      return NextResponse.json({ error: 'Contract not found' }, { status: 404 });
    }

    // Get parent contract
    const { data: parentContract } = await supabase
      .from('contracts')
      .select('id, title, template_url, business_id, document_content, require_otp, reference_code')
      .eq('id', signer.contract_id)
      .single();

    if (!parentContract) {
      return NextResponse.json({ error: 'Contract not found' }, { status: 404 });
    }

    const { data: business } = await supabase
      .from('businesses')
      .select('name, logo_url, subscription_tier')
      .eq('id', parentContract.business_id)
      .single();

    // If signer already signed
    if (signer.status === 'signed') {
      return NextResponse.json({
        id: parentContract.id,
        title: parentContract.title,
        signer_name: signer.signer_name,
        signer_email: signer.signer_email || null,
        business_name: business?.name || 'Business',
        status: 'signed',
        signed_at: signer.signed_at,
        has_pdf: false, // individual signer doesn't have separate PDF
        is_multi_signer: true,
        reference_code: parentContract.reference_code || null,
        subscription_tier: business?.subscription_tier || 'free',
      });
    }

    // Check expiration
    if (new Date(signer.token_expires_at) < new Date()) {
      await supabase.from('contract_signers').update({ status: 'expired' }).eq('id', signer.id);
      return NextResponse.json({ error: 'This signing link has expired' }, { status: 410 });
    }

    if (signer.status === 'waiting') {
      return NextResponse.json({ error: 'It is not your turn to sign yet. You will be notified when ready.' }, { status: 425 });
    }

    if (signer.status !== 'pending') {
      return NextResponse.json({ error: 'This signing link is no longer valid' }, { status: 410 });
    }

    return NextResponse.json({
      id: parentContract.id,
      title: parentContract.title,
      signer_name: signer.signer_name,
      signer_email: signer.signer_email || null,
      business_name: business?.name || 'Business',
      status: signer.status,
      expires_at: signer.token_expires_at,
      document_content: parentContract.document_content,
      template_url: parentContract.template_url || null,
      require_otp: parentContract.require_otp || false,
      otp_verified: signer.otp_verified || false,
      is_multi_signer: true,
      logo_url: business?.logo_url || null,
      reference_code: parentContract.reference_code || null,
      subscription_tier: business?.subscription_tier || 'free',
    });
  }

  // Get business name and branding
  const { data: business } = await supabase
    .from('businesses')
    .select('name, logo_url, subscription_tier')
    .eq('id', contract.business_id)
    .single();

  // If already signed, return signed view data
  if (contract.status === 'signed') {
    return NextResponse.json({
      id: contract.id,
      title: contract.title,
      signer_name: contract.signer_name,
      signer_email: contract.signer_email || null,
      business_name: business?.name || 'Business',
      status: 'signed',
      signed_at: contract.signed_at,
      has_pdf: !!contract.signed_url?.endsWith('.pdf'),
      reference_code: contract.reference_code || null,
      subscription_tier: business?.subscription_tier || 'free',
    });
  }

  // Check if expired
  if (new Date(contract.token_expires_at) < new Date()) {
    await supabase
      .from('contracts')
      .update({ status: 'expired' })
      .eq('id', contract.id);
    return NextResponse.json({ error: 'This signing link has expired' }, { status: 410 });
  }

  if (contract.status !== 'pending') {
    return NextResponse.json({
      error: 'This signing link is no longer valid',
    }, { status: 410 });
  }

  return NextResponse.json({
    id: contract.id,
    title: contract.title,
    signer_name: contract.signer_name,
    signer_email: contract.signer_email || null,
    business_name: business?.name || 'Business',
    status: contract.status,
    expires_at: contract.token_expires_at,
    document_content: contract.document_content,
    template_url: contract.template_url || null,
    require_otp: contract.require_otp || false,
    otp_verified: contract.otp_verified || false,
    logo_url: business?.logo_url || null,
    reference_code: contract.reference_code || null,
    subscription_tier: business?.subscription_tier || 'free',
  });
}
