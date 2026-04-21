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
): Promise<string | null> {
  const resolver = new ChannelResolver(service);
  const resolved =
    (await resolver.resolveByBusinessId(businessId)) ||
    (await resolver.getSharedChannelForCountry(countryCode || 'NG'));

  const cleanPhone = phone.replace(/\D/g, '');
  let sent = false;
  let messageId: string | null = null;

  if (resolved) {
    try {
      const result = await resolved.sender.sendText({ to: cleanPhone, text: message });
      sent = result.success !== false;
      if (sent && result.messageId) messageId = result.messageId;
    } catch (waErr) {
      console.warn('Primary channel send failed, trying Gupshup fallback:', waErr);
    }
  }

  if (!sent) {
    const gupshup = new GupshupService();
    if (gupshup.isConfigured) {
      const result = await gupshup.sendText({ to: cleanPhone, text: message });
      if (result.success && result.messageId) messageId = result.messageId;
      if (!result.success) {
        console.warn('Gupshup fallback also failed');
      }
    } else {
      console.log(`[mock] WhatsApp to ${cleanPhone}: ${message.slice(0, 80)}...`);
    }
  }

  return messageId;
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

    const service = createServiceClient();
    const appUrl = process.env.NEXT_PUBLIC_APP_URL || process.env.NEXT_PUBLIC_SITE_URL || 'https://app.waaiio.com';
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
      console.error('Failed to create contract:', error);
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
        console.error('Failed to create signers:', signerError);
        return NextResponse.json({ error: 'Failed to create signers' }, { status: 500 });
      }

      // Send WhatsApp to active (pending) signers
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

        const waMessageId = await sendWhatsAppMessage(service, business_id, biz.country_code, signer.signer_phone, message);
        if (waMessageId) {
          await service
            .from('contract_signers')
            .update({ wa_message_id: waMessageId, wa_delivery_status: 'sent', wa_status_updated_at: new Date().toISOString() })
            .eq('id', signer.id);
        }
      }

      return NextResponse.json({
        contract_id: contract.id,
        signers_count: multiSigners.length,
        signing_mode: mode,
        expires_at: expiresAt,
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

    const waMessageId = await sendWhatsAppMessage(service, business_id, biz.country_code, signer_phone, message);
    if (waMessageId) {
      await service
        .from('contracts')
        .update({ wa_message_id: waMessageId, wa_delivery_status: 'sent', wa_status_updated_at: new Date().toISOString() })
        .eq('id', contract.id);
    }

    return NextResponse.json({
      sign_url: signUrl,
      contract_id: contract.id,
      expires_at: expiresAt,
    });
  } catch (err) {
    console.error('contracts/send error:', err);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 },
    );
  }
}
