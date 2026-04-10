import { NextResponse, type NextRequest } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { ChannelResolver } from '@/lib/channels/channel-resolver';
import { GupshupService } from '@/lib/channels/gupshup';
import type { MessageSender } from '@/lib/channels/message-sender';
import { authenticateRequest } from '@/lib/api-auth';
import { rateLimitResponse, getRateLimitKey } from '@/lib/rate-limit';
import { logger } from '@/lib/logger';
import { formatCurrency, type CountryCode } from '@/lib/constants';

let defaultGupshup: GupshupService;
function getDefaultGupshup() {
  if (!defaultGupshup) defaultGupshup = new GupshupService();
  return defaultGupshup;
}

export async function POST(request: NextRequest) {
  try {
    const rateLimit = rateLimitResponse(getRateLimitKey(request, 'quote-respond'), 20, 60_000);
    if (rateLimit) return rateLimit;

    const body = await request.json();
    const auth = await authenticateRequest(request, { requireBusinessOwnership: true, body, businessIdKey: 'business_id' });
    if (auth instanceof NextResponse) return auth;

    const { quote_id, business_id, quoted_amount, quote_notes } = body;

    if (!quote_id || !business_id || quoted_amount == null) {
      return NextResponse.json({ error: 'quote_id, business_id, and quoted_amount required' }, { status: 400 });
    }

    const supabase = createServiceClient();

    // Validate quote exists and belongs to business
    const { data: quote, error: quoteError } = await supabase
      .from('quote_requests')
      .select('id, customer_phone, customer_name, status, estimated_subtotal, business_id')
      .eq('id', quote_id)
      .eq('business_id', business_id)
      .single();

    if (quoteError || !quote) {
      return NextResponse.json({ error: 'Quote not found' }, { status: 404 });
    }

    if (quote.status !== 'pending') {
      return NextResponse.json({ error: `Quote is already ${quote.status}` }, { status: 400 });
    }

    // Update quote
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    await supabase
      .from('quote_requests')
      .update({
        status: 'quoted',
        quoted_amount: Number(quoted_amount),
        quote_notes: quote_notes || null,
        quoted_at: new Date().toISOString(),
        expires_at: expiresAt,
      })
      .eq('id', quote_id);

    // Get business info for formatting
    const { data: biz } = await supabase
      .from('businesses')
      .select('name, country_code')
      .eq('id', business_id)
      .single();

    const cc = (biz?.country_code || 'NG') as CountryCode;

    // Send WhatsApp to customer with accept/reject buttons
    if (quote.customer_phone) {
      try {
        const resolver = new ChannelResolver(supabase);
        const resolved = await resolver.resolveByBusinessId(business_id);
        const sender: MessageSender = resolved?.sender || getDefaultGupshup();

        const phone = quote.customer_phone.startsWith('+')
          ? quote.customer_phone.slice(1)
          : quote.customer_phone;

        const lines = [
          `\uD83D\uDCCB *Quote from ${biz?.name || 'Business'}*`,
          '',
          `\uD83D\uDCB0 Quoted Price: *${formatCurrency(Number(quoted_amount), cc)}*`,
        ];

        if (quote_notes) {
          lines.push(`\uD83D\uDCDD Note: ${quote_notes}`);
        }

        lines.push(
          '',
          `_This quote expires in 24 hours._`,
          '',
          'Would you like to accept this quote?',
        );

        await sender.sendText({ to: phone, text: lines.join('\n') });

        await sender.sendButtons({
          to: phone,
          body: 'Accept or decline this quote:',
          buttons: [
            { id: `accept_quote_${quote_id}`, title: 'Accept' },
            { id: `reject_quote_${quote_id}`, title: 'Decline' },
          ],
        });
      } catch (err) {
        logger.error('[QUOTE-RESPOND] WhatsApp notification error:', err);
      }
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    logger.error('[QUOTE-RESPOND] Error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
