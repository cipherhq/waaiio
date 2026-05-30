import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { ChannelResolver } from '@/lib/channels/channel-resolver';
import { logger } from '@/lib/logger';

function generateToken(): string {
  const tokenBytes = new Uint8Array(24);
  crypto.getRandomValues(tokenBytes);
  return Array.from(tokenBytes, b =>
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'[b % 62]
  ).join('');
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

    // Fallback to plain text (works within 24h conversation window)
    if (!sent) {
      try {
        const result = await resolved.sender.sendText({ to: cleanPhone, text: message });
        sent = result.success !== false;
        if (sent && result.messageId) messageId = result.messageId;
      } catch (waErr) {
        logger.warn(`[CONTRACT] sendText also failed for ${cleanPhone}:`, waErr);
      }
    }
  } else {
    logger.warn(`[CONTRACT] No WhatsApp channel found for business ${businessId} (country: ${countryCode}). Message NOT delivered to ${cleanPhone}.`);
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

    // Check conversation limit before sending WhatsApp messages
    const { checkConversationLimit } = await import('@/lib/bot/conversation-guard');
    const service = createServiceClient();
    const convLimit = await checkConversationLimit(service, business_id);
    if (!convLimit.allowed) {
      return NextResponse.json({ error: `Monthly conversation limit reached (${convLimit.used}/${convLimit.limit}). Upgrade for more.` }, { status: 403 });
    }
    const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://waaiio.com';
    const expiresAt = new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString();

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
