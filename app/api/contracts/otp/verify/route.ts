import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { token, otp } = body;

    if (!token || !otp) {
      return NextResponse.json({ error: 'token and otp are required' }, { status: 400 });
    }

    const supabase = createServiceClient();

    const { data: contract, error } = await supabase
      .from('contracts')
      .select('id, status, otp_code, otp_expires_at, otp_attempts, otp_verified')
      .eq('token', token)
      .single();

    if (error || !contract) {
      return NextResponse.json({ error: 'Contract not found' }, { status: 404 });
    }

    if (contract.status !== 'pending') {
      return NextResponse.json({ error: 'Contract is not pending' }, { status: 410 });
    }

    if (contract.otp_verified) {
      return NextResponse.json({ success: true, already_verified: true });
    }

    // Check attempts
    if ((contract.otp_attempts || 0) >= 5) {
      return NextResponse.json({ error: 'Too many attempts. Please request a new code.' }, { status: 429 });
    }

    // Increment attempts
    await supabase
      .from('contracts')
      .update({ otp_attempts: (contract.otp_attempts || 0) + 1 })
      .eq('id', contract.id);

    // Check expiration
    if (!contract.otp_expires_at || new Date(contract.otp_expires_at) < new Date()) {
      return NextResponse.json({ error: 'Code has expired. Please request a new one.' }, { status: 410 });
    }

    // Check code
    if (contract.otp_code !== otp) {
      return NextResponse.json({ error: 'Invalid code' }, { status: 400 });
    }

    // Mark as verified
    await supabase
      .from('contracts')
      .update({ otp_verified: true })
      .eq('id', contract.id);

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('contracts/otp/verify error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
