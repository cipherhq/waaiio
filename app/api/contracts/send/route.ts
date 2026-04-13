import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { ChannelResolver } from '@/lib/channels/channel-resolver';
import { GupshupService } from '@/lib/channels/gupshup';

export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json();
    const { business_id, title, signer_phone, signer_name, signer_email, document_content, template_url } = body;

    if (!business_id || !title || !signer_phone) {
      return NextResponse.json(
        { error: 'business_id, title, and signer_phone are required' },
        { status: 400 },
      );
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

    // Generate secure token
    const tokenBytes = new Uint8Array(48);
    crypto.getRandomValues(tokenBytes);
    const token = Array.from(tokenBytes, b =>
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'[b % 62]
    ).join('');

    const expiresAt = new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString();

    // Replace template placeholders in document content
    let finalContent = document_content || null;
    if (finalContent) {
      finalContent = finalContent
        .replace(/\{\{business_name\}\}/g, biz.name)
        .replace(/\{\{signer_name\}\}/g, signer_name || 'Signer')
        .replace(/\{\{date\}\}/g, new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }));
    }

    const { data: contract, error } = await service
      .from('contracts')
      .insert({
        business_id,
        title,
        template_url: template_url || null,
        signer_name: signer_name || null,
        signer_phone,
        signer_email: signer_email || null,
        document_content: finalContent,
        token,
        token_expires_at: expiresAt,
        status: 'pending',
      })
      .select('id')
      .single();

    if (error || !contract) {
      console.error('Failed to create contract:', error);
      return NextResponse.json({ error: 'Failed to create contract' }, { status: 500 });
    }

    const appUrl = process.env.NEXT_PUBLIC_APP_URL || process.env.NEXT_PUBLIC_SITE_URL || 'https://app.waaiio.com';
    const signUrl = `${appUrl}/sign/${token}`;

    const message = [
      `\ud83d\udcdd *Document for Signature*`,
      '',
      `${biz.name} has sent you a document to sign:`,
      `\ud83d\udcc4 ${title}`,
      '',
      `Please tap the link below to review and sign:`,
      signUrl,
      '',
      `\u23f0 This link expires in 72 hours.`,
    ].join('\n');

    // Resolve WhatsApp channel: try business dedicated → shared country
    const resolver = new ChannelResolver(service);
    const resolved =
      (await resolver.resolveByBusinessId(business_id)) ||
      (await resolver.getSharedChannelForCountry(biz.country_code || 'NG'));

    const phone = signer_phone.replace(/\D/g, '');
    let sent = false;

    if (resolved) {
      try {
        const result = await resolved.sender.sendText({ to: phone, text: message });
        sent = result.success !== false;
      } catch (waErr) {
        console.warn('Primary channel send failed, trying Gupshup fallback:', waErr);
      }
    }

    // Fallback: use default Gupshup env credentials if primary failed or not found
    if (!sent) {
      const gupshup = new GupshupService();
      if (gupshup.isConfigured) {
        const result = await gupshup.sendText({ to: phone, text: message });
        if (!result.success) {
          console.warn('Gupshup fallback also failed (contract still created)');
        }
      } else {
        console.log(`[mock] WhatsApp to ${phone}: Sign "${title}" at ${signUrl}`);
      }
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
