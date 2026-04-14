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

    if (contract.status !== 'pending') {
      return NextResponse.json({ error: 'Only pending contracts can be revoked' }, { status: 400 });
    }

    const { error: updateError } = await service
      .from('contracts')
      .update({ status: 'revoked' })
      .eq('id', contract.id);

    if (updateError) {
      console.error('Failed to revoke contract:', updateError);
      return NextResponse.json({ error: 'Failed to revoke contract' }, { status: 500 });
    }

    // Notify signer via WhatsApp
    if (contract.signer_phone) {
      try {
        const message = `The document "${contract.title}" from ${biz.name} has been cancelled.`;
        const phone = contract.signer_phone.replace(/\D/g, '');

        const resolver = new ChannelResolver(service);
        const resolved =
          (await resolver.resolveByBusinessId(contract.business_id)) ||
          (await resolver.getSharedChannelForCountry(biz.country_code || 'NG'));

        let sent = false;
        if (resolved) {
          try {
            const result = await resolved.sender.sendText({ to: phone, text: message });
            sent = result.success !== false;
          } catch (chErr) {
            console.warn('Channel send failed for revoke notification:', chErr);
          }
        }

        if (!sent) {
          const gupshup = new GupshupService();
          if (gupshup.isConfigured) {
            await gupshup.sendText({ to: phone, text: message });
          }
        }
      } catch (msgErr) {
        console.warn('Failed to send revoke notification:', msgErr);
      }
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('contracts/revoke error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
