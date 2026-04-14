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

    // Try contracts table first
    const { data: contract } = await supabase
      .from('contracts')
      .select('id, status, otp_code, otp_expires_at, otp_attempts, otp_verified')
      .eq('token', token)
      .single();

    // Try contract_signers if not found
    let signerRow: {
      id: string; status: string; otp_code: string | null;
      otp_expires_at: string | null; otp_attempts: number | null; otp_verified: boolean | null;
    } | null = null;

    if (!contract) {
      const { data: signer } = await supabase
        .from('contract_signers')
        .select('id, status, otp_code, otp_expires_at, otp_attempts, otp_verified')
        .eq('token', token)
        .single();

      if (!signer) {
        return NextResponse.json({ error: 'Contract not found' }, { status: 404 });
      }

      signerRow = signer;
    }

    const record = contract || signerRow!;
    const table = contract ? 'contracts' : 'contract_signers';

    if (record.status !== 'pending') {
      return NextResponse.json({ error: 'Contract is not pending' }, { status: 410 });
    }

    if (record.otp_verified) {
      return NextResponse.json({ success: true, already_verified: true });
    }

    // Check attempts
    if ((record.otp_attempts || 0) >= 5) {
      return NextResponse.json({ error: 'Too many attempts. Please request a new code.' }, { status: 429 });
    }

    // Increment attempts
    await supabase
      .from(table)
      .update({ otp_attempts: (record.otp_attempts || 0) + 1 })
      .eq('id', record.id);

    // Check expiration
    if (!record.otp_expires_at || new Date(record.otp_expires_at) < new Date()) {
      return NextResponse.json({ error: 'Code has expired. Please request a new one.' }, { status: 410 });
    }

    // Check code
    if (record.otp_code !== otp) {
      return NextResponse.json({ error: 'Invalid code' }, { status: 400 });
    }

    // Mark as verified
    await supabase
      .from(table)
      .update({ otp_verified: true })
      .eq('id', record.id);

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('contracts/otp/verify error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
