import { NextResponse, type NextRequest } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { ChannelResolver } from '@/lib/channels/channel-resolver';
import { authenticateRequest } from '@/lib/api-auth';
import { rateLimitResponseAsync, getRateLimitKey } from '@/lib/rate-limit';
import { logger } from '@/lib/logger';
import { formatCurrency, type CountryCode } from '@/lib/constants';

export async function POST(request: NextRequest) {
  try {
    const rateLimit = await rateLimitResponseAsync(getRateLimitKey(request, 'quote-respond'), 20, 60_000);
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
        if (!resolved?.sender) {
          logger.warn('[QUOTE-RESPOND] No messaging channel configured for business', business_id);
          return NextResponse.json({ success: true });
        }
        const sender = resolved.sender;

        const phone = quote.customer_phone.startsWith('+')
          ? quote.customer_phone.slice(1)
          : quote.customer_phone;

        const lines = [
          `📋 *Price from ${biz?.name || 'Business'}*`,
          '',
          `💰 Price: *${formatCurrency(Number(quoted_amount), cc)}*`,
        ];

        if (quote_notes) {
          lines.push(`📝 Note: ${quote_notes}`);
        }

        lines.push(
          '',
          `_This price is valid for 24 hours._`,
          '',
          'Would you like to accept?',
        );

        await sender.sendText({ to: phone, text: lines.join('\n') });

        await sender.sendButtons({
          to: phone,
          body: 'Accept or decline this price:',
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
