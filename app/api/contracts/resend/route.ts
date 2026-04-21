import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { ChannelResolver } from '@/lib/channels/channel-resolver';
import { GupshupService } from '@/lib/channels/gupshup';

function generateToken(): string {
  const tokenBytes = new Uint8Array(24);
  crypto.getRandomValues(tokenBytes);
  return Array.from(tokenBytes, b =>
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'[b % 62]
  ).join('');
}

async function sendWhatsAppMessage(
  service: ReturnType<typeof createServiceClient>,
  businessId: string,
  countryCode: string,
  phone: string,
  message: string,
): Promise<{ messageId: string | null; delivered: boolean }> {
  const cleanPhone = phone.replace(/\D/g, '');
  const resolver = new ChannelResolver(service);
  const resolved =
    (await resolver.resolveByBusinessId(businessId)) ||
    (await resolver.getSharedChannelForCountry(countryCode || 'NG'));

  let sent = false;
  let messageId: string | null = null;

  if (resolved) {
    try {
      const result = await resolved.sender.sendText({ to: cleanPhone, text: message });
      sent = result.success !== false;
      if (sent && result.messageId) messageId = result.messageId;
    } catch (waErr) {
      console.warn(`[CONTRACT-RESEND] Primary channel send failed for ${cleanPhone}:`, waErr);
    }
  } else {
    console.warn(`[CONTRACT-RESEND] No WhatsApp channel found for business ${businessId} (country: ${countryCode})`);
  }

  if (!sent) {
    const gupshup = new GupshupService();
    if (gupshup.isConfigured) {
      const result = await gupshup.sendText({ to: cleanPhone, text: message });
      if (result.success && result.messageId) {
        messageId = result.messageId;
        sent = true;
      }
      if (!result.success) {
        console.warn(`[CONTRACT-RESEND] Gupshup fallback also failed for ${cleanPhone}`);
      }
    } else {
      console.warn(`[CONTRACT-RESEND] No WhatsApp channel configured for business ${businessId}. Message NOT delivered to ${cleanPhone}.`);
    }
  }

  return { messageId, delivered: sent };
}

export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json();
    const { contract_id } = body;

    if (!contract_id) {
      return NextResponse.json({ error: 'contract_id is required' }, { status: 400 });
    }

    const service = createServiceClient();

    // Fetch existing contract
    const { data: contract, error } = await service
      .from('contracts')
      .select('id, business_id, title, signer_phone, signer_name, status, signing_mode')
      .eq('id', contract_id)
      .single();

    if (error || !contract) {
      return NextResponse.json({ error: 'Contract not found' }, { status: 404 });
    }

    // Verify user owns the business
    const { data: biz } = await supabase
      .from('businesses')
      .select('id, name, owner_id, country_code')
      .eq('id', contract.business_id)
      .single();

    if (!biz || biz.owner_id !== user.id) {
      return NextResponse.json({ error: 'Business not found' }, { status: 403 });
    }

    if (contract.status === 'signed') {
      return NextResponse.json({ error: 'This contract has already been signed' }, { status: 400 });
    }

    const appUrl = process.env.NEXT_PUBLIC_APP_URL || process.env.NEXT_PUBLIC_SITE_URL || 'https://app.waaiio.com';
    const expiresAt = new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString();

    // Check if this is a multi-signer contract
    const { data: signers } = await service
      .from('contract_signers')
      .select('id, signer_phone, signer_name, status, token')
      .eq('contract_id', contract.id);

    if (signers && signers.length > 0) {
      // Multi-signer: regenerate tokens for pending/expired signers and re-send
      let resent = 0;
      for (const signer of signers) {
        if (signer.status === 'signed' || signer.status === 'declined') continue;

        const newToken = generateToken();
        await service
          .from('contract_signers')
          .update({
            token: newToken,
            token_expires_at: expiresAt,
            status: signer.status === 'waiting' ? 'waiting' : 'pending',
          })
          .eq('id', signer.id);

        // Only send WhatsApp to pending (not waiting) signers
        if (signer.status !== 'waiting') {
          const signUrl = `${appUrl}/sign/${newToken}`;
          const message = [
            `\ud83d\udcdd *Document for Signature*`,
            '',
            `${biz.name} has sent you a document to sign:`,
            `\ud83d\udcc4 ${contract.title}`,
            '',
            `\ud83d\udc49 ${signUrl}`,
            '',
            `\u23f0 Expires in 72 hours.`,
          ].join('\n');

          const { messageId: waMessageId, delivered } = await sendWhatsAppMessage(service, contract.business_id, biz.country_code, signer.signer_phone, message);
          if (delivered && waMessageId) {
            await service
              .from('contract_signers')
              .update({ wa_message_id: waMessageId, wa_delivery_status: 'sent', wa_status_updated_at: new Date().toISOString() })
              .eq('id', signer.id);
          }
          if (delivered) resent++;
        }
      }

      // Update parent contract expiry too
      const newParentToken = generateToken();
      await service
        .from('contracts')
        .update({ token: newParentToken, token_expires_at: expiresAt, status: 'pending' })
        .eq('id', contract.id);

      return NextResponse.json({
        contract_id: contract.id,
        resent_count: resent,
        expires_at: expiresAt,
      });
    }

    // Single signer flow
    if (!contract.signer_phone) {
      return NextResponse.json({ error: 'No signer phone number on this contract' }, { status: 400 });
    }

    const token = generateToken();

    const { error: updateError } = await service
      .from('contracts')
      .update({
        token,
        token_expires_at: expiresAt,
        status: 'pending',
      })
      .eq('id', contract.id);

    if (updateError) {
      console.error('Failed to update contract token:', updateError);
      return NextResponse.json({ error: 'Failed to regenerate link' }, { status: 500 });
    }

    const signUrl = `${appUrl}/sign/${token}`;

    const message = [
      `\ud83d\udcdd *Document for Signature*`,
      '',
      `${biz.name} has sent you a document to sign:`,
      `\ud83d\udcc4 ${contract.title}`,
      '',
      `\ud83d\udc49 ${signUrl}`,
      '',
      `\u23f0 Expires in 72 hours.`,
    ].join('\n');

    const { messageId: waMessageId, delivered } = await sendWhatsAppMessage(service, contract.business_id, biz.country_code, contract.signer_phone, message);
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
    console.error('contracts/resend error:', err);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 },
    );
  }
}
