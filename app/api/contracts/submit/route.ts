import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { generateSignedContractPdf } from '@/lib/pdf/contract-pdf-generator';
import { appendSignatureToUploadedPdf } from '@/lib/pdf/append-signature';
import { ChannelResolver } from '@/lib/channels/channel-resolver';
import { GupshupService } from '@/lib/channels/gupshup';

async function sendWhatsApp(
  supabase: ReturnType<typeof createServiceClient>,
  businessId: string,
  countryCode: string,
  phone: string,
  message: string,
) {
  const cleanPhone = phone.replace(/\D/g, '');
  const resolver = new ChannelResolver(supabase);
  const resolved =
    (await resolver.resolveByBusinessId(businessId)) ||
    (await resolver.getSharedChannelForCountry(countryCode || 'NG'));

  let sent = false;
  if (resolved) {
    try {
      const result = await resolved.sender.sendText({ to: cleanPhone, text: message });
      sent = result.success !== false;
    } catch (chErr) {
      console.warn('Channel send failed:', chErr);
    }
  }

  if (!sent) {
    const gupshup = new GupshupService();
    if (gupshup.isConfigured) {
      await gupshup.sendText({ to: cleanPhone, text: message });
    }
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { token, signature_data } = body;

    if (!token || !signature_data) {
      return NextResponse.json({ error: 'token and signature_data are required' }, { status: 400 });
    }

    const supabase = createServiceClient();

    // Try contracts table first (single signer)
    const { data: contract, error } = await supabase
      .from('contracts')
      .select('id, status, token, token_expires_at, business_id, title, template_url, document_content, signer_name, signer_phone, require_otp, otp_verified, signing_mode, cc_recipients')
      .eq('token', token)
      .single();

    // Check if this is a multi-signer token
    let isMultiSigner = false;
    let signerRow: {
      id: string; contract_id: string; signer_name: string | null;
      signer_phone: string; status: string; token_expires_at: string;
      signing_order: number; otp_verified: boolean;
    } | null = null;
    let parentContract: typeof contract = null;

    if (error || !contract) {
      // Look up in contract_signers
      const { data: signer } = await supabase
        .from('contract_signers')
        .select('id, contract_id, signer_name, signer_phone, status, token_expires_at, signing_order, otp_verified')
        .eq('token', token)
        .single();

      if (!signer) {
        return NextResponse.json({ error: 'Contract not found' }, { status: 404 });
      }

      // Get parent contract
      const { data: parent } = await supabase
        .from('contracts')
        .select('id, status, token, token_expires_at, business_id, title, template_url, document_content, signer_name, signer_phone, require_otp, otp_verified, signing_mode, cc_recipients')
        .eq('id', signer.contract_id)
        .single();

      if (!parent) {
        return NextResponse.json({ error: 'Contract not found' }, { status: 404 });
      }

      isMultiSigner = true;
      signerRow = signer;
      parentContract = parent;
    }

    const activeContract = isMultiSigner ? parentContract! : contract!;
    const signerStatus = isMultiSigner ? signerRow!.status : activeContract.status;
    const signerExpiresAt = isMultiSigner ? signerRow!.token_expires_at : activeContract.token_expires_at;
    const signerName = isMultiSigner ? (signerRow!.signer_name || 'Signer') : (activeContract.signer_name || 'Signer');
    const signerPhone = isMultiSigner ? signerRow!.signer_phone : activeContract.signer_phone;

    // Validate expiration
    if (new Date(signerExpiresAt) < new Date()) {
      if (isMultiSigner) {
        await supabase.from('contract_signers').update({ status: 'expired' }).eq('id', signerRow!.id);
      } else {
        await supabase.from('contracts').update({ status: 'expired' }).eq('id', activeContract.id);
      }
      return NextResponse.json({ error: 'This signing link has expired' }, { status: 410 });
    }

    if (signerStatus !== 'pending') {
      return NextResponse.json({ error: 'This document has already been signed or is no longer valid' }, { status: 410 });
    }

    // OTP guard
    if (activeContract.require_otp) {
      const otpVerified = isMultiSigner ? signerRow!.otp_verified : activeContract.otp_verified;
      if (!otpVerified) {
        return NextResponse.json({ error: 'OTP verification required before signing' }, { status: 403 });
      }
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
    const sigSuffix = isMultiSigner ? `signer-${signerRow!.signing_order}` : 'signature';
    const signaturePath = `${activeContract.business_id}/${activeContract.id}/${sigSuffix}.png`;

    await supabase.storage
      .from('contracts')
      .upload(signaturePath, signatureBuffer, {
        contentType: 'image/png',
        upsert: true,
      });

    // Get business info
    const { data: biz } = await supabase
      .from('businesses')
      .select('name, country_code, phone, owner_id, logo_url')
      .eq('id', activeContract.business_id)
      .single();

    const businessName = biz?.name || 'Business';

    // Try to fetch business logo for PDF branding
    let logoBuffer: Buffer | undefined;
    if (biz?.logo_url) {
      try {
        const logoRes = await fetch(biz.logo_url);
        if (logoRes.ok) {
          logoBuffer = Buffer.from(await logoRes.arrayBuffer());
        }
      } catch {
        // Skip logo if fetch fails
      }
    }

    if (isMultiSigner) {
      // Update the signer row
      await supabase
        .from('contract_signers')
        .update({
          status: 'signed',
          signature_data,
          signed_at: new Date().toISOString(),
          audit_trail: auditTrail,
        })
        .eq('id', signerRow!.id);

      // Check if all signers have signed
      const { data: allSigners } = await supabase
        .from('contract_signers')
        .select('id, status, signing_order, signer_phone, signer_name, token')
        .eq('contract_id', activeContract.id)
        .order('signing_order');

      const allSigned = (allSigners || []).every(s => s.id === signerRow!.id || s.status === 'signed');

      if (allSigned) {
        // All signed — generate final PDF and mark parent as signed
        let pdfPath: string | null = null;

        if (activeContract.template_url) {
          try {
            const ext = activeContract.template_url.split('.').pop()?.toLowerCase() || '';
            const { data: originalFile } = await supabase.storage
              .from('contracts')
              .download(activeContract.template_url);

            if (originalFile) {
              const originalBuffer = Buffer.from(await originalFile.arrayBuffer());
              const pdfBuffer = await appendSignatureToUploadedPdf({
                originalFileBuffer: originalBuffer,
                originalFileType: ext === 'pdf' ? 'pdf' : 'image',
                businessName,
                title: activeContract.title,
                signerName: (allSigners || []).map(s => s.signer_name || 'Signer').join(', '),
                signatureData: signature_data,
                signedAt: auditTrail.signed_at,
                auditTrail,
                contractId: activeContract.id,
              });

              pdfPath = `${activeContract.business_id}/${activeContract.id}/signed.pdf`;
              await supabase.storage.from('contracts').upload(pdfPath, pdfBuffer, {
                contentType: 'application/pdf',
                upsert: true,
              });
            }
          } catch (pdfErr) {
            console.error('Multi-signer PDF generation failed:', pdfErr);
          }
        }

        if (!pdfPath && activeContract.document_content) {
          try {
            const pdfBuffer = await generateSignedContractPdf({
              businessName,
              title: activeContract.title,
              documentContent: activeContract.document_content,
              signerName: (allSigners || []).map(s => s.signer_name || 'Signer').join(', '),
              signatureData: signature_data,
              signedAt: auditTrail.signed_at,
              auditTrail,
              contractId: activeContract.id,
            });

            pdfPath = `${activeContract.business_id}/${activeContract.id}/signed.pdf`;
            await supabase.storage.from('contracts').upload(pdfPath, pdfBuffer, {
              contentType: 'application/pdf',
              upsert: true,
            });
          } catch (pdfErr) {
            console.error('Multi-signer PDF generation failed:', pdfErr);
          }
        }

        await supabase
          .from('contracts')
          .update({
            status: 'signed',
            signed_url: pdfPath || signaturePath,
            signed_at: new Date().toISOString(),
          })
          .eq('id', activeContract.id);

        // Notify owner
        if (biz?.phone) {
          try {
            const ownerMsg = `"${activeContract.title}" has been signed by all signers! View from your dashboard.`;
            await sendWhatsApp(supabase, activeContract.business_id, biz.country_code, biz.phone, ownerMsg);
          } catch (ownerErr) {
            console.warn('Failed to send owner notification:', ownerErr);
          }
        }
      } else if (activeContract.signing_mode === 'sequential') {
        // Advance next signer from 'waiting' to 'pending'
        const nextSigner = (allSigners || []).find(s => s.status === 'waiting');
        if (nextSigner) {
          await supabase
            .from('contract_signers')
            .update({ status: 'pending' })
            .eq('id', nextSigner.id);

          // Send WhatsApp to next signer
          const appUrl = process.env.NEXT_PUBLIC_APP_URL || process.env.NEXT_PUBLIC_SITE_URL || 'https://app.waaiio.com';
          const nextSignUrl = `${appUrl}/sign/${nextSigner.token}`;
          const nextMsg = [
            `\ud83d\udcdd *Document for Signature*`,
            '',
            `${businessName} has sent you a document to sign:`,
            `\ud83d\udcc4 ${activeContract.title}`,
            '',
            `\ud83d\udc49 ${nextSignUrl}`,
            '',
            `\u23f0 Expires in 72 hours.`,
          ].join('\n');

          await sendWhatsApp(supabase, activeContract.business_id, biz?.country_code || 'NG', nextSigner.signer_phone, nextMsg);
        }
      }

      // Send confirmation to this signer
      if (signerPhone) {
        try {
          const appUrl = process.env.NEXT_PUBLIC_APP_URL || process.env.NEXT_PUBLIC_SITE_URL || 'https://app.waaiio.com';
          const confirmMsg = [
            `\u2705 *Document Signed Successfully*`,
            '',
            `You have signed "${activeContract.title}" from ${businessName}.`,
            '',
            `\ud83d\udd12 Your signature has been recorded.`,
          ].join('\n');
          await sendWhatsApp(supabase, activeContract.business_id, biz?.country_code || 'NG', signerPhone, confirmMsg);
        } catch (msgErr) {
          console.warn('Failed to send signer confirmation:', msgErr);
        }
      }

      return NextResponse.json({ success: true, contract_id: activeContract.id, has_pdf: false });
    }

    // ── Single signer flow (original logic) ──
    let pdfPath: string | null = null;

    if (activeContract.template_url) {
      try {
        const ext = activeContract.template_url.split('.').pop()?.toLowerCase() || '';
        const { data: originalFile } = await supabase.storage
          .from('contracts')
          .download(activeContract.template_url);

        if (originalFile) {
          const originalBuffer = Buffer.from(await originalFile.arrayBuffer());
          const pdfBuffer = await appendSignatureToUploadedPdf({
            originalFileBuffer: originalBuffer,
            originalFileType: ext === 'pdf' ? 'pdf' : 'image',
            businessName,
            title: activeContract.title,
            signerName,
            signatureData: signature_data,
            signedAt: auditTrail.signed_at,
            auditTrail,
            contractId: activeContract.id,
            logoBuffer,
          });

          pdfPath = `${activeContract.business_id}/${activeContract.id}/signed.pdf`;
          await supabase.storage.from('contracts').upload(pdfPath, pdfBuffer, {
            contentType: 'application/pdf',
            upsert: true,
          });
        }
      } catch (pdfErr) {
        console.error('Uploaded doc PDF generation failed:', pdfErr);
      }
    }

    if (!pdfPath && activeContract.document_content) {
      try {
        const pdfBuffer = await generateSignedContractPdf({
          businessName,
          title: activeContract.title,
          documentContent: activeContract.document_content,
          signerName,
          signatureData: signature_data,
          signedAt: auditTrail.signed_at,
          auditTrail,
          contractId: activeContract.id,
        });

        pdfPath = `${activeContract.business_id}/${activeContract.id}/signed.pdf`;
        await supabase.storage.from('contracts').upload(pdfPath, pdfBuffer, {
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
      .eq('id', activeContract.id);

    if (updateError) {
      console.error('Failed to update contract:', updateError);
      return NextResponse.json({ error: 'Failed to save signature' }, { status: 500 });
    }

    // Send WhatsApp confirmation to signer
    if (signerPhone) {
      try {
        const appUrl = process.env.NEXT_PUBLIC_APP_URL || process.env.NEXT_PUBLIC_SITE_URL || 'https://app.waaiio.com';
        const downloadUrl = `${appUrl}/sign/${activeContract.token}`;

        const confirmMsg = [
          `\u2705 *Document Signed Successfully*`,
          '',
          `You have signed "${activeContract.title}" from ${businessName}.`,
          '',
          pdfPath
            ? `Your signed copy is ready. Tap the link below to download it anytime:`
            : `You can view your signature confirmation at:`,
          downloadUrl,
          '',
          `\ud83d\udd12 Keep this link for your records.`,
        ].join('\n');

        await sendWhatsApp(supabase, activeContract.business_id, biz?.country_code || 'NG', signerPhone, confirmMsg);
      } catch (msgErr) {
        console.warn('Failed to send signing confirmation:', msgErr);
      }
    }

    // Notify business owner
    if (biz?.phone) {
      try {
        const ownerMsg = `"${activeContract.title}" has been signed by ${signerName}! View from your dashboard.`;
        await sendWhatsApp(supabase, activeContract.business_id, biz.country_code, biz.phone, ownerMsg);
      } catch (ownerErr) {
        console.warn('Failed to send owner notification:', ownerErr);
      }
    }

    // Send CC notifications
    const ccList = activeContract.cc_recipients as { phone?: string; email?: string }[] | null;
    if (ccList && ccList.length > 0) {
      for (const cc of ccList) {
        if (cc.phone) {
          try {
            const ccMsg = `"${activeContract.title}" has been signed by ${signerName}. You were CC'd on this document.`;
            await sendWhatsApp(supabase, activeContract.business_id, biz?.country_code || 'NG', cc.phone, ccMsg);
          } catch (ccErr) {
            console.warn('Failed to send CC notification:', ccErr);
          }
        }
      }
    }

    return NextResponse.json({ success: true, contract_id: activeContract.id, has_pdf: !!pdfPath });
  } catch (err) {
    console.error('Contract submit error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
