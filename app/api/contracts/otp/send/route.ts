import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { ChannelResolver } from '@/lib/channels/channel-resolver';
import { GupshupService } from '@/lib/channels/gupshup';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { token } = body;

    if (!token) {
      return NextResponse.json({ error: 'token is required' }, { status: 400 });
    }

    const supabase = createServiceClient();

    const { data: contract, error } = await supabase
      .from('contracts')
      .select('id, status, token_expires_at, business_id, title, signer_phone, require_otp')
      .eq('token', token)
      .single();

    if (error || !contract) {
      return NextResponse.json({ error: 'Contract not found' }, { status: 404 });
    }

    if (contract.status !== 'pending') {
      return NextResponse.json({ error: 'Contract is not pending' }, { status: 410 });
    }

    if (!contract.require_otp) {
      return NextResponse.json({ error: 'OTP not required for this contract' }, { status: 400 });
    }

    // Generate 6-digit OTP
    const otp = String(Math.floor(100000 + Math.random() * 900000));
    const otpExpiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString(); // 10 minutes

    await supabase
      .from('contracts')
      .update({
        otp_code: otp,
        otp_expires_at: otpExpiresAt,
        otp_attempts: 0,
      })
      .eq('id', contract.id);

    // Send OTP via WhatsApp
    if (contract.signer_phone) {
      const message = `Your verification code for signing "${contract.title}" is: *${otp}*\n\nValid for 10 minutes. Do not share this code.`;
      const phone = contract.signer_phone.replace(/\D/g, '');

      const resolver = new ChannelResolver(supabase);
      const resolved =
        (await resolver.resolveByBusinessId(contract.business_id)) ||
        (await resolver.getSharedChannelForCountry('NG'));

      let sent = false;
      if (resolved) {
        try {
          const result = await resolved.sender.sendText({ to: phone, text: message });
          sent = result.success !== false;
        } catch (chErr) {
          console.warn('OTP channel send failed:', chErr);
        }
      }

      if (!sent) {
        const gupshup = new GupshupService();
        if (gupshup.isConfigured) {
          await gupshup.sendText({ to: phone, text: message });
        } else {
          console.log(`[mock] OTP to ${phone}: ${otp}`);
        }
      }
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('contracts/otp/send error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
