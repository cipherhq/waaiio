import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { ChannelResolver } from '@/lib/channels/channel-resolver';
import { logger } from '@/lib/logger';
import { sendOrEmail, findCustomerEmail } from '@/lib/channels/send-or-email';
import { businessNotificationEmail } from '@/lib/email/templates';
import { loadPlatformSettings } from '@/lib/platformSettings';

function generateToken(): string {
  const tokenBytes = new Uint8Array(24);
  crypto.getRandomValues(tokenBytes);
  return Array.from(tokenBytes, b =>
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'[b % 62]
  ).join('');
}

function generateDocRef(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return `WA-DOC-${code}`;
}

const CONTRACT_TEMPLATE_NAME = process.env.WHATSAPP_CONTRACT_TEMPLATE || 'document_signature_request';

async function sendWhatsAppMessage(
  service: ReturnType<typeof createServiceClient>,
  businessId: string,
  countryCode: string,
  phone: string,
  message: string,
  templateParams?: { businessName: string; title: string; signUrl: string; signerName?: string; token?: string },
): Promise<{ messageId: string | null; delivered: boolean }> {
  const resolver = new ChannelResolver(service);
  const resolved =
    (await resolver.resolveByBusinessId(businessId)) ||
    (await resolver.getSharedChannelForCountry(countryCode || 'NG'));

  const cleanPhone = phone.replace(/\D/g, '');
  let sent = false;
  let messageId: string | null = null;

  if (resolved) {
    // Try template message FIRST (works outside 24h window — business-initiated)
    if (resolved.sender.sendTemplate && templateParams) {
      try {
        // Template body: {{1}}=signer name, {{2}}=business name, {{3}}=document title
        // Template button URL: https://waaiio.com/sign/{{1}} — needs token
        const result = await resolved.sender.sendTemplate({
          to: cleanPhone,
          templateName: CONTRACT_TEMPLATE_NAME,
          templateParams: [
            templateParams.signerName || 'there',
            templateParams.businessName,
            templateParams.title,
          ],
          buttonParams: templateParams.token ? [templateParams.token] : undefined,
        });
        sent = result.success !== false;
        if (sent && result.messageId) messageId = result.messageId;
        if (sent) logger.info(`[CONTRACT] Template message sent to ${cleanPhone}`);
      } catch (tmplErr) {
        logger.warn(`[CONTRACT] Template message failed for ${cleanPhone}:`, tmplErr);
      }
    }

    // Fallback: use sendOrEmail for WhatsApp text + email dual delivery
    if (!sent) {
      const customerEmail = await findCustomerEmail(service, cleanPhone, businessId);
      let emailOpt: { address: string; subject: string; html: string } | null = null;
      if (customerEmail) {
        const tmpl = businessNotificationEmail({
          businessName: templateParams?.businessName || 'Business',
          title: 'Document for Signature',
          message: `You have a document to sign: ${templateParams?.title || 'Untitled'}`,
          details: { Document: templateParams?.title || '', Expires: 'in 72 hours' },
          ctaLabel: 'Sign Document',
          ctaUrl: templateParams?.signUrl,
        });
        emailOpt = { address: customerEmail, subject: tmpl.subject, html: tmpl.html };
      }

      const result = await sendOrEmail({
        supabase: service,
        sender: resolved.sender,
        to: cleanPhone,
        text: message,
        email: emailOpt,
        businessName: templateParams?.businessName,
        alwaysEmail: true,
      });
      sent = result.whatsapp === 'sent';
    }
  } else {
    // No WhatsApp channel — try email-only as last resort
    const customerEmail = await findCustomerEmail(service, cleanPhone, businessId);
    if (customerEmail && templateParams) {
      const emailPayload = businessNotificationEmail({
        businessName: templateParams.businessName,
        title: 'Document for Signature',
        message: `You have a document to sign: ${templateParams.title}`,
        details: { Document: templateParams.title, Expires: 'in 72 hours' },
        ctaLabel: 'Sign Document',
        ctaUrl: templateParams.signUrl,
      });
      try {
        const { sendEmail } = await import('@/lib/email/client');
        await sendEmail({ to: customerEmail, subject: emailPayload.subject, html: emailPayload.html });
        sent = true;
        logger.info(`[CONTRACT] Email-only delivery to ${customerEmail} (no WhatsApp channel)`);
      } catch (emailErr) {
        logger.error(`[CONTRACT] Email fallback also failed for ${customerEmail}:`, emailErr);
      }
    } else {
      logger.warn(`[CONTRACT] No WhatsApp channel found for business ${businessId} (country: ${countryCode}). Message NOT delivered to ${cleanPhone}.`);
    }
  }

  return { messageId, delivered: sent };
}

interface SignerInput {
  name?: string;
  phone: string;
  email?: string;
}

