import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { generateSignedContractPdf } from '@/lib/pdf/contract-pdf-generator';
import { appendSignatureToUploadedPdf } from '@/lib/pdf/append-signature';
import { ChannelResolver } from '@/lib/channels/channel-resolver';
import { rateLimitResponse, getRateLimitKey } from '@/lib/rate-limit';
import { logger } from '@/lib/logger';

function generateSigRef(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return `SIG-${code}`;
}

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

  if (resolved) {
    try {
      await resolved.sender.sendText({ to: cleanPhone, text: message });
    } catch (chErr) {
      logger.warn('Channel send failed:', chErr);
    }
  } else {
    logger.warn(`[CONTRACT-SUBMIT] No WhatsApp channel configured for business ${businessId}. Message NOT delivered to ${cleanPhone}.`);
  }
}

export async function POST(request: NextRequest) {
  const rateLimit = rateLimitResponse(getRateLimitKey(request, 'contract-sign'), 10, 60_000);
  if (rateLimit) return rateLimit;

  try {
    const body = await request.json();
    const { token, signature_data } = body;

    if (!token || !signature_data) {
      return NextResponse.json({ error: 'token and signature_data are required' }, { status: 400 });
    }

    if (signature_data.length > 500_000) {
      return NextResponse.json({ error: 'Signature data too large' }, { status: 400 });
    }

    const supabase = createServiceClient();

    // Try contracts table first (single signer)
    const { data: contract, error } = await supabase
      .from('contracts')
      .select('id, status, token, token_expires_at, business_id, title, template_url, document_content, signer_name, signer_phone, signer_email, require_otp, otp_verified, signing_mode, cc_recipients, reference_code')
      .eq('token', token)
      .single();

    // Check if this is a multi-signer token
    let isMultiSigner = false;
    let signerRow: {
      id: string; contract_id: string; signer_name: string | null;
      signer_phone: string; signer_email: string | null; status: string;
      token_expires_at: string; signing_order: number; otp_verified: boolean;
    } | null = null;
    let parentContract: typeof contract = null;

    if (error || !contract) {
      // Look up in contract_signers
      const { data: signer } = await supabase
        .from('contract_signers')
        .select('id, contract_id, signer_name, signer_phone, signer_email, status, token_expires_at, signing_order, otp_verified')
        .eq('token', token)
        .single();

      if (!signer) {
        return NextResponse.json({ error: 'Contract not found' }, { status: 404 });
      }

      // Get parent contract
      const { data: parent } = await supabase
        .from('contracts')
        .select('id, status, token, token_expires_at, business_id, title, template_url, document_content, signer_name, signer_phone, signer_email, require_otp, otp_verified, signing_mode, cc_recipients, reference_code')
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
    const signerEmail = isMultiSigner ? signerRow!.signer_email : activeContract.signer_email;
    const signerToken = token;

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
      // Generate signature reference for this signer
      const signatureReference = generateSigRef();

      // Update the signer row
      await supabase
        .from('contract_signers')
        .update({
          status: 'signed',
          signature_data,
          signed_at: new Date().toISOString(),
          audit_trail: { ...auditTrail, signature_reference: signatureReference },
          signature_reference: signatureReference,
        })
        .eq('id', signerRow!.id);

      // Check if all signers have signed
      const { data: allSigners } = await supabase
        .from('contract_signers')
        .select('id, status, signing_order, signer_phone, signer_email, signer_name, token')
        .eq('contract_id', activeContract.id)
        .order('signing_order');

      const allSigned = (allSigners || []).every(s => s.id === signerRow!.id || s.status === 'signed');
      let pdfPath: string | null = null;

      if (allSigned) {
        // All signed — generate final PDF and mark parent as signed

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
                referenceCode: activeContract.reference_code || undefined,
                signatureReference: signatureReference,
                verifyUrl: `${process.env.NEXT_PUBLIC_APP_URL || 'https://www.waaiio.com'}/contracts/${activeContract.id}?token=${signerToken}`,
              });

              pdfPath = `${activeContract.business_id}/${activeContract.id}/signed.pdf`;
              await supabase.storage.from('contracts').upload(pdfPath, pdfBuffer, {
                contentType: 'application/pdf',
                upsert: true,
              });
            }
          } catch (pdfErr) {
            logger.error('Multi-signer PDF generation failed:', pdfErr);
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
              referenceCode: activeContract.reference_code || undefined,
              signatureReference: signatureReference,
              verifyUrl: `${process.env.NEXT_PUBLIC_APP_URL || 'https://www.waaiio.com'}/contracts/${activeContract.id}?token=${signerToken}`,
            });

            pdfPath = `${activeContract.business_id}/${activeContract.id}/signed.pdf`;
            await supabase.storage.from('contracts').upload(pdfPath, pdfBuffer, {
              contentType: 'application/pdf',
              upsert: true,
            });
          } catch (pdfErr) {
            logger.error('Multi-signer PDF generation failed:', pdfErr);
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
            logger.warn('Failed to send owner notification:', ownerErr);
          }
        }

        // Email owner about all signers completing
        try {
          if (biz?.owner_id) {
            const { data: owner } = await supabase.from('profiles').select('email, first_name').eq('id', biz.owner_id).single();
            if (owner?.email) {
              const { sendEmail } = await import('@/lib/email/client');
              sendEmail({
                to: owner.email,
                subject: `Contract signed: ${activeContract.title}`,
                html: `<p>Hi ${owner.first_name || 'there'},</p><p>All signers have signed "${activeContract.title}". View it in your dashboard.</p><p style="color:#999;font-size:12px">Powered by Waaiio</p>`,
              }).catch(() => {});
            }
          }
        } catch { /* non-critical */ }
      } else if (activeContract.signing_mode === 'sequential') {
        // Advance next signer from 'waiting' to 'pending'
        const nextSigner = (allSigners || []).find(s => s.status === 'waiting');
        if (nextSigner) {
          await supabase
            .from('contract_signers')
            .update({ status: 'pending' })
            .eq('id', nextSigner.id);

          // Send WhatsApp to next signer
          const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.waaiio.com';
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
          const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.waaiio.com';
          const permanentUrl = `${appUrl}/contracts/${activeContract.id}?token=${signerToken}`;
          const confirmMsg = [
            `\u2705 *Document Signed Successfully*`,
            '',
            `You have signed "${activeContract.title}" from ${businessName}.`,
            ...(activeContract.reference_code ? [`Document ID: ${activeContract.reference_code}`] : []),
            `Signature Ref: ${signatureReference}`,
            '',
            `\ud83d\udce5 Download your signed copy:`,
            permanentUrl,
            '',
            `This link is yours to keep \u2014 access your document anytime.`,
          ].join('\n');
          await sendWhatsApp(supabase, activeContract.business_id, biz?.country_code || 'NG', signerPhone, confirmMsg);
        } catch (msgErr) {
          logger.warn('Failed to send signer confirmation:', msgErr);
        }
      }

      // Email signed copy to signer (multi-signer)
      if (signerEmail && allSigned) {
        try {
          const { sendEmail } = await import('@/lib/email/client');
          const { businessFrom } = await import('@/lib/email/templates');
          const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.waaiio.com';
          const permanentUrl = `${appUrl}/contracts/${activeContract.id}?token=${signerToken}`;

          await sendEmail({
            to: signerEmail,
            from: businessFrom(businessName),
            subject: `Your signed copy \u2014 ${activeContract.title}`,
            html: `<p>Hi ${signerName},</p><p>Your signed copy of "${activeContract.title}" from ${businessName} is ready.</p><p><a href="${permanentUrl}">Download Signed Document</a></p><p>This link does not expire \u2014 access your document anytime.</p><p style="color:#999;font-size:12px">Powered by Waaiio</p>`,
          });
        } catch (emailErr) {
          logger.warn('Failed to email signed copy:', emailErr);
        }
      }

      return NextResponse.json({
        success: true,
        contract_id: activeContract.id,
        has_pdf: !!pdfPath,
        reference_code: activeContract.reference_code || null,
        signature_reference: signatureReference,
      });
    }

    // ── Single signer flow (original logic) ──
    const signatureReference = generateSigRef();
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
            referenceCode: activeContract.reference_code || undefined,
            signatureReference,
            verifyUrl: `${process.env.NEXT_PUBLIC_APP_URL || 'https://www.waaiio.com'}/contracts/${activeContract.id}?token=${signerToken}`,
          });

          pdfPath = `${activeContract.business_id}/${activeContract.id}/signed.pdf`;
          await supabase.storage.from('contracts').upload(pdfPath, pdfBuffer, {
            contentType: 'application/pdf',
            upsert: true,
          });
        }
      } catch (pdfErr) {
        logger.error('Uploaded doc PDF generation failed:', pdfErr);
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
          referenceCode: activeContract.reference_code || undefined,
          signatureReference,
          verifyUrl: `${process.env.NEXT_PUBLIC_APP_URL || 'https://www.waaiio.com'}/contracts/${activeContract.id}?token=${signerToken}`,
        });

        pdfPath = `${activeContract.business_id}/${activeContract.id}/signed.pdf`;
        await supabase.storage.from('contracts').upload(pdfPath, pdfBuffer, {
          contentType: 'application/pdf',
          upsert: true,
        });
      } catch (pdfErr) {
        logger.error('PDF generation failed (signature still saved):', pdfErr);
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
        audit_trail: { ...auditTrail, signature_reference: signatureReference },
      })
      .eq('id', activeContract.id);

    if (updateError) {
      logger.error('Failed to update contract:', updateError);
      return NextResponse.json({ error: 'Failed to save signature' }, { status: 500 });
    }

    // Send WhatsApp confirmation to signer
    if (signerPhone) {
      try {
        const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.waaiio.com';
        const permanentUrl = `${appUrl}/contracts/${activeContract.id}?token=${signerToken}`;

        const confirmMsg = [
          `\u2705 *Document Signed Successfully*`,
          '',
          `You have signed "${activeContract.title}" from ${businessName}.`,
          ...(activeContract.reference_code ? [`Document ID: ${activeContract.reference_code}`] : []),
          `Signature Ref: ${signatureReference}`,
          '',
          `\ud83d\udce5 Download your signed copy:`,
          permanentUrl,
          '',
          `This link is yours to keep \u2014 access your document anytime.`,
        ].join('\n');

        await sendWhatsApp(supabase, activeContract.business_id, biz?.country_code || 'NG', signerPhone, confirmMsg);
      } catch (msgErr) {
        logger.warn('Failed to send signing confirmation:', msgErr);
      }
    }

    // Email signed copy to signer
    if (signerEmail && pdfPath) {
      try {
        const { sendEmail } = await import('@/lib/email/client');
        const { businessFrom } = await import('@/lib/email/templates');
        const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.waaiio.com';
        const permanentUrl = `${appUrl}/contracts/${activeContract.id}?token=${signerToken}`;

        await sendEmail({
          to: signerEmail,
          from: businessFrom(businessName),
          subject: `Your signed copy \u2014 ${activeContract.title}`,
          html: `<p>Hi ${signerName},</p><p>Your signed copy of "${activeContract.title}" from ${businessName} is ready.</p><p><a href="${permanentUrl}">Download Signed Document</a></p><p>This link does not expire \u2014 access your document anytime.</p><p style="color:#999;font-size:12px">Powered by Waaiio</p>`,
        });
      } catch (emailErr) {
        logger.warn('Failed to email signed copy:', emailErr);
      }
    }

    // Notify business owner
    if (biz?.phone) {
      try {
        const ownerMsg = `"${activeContract.title}" has been signed by ${signerName}! View from your dashboard.`;
        await sendWhatsApp(supabase, activeContract.business_id, biz.country_code, biz.phone, ownerMsg);
      } catch (ownerErr) {
        logger.warn('Failed to send owner notification:', ownerErr);
      }
    }

    // Email owner about signed contract
    try {
      if (biz?.owner_id) {
        const { data: owner } = await supabase.from('profiles').select('email, first_name').eq('id', biz.owner_id).single();
        if (owner?.email) {
          const { sendEmail } = await import('@/lib/email/client');
          sendEmail({
            to: owner.email,
            subject: `Contract signed: ${activeContract.title}`,
            html: `<p>Hi ${owner.first_name || 'there'},</p><p>${signerName} signed "${activeContract.title}". View it in your dashboard.</p><p style="color:#999;font-size:12px">Powered by Waaiio</p>`,
          }).catch(() => {});
        }
      }
    } catch { /* non-critical */ }

    // Send CC notifications
    const ccList = activeContract.cc_recipients as { phone?: string; email?: string }[] | null;
    if (ccList && ccList.length > 0) {
      for (const cc of ccList) {
        if (cc.phone) {
          try {
            const ccMsg = `"${activeContract.title}" has been signed by ${signerName}. You were CC'd on this document.`;
            await sendWhatsApp(supabase, activeContract.business_id, biz?.country_code || 'NG', cc.phone, ccMsg);
          } catch (ccErr) {
            logger.warn('Failed to send CC notification:', ccErr);
          }
        }
      }
    }

    return NextResponse.json({
      success: true,
      contract_id: activeContract.id,
      has_pdf: !!pdfPath,
      reference_code: activeContract.reference_code || null,
      signature_reference: signatureReference,
    });
  } catch (err) {
    logger.error('Contract submit error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
