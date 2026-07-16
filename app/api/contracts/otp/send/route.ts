import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { ChannelResolver } from '@/lib/channels/channel-resolver';
import { rateLimitResponseAsync, getRateLimitKey } from '@/lib/rate-limit';
import { logger } from '@/lib/logger';

export async function POST(request: NextRequest) {
  try {
    const rl = await rateLimitResponseAsync(getRateLimitKey(request, 'otp-send'), 3, 600_000); // 3 per 10 min
    if (rl) return rl;

    const body = await request.json();
    const { token } = body;

    if (!token) {
      return NextResponse.json({ error: 'token is required' }, { status: 400 });
    }

    const supabase = createServiceClient();

    // Try contracts table first
    const { data: contract } = await supabase
      .from('contracts')
      .select('id, status, token_expires_at, business_id, title, signer_phone, require_otp')
      .eq('token', token)
      .single();

    // Try contract_signers if not found
    let signerRow: { id: string; signer_phone: string; status: string; contract_id: string } | null = null;
    let parentContract: typeof contract = null;

    if (!contract) {
      const { data: signer } = await supabase
        .from('contract_signers')
        .select('id, signer_phone, status, contract_id')
        .eq('token', token)
        .single();

      if (!signer) {
        return NextResponse.json({ error: 'Contract not found' }, { status: 404 });
      }

      signerRow = signer;

      const { data: parent } = await supabase
        .from('contracts')
        .select('id, status, token_expires_at, business_id, title, signer_phone, require_otp')
        .eq('id', signer.contract_id)
        .single();

      if (!parent) {
        return NextResponse.json({ error: 'Contract not found' }, { status: 404 });
      }

      parentContract = parent;
    }

    const activeContract = contract || parentContract!;
    const signerStatus = signerRow ? signerRow.status : activeContract.status;
    const signerPhone = signerRow ? signerRow.signer_phone : activeContract.signer_phone;

    if (signerStatus !== 'pending') {
      return NextResponse.json({ error: 'Contract is not pending' }, { status: 410 });
    }

    if (!activeContract.require_otp) {
      return NextResponse.json({ error: 'OTP not required for this contract' }, { status: 400 });
    }

    // Generate 6-digit OTP using cryptographically secure random
    const { randomInt } = await import('crypto');
    const otp = String(randomInt(100000, 999999));
    const otpExpiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

    if (signerRow) {
      await supabase
        .from('contract_signers')
        .update({ otp_code: otp, otp_expires_at: otpExpiresAt, otp_attempts: 0 })
        .eq('id', signerRow.id);
    } else {
      await supabase
        .from('contracts')
        .update({ otp_code: otp, otp_expires_at: otpExpiresAt, otp_attempts: 0 })
        .eq('id', activeContract.id);
    }

    // Send OTP via WhatsApp
    if (signerPhone) {
      const message = `Your verification code for signing "${activeContract.title}" is: *${otp}*\n\nValid for 10 minutes. Do not share this code.`;
      const phone = signerPhone.replace(/\D/g, '');

      const resolver = new ChannelResolver(supabase);
      const resolved =
        (await resolver.resolveByBusinessId(activeContract.business_id)) ||
        (await resolver.getSharedChannelForCountry('NG'));

      if (resolved) {
        try {
          await resolved.sender.sendText({ to: phone, text: message });
        } catch (chErr) {
          logger.warn('OTP channel send failed:', chErr);
        }
      } else {
        logger.warn(`[CONTRACT-OTP] No WhatsApp channel configured for business ${activeContract.business_id}. OTP NOT delivered to ${phone}.`);
      }
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    logger.error('contracts/otp/send error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