export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json();
    const {
      business_id, title, signer_phone, signer_name, signer_email,
      document_content, template_url, require_otp,
      signers, signing_mode, cc_recipients,
    } = body;

    if (!business_id || !title) {
      return NextResponse.json(
        { error: 'business_id and title are required' },
        { status: 400 },
      );
    }

    // Need at least one signer (legacy single or new multi)
    const multiSigners: SignerInput[] = signers && signers.length > 0
      ? signers
      : signer_phone
        ? [{ name: signer_name, phone: signer_phone, email: signer_email }]
        : [];

    if (multiSigners.length === 0) {
      return NextResponse.json({ error: 'At least one signer is required' }, { status: 400 });
    }

    // Verify the user owns this business
    const { data: biz } = await supabase
      .from('businesses')
      .select('id, name, owner_id, country_code')
      .eq('id', business_id)
      .single();

    if (!biz || biz.owner_id !== user.id) {
      return NextResponse.json({ error: 'Business not found' }, { status: 403 });
    }

    // ── Capability check: whatsapp_sign ──
    const { data: signCap } = await supabase
      .from('business_capabilities')
      .select('id')
      .eq('business_id', business_id)
      .eq('capability', 'whatsapp_sign')
      .eq('is_enabled', true)
      .maybeSingle();
    if (!signCap) return NextResponse.json({ error: 'Feature not enabled' }, { status: 403 });

    // Check conversation limit before sending WhatsApp messages
    const { checkConversationLimit } = await import('@/lib/bot/conversation-guard');
    const service = createServiceClient();
    const convLimit = await checkConversationLimit(service, business_id);
    if (!convLimit.allowed) {
      return NextResponse.json({ error: `Monthly conversation limit reached (${convLimit.used}/${convLimit.limit}). Upgrade for more.` }, { status: 403 });
    }
    const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.waaiio.com';
    const settings = await loadPlatformSettings({ useServiceClient: true });
    const expiresAt = new Date(Date.now() + settings.contract_signing_hours * 60 * 60 * 1000).toISOString();

    // Replace template placeholders in document content
    let finalContent = document_content || null;
    if (finalContent) {
      finalContent = finalContent
        .replace(/\{\{business_name\}\}/g, biz.name)
        .replace(/\{\{signer_name\}\}/g, multiSigners[0]?.name || 'Signer')
        .replace(/\{\{date\}\}/g, new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }));
    }

    const isMulti = multiSigners.length > 1;
    const mode = isMulti ? (signing_mode || 'parallel') : 'single';

    // Generate primary token for single-signer backward compat
    const primaryToken = generateToken();

    const referenceCode = generateDocRef();

    const { data: contract, error } = await service
      .from('contracts')
      .insert({
        business_id,
        title,
        template_url: template_url || null,
        signer_name: isMulti ? null : (multiSigners[0]?.name || null),
        signer_phone: isMulti ? null : multiSigners[0]?.phone,
        signer_email: isMulti ? null : (multiSigners[0]?.email || null),
        document_content: finalContent,
        token: primaryToken,
        token_expires_at: expiresAt,
        status: 'pending',
        require_otp: !!require_otp,
        signing_mode: mode,
        cc_recipients: cc_recipients || [],
        reference_code: referenceCode,
      })
      .select('id')
      .single();

    if (error || !contract) {
      logger.error('Failed to create contract:', error);
      return NextResponse.json({ error: 'Failed to create contract' }, { status: 500 });
    }

    if (isMulti) {
      // Create signer rows
      const signerRows = multiSigners.map((s, i) => {
        const signerToken = generateToken();
        const isActive = mode === 'parallel' || i === 0;
        return {
          contract_id: contract.id,
          signer_name: s.name || null,
          signer_phone: s.phone,
          signer_email: s.email || null,
          signing_order: i + 1,
          token: signerToken,
          token_expires_at: expiresAt,
          status: isActive ? 'pending' : 'waiting',
        };
      });

      const { data: insertedSigners, error: signerError } = await service
        .from('contract_signers')
        .insert(signerRows)
        .select('id, token, signer_phone, signer_name, status');

      if (signerError) {
        logger.error('Failed to create signers:', signerError);
        return NextResponse.json({ error: 'Failed to create signers' }, { status: 500 });
      }

      // Send WhatsApp to active (pending) signers
      let deliveredCount = 0;
      for (const signer of (insertedSigners || []).filter(s => s.status === 'pending')) {
        const signUrl = `${appUrl}/sign/${signer.token}`;
        const message = [
          `\ud83d\udcdd *Document for Signature*`,
          '',
          `${biz.name} has sent you a document to sign:`,
          `\ud83d\udcc4 ${title}`,
          '',
          `\ud83d\udc49 ${signUrl}`,
          '',
          `\u23f0 Expires in 72 hours.`,
        ].join('\n');

        const { messageId: waMessageId, delivered } = await sendWhatsAppMessage(
          service, business_id, biz.country_code, signer.signer_phone, message,
          { businessName: biz.name, title, signUrl, signerName: signer.signer_name || undefined, token: signer.token },
        );
        if (delivered && waMessageId) {
          await service
            .from('contract_signers')
            .update({ wa_message_id: waMessageId, wa_delivery_status: 'sent', wa_status_updated_at: new Date().toISOString() })
            .eq('id', signer.id);
          deliveredCount++;
        }
      }

      return NextResponse.json({
        contract_id: contract.id,
        signers_count: multiSigners.length,
        signing_mode: mode,
        expires_at: expiresAt,
        messages_delivered: deliveredCount,
      });
    }

    // Single signer flow
    const signUrl = `${appUrl}/sign/${primaryToken}`;

    const message = [
      `\ud83d\udcdd *Document for Signature*`,
      '',
      `${biz.name} has sent you a document to sign:`,
      `\ud83d\udcc4 ${title}`,
      '',
      `\ud83d\udc49 ${signUrl}`,
      '',
      `\u23f0 Expires in 72 hours.`,
    ].join('\n');

    const { messageId: waMessageId, delivered } = await sendWhatsAppMessage(
      service, business_id, biz.country_code, signer_phone, message,
      { businessName: biz.name, title, signUrl, signerName: signer_name || undefined, token: primaryToken },
    );
    if (delivered && waMessageId) {
      await service
        .from('contracts')
        .update({ wa_message_id: waMessageId, wa_delivery_status: 'sent', wa_status_updated_at: new Date().toISOString() })
        .eq('id', contract.id);
    }

    return NextResponse.json({
      sign_url: signUrl,
      contract_id: contract.id,
      expires_at: expiresAt,
      message_delivered: delivered,
    });
  } catch (err) {
    logger.error('contracts/send error:', err);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 },
    );
  }
}
