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
    const { contract_id } = body;

    if (!contract_id) {
      return NextResponse.json({ error: 'contract_id is required' }, { status: 400 });
    }

    const service = createServiceClient();

    // Fetch existing contract
    const { data: contract, error } = await service
      .from('contracts')
      .select('id, business_id, title, signer_phone, signer_name, status')
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

    // Generate new token
    const tokenBytes = new Uint8Array(48);
    crypto.getRandomValues(tokenBytes);
    const token = Array.from(tokenBytes, b =>
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'[b % 62]
    ).join('');

    const expiresAt = new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString();

    // Update existing contract with new token (no new row)
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

    const appUrl = process.env.NEXT_PUBLIC_APP_URL || process.env.NEXT_PUBLIC_SITE_URL || 'https://app.waaiio.com';
    const signUrl = `${appUrl}/sign/${token}`;

    const message = [
      `\ud83d\udcdd *Document for Signature*`,
      '',
      `${biz.name} has sent you a document to sign:`,
      `\ud83d\udcc4 ${contract.title}`,
      '',
      `Please tap the link below to review and sign:`,
      signUrl,
      '',
      `\u23f0 This link expires in 72 hours.`,
    ].join('\n');

    // Send WhatsApp message
    const resolver = new ChannelResolver(service);
    const resolved =
      (await resolver.resolveByBusinessId(contract.business_id)) ||
      (await resolver.getSharedChannelForCountry(biz.country_code || 'NG'));

    const phone = contract.signer_phone.replace(/\D/g, '');
    let sent = false;

    if (resolved) {
      try {
        const result = await resolved.sender.sendText({ to: phone, text: message });
        sent = result.success !== false;
      } catch (waErr) {
        console.warn('Primary channel send failed, trying Gupshup fallback:', waErr);
      }
    }

    if (!sent) {
      const gupshup = new GupshupService();
      if (gupshup.isConfigured) {
        const result = await gupshup.sendText({ to: phone, text: message });
        if (!result.success) {
          console.warn('Gupshup fallback also failed (contract token updated)');
        }
      } else {
        console.log(`[mock] WhatsApp to ${phone}: Re-sign "${contract.title}" at ${signUrl}`);
      }
    }

    return NextResponse.json({
      sign_url: signUrl,
      contract_id: contract.id,
      expires_at: expiresAt,
    });
  } catch (err) {
    console.error('contracts/resend error:', err);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 },
    );
  }
}
