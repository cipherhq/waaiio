import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { generateSignedContractPdf } from '@/lib/pdf/contract-pdf-generator';
import { appendSignatureToUploadedPdf } from '@/lib/pdf/append-signature';
import { ChannelResolver } from '@/lib/channels/channel-resolver';
import { GupshupService } from '@/lib/channels/gupshup';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { token, signature_data } = body;

    if (!token || !signature_data) {
      return NextResponse.json({ error: 'token and signature_data are required' }, { status: 400 });
    }

    const supabase = createServiceClient();

    // Look up contract by token
    const { data: contract, error } = await supabase
      .from('contracts')
      .select('id, status, token, token_expires_at, business_id, title, template_url, document_content, signer_name, signer_phone')
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

    // Get business info
    const { data: biz } = await supabase
      .from('businesses')
      .select('name, country_code')
      .eq('id', contract.business_id)
      .single();

    const businessName = biz?.name || 'Business';

    // Generate signed PDF
    let pdfPath: string | null = null;

    if (contract.template_url) {
      // Uploaded document: download original and append signature page
      try {
        const ext = contract.template_url.split('.').pop()?.toLowerCase() || '';

        // Download the original file from storage
        const { data: originalFile } = await supabase.storage
          .from('contracts')
          .download(contract.template_url);

        if (originalFile) {
          const originalBuffer = Buffer.from(await originalFile.arrayBuffer());

          const pdfBuffer = await appendSignatureToUploadedPdf({
            originalFileBuffer: originalBuffer,
            originalFileType: ext === 'pdf' ? 'pdf' : 'image',
            businessName,
            title: contract.title,
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
        }
      } catch (pdfErr) {
        console.error('Uploaded doc PDF generation failed:', pdfErr);
      }
    }

    if (!pdfPath && contract.document_content) {
      // Text-based contract: generate PDF from content
      try {
        const pdfBuffer = await generateSignedContractPdf({
          businessName,
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

    // Send WhatsApp confirmation with download link to signer
    if (contract.signer_phone) {
      try {
        const appUrl = process.env.NEXT_PUBLIC_APP_URL || process.env.NEXT_PUBLIC_SITE_URL || 'https://app.waaiio.com';
        const downloadUrl = `${appUrl}/sign/${contract.token}`;

        const confirmMsg = [
          `\u2705 *Document Signed Successfully*`,
          '',
          `You have signed "${contract.title}" from ${businessName}.`,
          '',
          pdfPath
            ? `Your signed copy is ready. Tap the link below to download it anytime:`
            : `You can view your signature confirmation at:`,
          downloadUrl,
          '',
          `\ud83d\udd12 Keep this link for your records.`,
        ].join('\n');

        const phone = contract.signer_phone.replace(/\D/g, '');
        const resolver = new ChannelResolver(supabase);
        const resolved =
          (await resolver.resolveByBusinessId(contract.business_id)) ||
          (await resolver.getSharedChannelForCountry(biz?.country_code || 'NG'));

        let sent = false;
        if (resolved) {
          try {
            const result = await resolved.sender.sendText({ to: phone, text: confirmMsg });
            sent = result.success !== false;
          } catch (chErr) {
            console.warn('Confirmation channel send failed:', chErr);
          }
        }

        if (!sent) {
          const gupshup = new GupshupService();
          if (gupshup.isConfigured) {
            await gupshup.sendText({ to: phone, text: confirmMsg });
          }
        }
      } catch (msgErr) {
        // Don't fail the signing if confirmation message fails
        console.warn('Failed to send signing confirmation:', msgErr);
      }
    }

    return NextResponse.json({ success: true, contract_id: contract.id, has_pdf: !!pdfPath });
  } catch (err) {
    console.error('Contract submit error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
