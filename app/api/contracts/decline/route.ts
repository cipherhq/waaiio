import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { ChannelResolver } from '@/lib/channels/channel-resolver';
import { GupshupService } from '@/lib/channels/gupshup';
import { logger } from '@/lib/logger';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { token, reason } = body;

    if (!token) {
      return NextResponse.json({ error: 'token is required' }, { status: 400 });
    }

    const supabase = createServiceClient();

    // Check single-signer contracts first
    let contract = null as { id: string; status: string; token_expires_at: string; business_id: string; title: string; signer_name: string; signer_phone: string } | null;
    let isMultiSigner = false;
    let signerId: string | null = null;

    const { data: singleContract } = await supabase
      .from('contracts')
      .select('id, status, token_expires_at, business_id, title, signer_name, signer_phone')
      .eq('token', token)
      .maybeSingle();

    if (singleContract) {
      contract = singleContract;
    } else {
      // Check multi-signer contracts
      const { data: signer } = await supabase
        .from('contract_signers')
        .select('id, contract_id, status, token_expires_at, signer_name, signer_phone')
        .eq('token', token)
        .maybeSingle();

      if (signer) {
        isMultiSigner = true;
        signerId = signer.id;
        const { data: parentContract } = await supabase
          .from('contracts')
          .select('id, status, business_id, title')
          .eq('id', signer.contract_id)
          .single();

        if (parentContract) {
          contract = {
            ...parentContract,
            token_expires_at: signer.token_expires_at,
            signer_name: signer.signer_name,
            signer_phone: signer.signer_phone,
            status: signer.status,
          };
        }
      }
    }

    if (!contract) {
      return NextResponse.json({ error: 'Contract not found' }, { status: 404 });
    }

    if (contract.status !== 'pending') {
      return NextResponse.json({ error: 'This document can no longer be declined' }, { status: 410 });
    }

    if (new Date(contract.token_expires_at) < new Date()) {
      if (isMultiSigner && signerId) {
        await supabase.from('contract_signers').update({ status: 'expired' }).eq('id', signerId);
      } else {
        await supabase.from('contracts').update({ status: 'expired' }).eq('id', contract.id);
      }
      return NextResponse.json({ error: 'This signing link has expired' }, { status: 410 });
    }

    // Update the correct table
    if (isMultiSigner && signerId) {
      const { error: updateError } = await supabase
        .from('contract_signers')
        .update({
          status: 'declined',
          declined_at: new Date().toISOString(),
          decline_reason: reason || null,
        })
        .eq('id', signerId);
      if (updateError) {
        return NextResponse.json({ error: 'Failed to decline' }, { status: 500 });
      }
      // Also mark parent contract as declined
      await supabase.from('contracts').update({ status: 'declined', declined_at: new Date().toISOString(), decline_reason: reason || null }).eq('id', contract.id);
    } else {
      const { error: updateError } = await supabase
        .from('contracts')
        .update({
          status: 'declined',
          declined_at: new Date().toISOString(),
          decline_reason: reason || null,
        })
        .eq('id', contract.id);
      if (updateError) {
        return NextResponse.json({ error: 'Failed to decline' }, { status: 500 });
      }
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
            logger.warn('Owner decline notification failed:', chErr);
          }
        }

        if (!sent) {
          const gupshup = new GupshupService();
          if (gupshup.isConfigured) {
            await gupshup.sendText({ to: ownerPhone, text: ownerMsg });
          }
        }
      } catch (msgErr) {
        logger.warn('Failed to send decline notification to owner:', msgErr);
      }
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    logger.error('contracts/decline error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
