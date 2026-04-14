import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { ChannelResolver } from '@/lib/channels/channel-resolver';
import { GupshupService } from '@/lib/channels/gupshup';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { token, reason } = body;

    if (!token) {
      return NextResponse.json({ error: 'token is required' }, { status: 400 });
    }

    const supabase = createServiceClient();

    const { data: contract, error } = await supabase
      .from('contracts')
      .select('id, status, token_expires_at, business_id, title, signer_name, signer_phone')
      .eq('token', token)
      .single();

    if (error || !contract) {
      return NextResponse.json({ error: 'Contract not found' }, { status: 404 });
    }

    if (contract.status !== 'pending') {
      return NextResponse.json({ error: 'This document can no longer be declined' }, { status: 410 });
    }

    if (new Date(contract.token_expires_at) < new Date()) {
      await supabase.from('contracts').update({ status: 'expired' }).eq('id', contract.id);
      return NextResponse.json({ error: 'This signing link has expired' }, { status: 410 });
    }

    const { error: updateError } = await supabase
      .from('contracts')
      .update({
        status: 'declined',
        declined_at: new Date().toISOString(),
        decline_reason: reason || null,
      })
      .eq('id', contract.id);

    if (updateError) {
      console.error('Failed to decline contract:', updateError);
      return NextResponse.json({ error: 'Failed to decline' }, { status: 500 });
    }

    // Notify business owner
    const { data: biz } = await supabase
      .from('businesses')
      .select('name, phone, country_code')
      .eq('id', contract.business_id)
      .single();

    if (biz?.phone) {
      try {
        const signerLabel = contract.signer_name || 'The signer';
        const reasonText = reason ? ` Reason: ${reason}` : '';
        const ownerMsg = `${signerLabel} has declined "${contract.title}".${reasonText}`;
        const ownerPhone = biz.phone.replace(/\D/g, '');

        const resolver = new ChannelResolver(supabase);
        const resolved =
          (await resolver.resolveByBusinessId(contract.business_id)) ||
          (await resolver.getSharedChannelForCountry(biz.country_code || 'NG'));

        let sent = false;
        if (resolved) {
          try {
            const result = await resolved.sender.sendText({ to: ownerPhone, text: ownerMsg });
            sent = result.success !== false;
          } catch (chErr) {
            console.warn('Owner decline notification failed:', chErr);
          }
        }

        if (!sent) {
          const gupshup = new GupshupService();
          if (gupshup.isConfigured) {
            await gupshup.sendText({ to: ownerPhone, text: ownerMsg });
          }
        }
      } catch (msgErr) {
        console.warn('Failed to send decline notification to owner:', msgErr);
      }
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('contracts/decline error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
