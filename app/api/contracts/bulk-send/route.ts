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

export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json();
    const { business_id, title, recipients, document_content, template_url, require_otp } = body;

    if (!business_id || !title || !recipients || !Array.isArray(recipients) || recipients.length === 0) {
      return NextResponse.json(
        { error: 'business_id, title, and recipients array are required' },
        { status: 400 },
      );
    }

    if (recipients.length > 50) {
      return NextResponse.json({ error: 'Maximum 50 recipients per bulk send' }, { status: 400 });
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

    // Replace template placeholders
    let finalContent = document_content || null;
    if (finalContent) {
      finalContent = finalContent
        .replace(/\{\{business_name\}\}/g, biz.name)
        .replace(/\{\{date\}\}/g, new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }));
    }

    const results: { phone: string; success: boolean; contract_id?: string; message_delivered?: boolean }[] = [];

    // Resolve WhatsApp channel once
    const resolver = new ChannelResolver(service);
    const resolved =
      (await resolver.resolveByBusinessId(business_id)) ||
      (await resolver.getSharedChannelForCountry(biz.country_code || 'NG'));

    for (const recipient of recipients) {
      const phone = recipient.phone?.replace(/\D/g, '');
      if (!phone) {
        results.push({ phone: recipient.phone || '', success: false });
        continue;
      }

      const token = generateToken();

      // Personalize content per recipient
      let recipientContent = finalContent;
      if (recipientContent && recipient.name) {
        recipientContent = recipientContent.replace(/\{\{signer_name\}\}/g, recipient.name);
      }

      const { data: contract, error } = await service
        .from('contracts')
        .insert({
          business_id,
          title,
          template_url: template_url || null,
          signer_name: recipient.name || null,
          signer_phone: recipient.phone,
          signer_email: recipient.email || null,
          document_content: recipientContent,
          token,
          token_expires_at: expiresAt,
          status: 'pending',
          require_otp: !!require_otp,
          signing_mode: 'single',
        })
        .select('id')
        .single();

      if (error || !contract) {
        results.push({ phone: recipient.phone, success: false });
        continue;
      }

      const signUrl = `${appUrl}/sign/${token}`;
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

      let sent = false;
      if (resolved) {
        try {
          const result = await resolved.sender.sendText({ to: phone, text: message });
          sent = result.success !== false;
        } catch (err) {
          console.warn(`[CONTRACT-BULK] Primary channel failed for ${phone}:`, err);
        }
      }

      if (!sent) {
        const gupshup = new GupshupService();
        if (gupshup.isConfigured) {
          const result = await gupshup.sendText({ to: phone, text: message });
          sent = result.success !== false;
          if (!sent) {
            console.warn(`[CONTRACT-BULK] Gupshup fallback failed for ${phone}`);
          }
        } else {
          console.warn(`[CONTRACT-BULK] No WhatsApp channel configured. Message NOT delivered to ${phone}.`);
        }
      }

      results.push({ phone: recipient.phone, success: true, contract_id: contract.id, message_delivered: sent });
    }

    return NextResponse.json({
      total: recipients.length,
      sent: results.filter(r => r.success).length,
      results,
    });
  } catch (err) {
    console.error('contracts/bulk-send error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
