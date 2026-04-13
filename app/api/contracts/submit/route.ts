import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { generateSignedContractPdf } from '@/lib/pdf/contract-pdf-generator';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { token, signature_data } = body;

    if (!token || !signature_data) {
      return NextResponse.json({ error: 'token and signature_data are required' }, { status: 400 });
    }

    const supabase = await createClient();

    // Look up contract by token
    const { data: contract, error } = await supabase
      .from('contracts')
      .select('id, status, token_expires_at, business_id, title, template_url, document_content, signer_name')
      .eq('token', token)
      .single();

    if (error || !contract) {
      return NextResponse.json({ error: 'Contract not found' }, { status: 404 });
    }

    // Validate
    if (new Date(contract.token_expires_at) < new Date()) {
      await supabase
        .from('contracts')
        .update({ status: 'expired' })
        .eq('id', contract.id);
      return NextResponse.json({ error: 'This signing link has expired' }, { status: 410 });
    }

    if (contract.status !== 'pending') {
      return NextResponse.json({ error: 'This document has already been signed or is no longer valid' }, { status: 410 });
    }

    // Capture audit trail
    const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
      || request.headers.get('x-real-ip')
      || 'unknown';
    const userAgent = request.headers.get('user-agent') || 'unknown';
    const deviceType = /mobile|android|iphone|ipad/i.test(userAgent) ? 'mobile' : 'desktop';

    const auditTrail = {
      ip,
      user_agent: userAgent,
      device_type: deviceType,
      signed_at: new Date().toISOString(),
    };

    // Upload signature as image to storage
    const signatureBuffer = Buffer.from(signature_data.replace(/^data:image\/\w+;base64,/, ''), 'base64');
    const signaturePath = `${contract.business_id}/${contract.id}/signature.png`;

    await supabase.storage
      .from('contracts')
      .upload(signaturePath, signatureBuffer, {
        contentType: 'image/png',
        upsert: true,
      });

    // Generate signed PDF if document has content
    let pdfPath: string | null = null;
    if (contract.document_content) {
      try {
        // Get business name
        const { data: biz } = await supabase
          .from('businesses')
          .select('name')
          .eq('id', contract.business_id)
          .single();

        const pdfBuffer = await generateSignedContractPdf({
          businessName: biz?.name || 'Business',
          title: contract.title,
          documentContent: contract.document_content,
          signerName: contract.signer_name || 'Signer',
          signatureData: signature_data,
          signedAt: auditTrail.signed_at,
          auditTrail,
          contractId: contract.id,
        });

        pdfPath = `${contract.business_id}/${contract.id}/signed.pdf`;
        await supabase.storage
          .from('contracts')
          .upload(pdfPath, pdfBuffer, {
            contentType: 'application/pdf',
            upsert: true,
          });
      } catch (pdfErr) {
        console.error('PDF generation failed (signature still saved):', pdfErr);
      }
    }

    // Update contract
    const { error: updateError } = await supabase
      .from('contracts')
      .update({
        status: 'signed',
        signature_data,
        signed_url: pdfPath || signaturePath,
        signed_at: new Date().toISOString(),
        audit_trail: auditTrail,
      })
      .eq('id', contract.id);

    if (updateError) {
      console.error('Failed to update contract:', updateError);
      return NextResponse.json({ error: 'Failed to save signature' }, { status: 500 });
    }

    return NextResponse.json({ success: true, contract_id: contract.id, has_pdf: !!pdfPath });
  } catch (err) {
    console.error('Contract submit error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
