import { NextResponse, type NextRequest } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { ChannelResolver } from '@/lib/channels/channel-resolver';
import { authenticateRequest } from '@/lib/api-auth';
import { rateLimitResponseAsync, getRateLimitKey } from '@/lib/rate-limit';
import { logger } from '@/lib/logger';
import { formatCurrency, type CountryCode } from '@/lib/constants';
import { buildReceiptTax } from '@/lib/tax/receipt';
import { quoteAcceptButtonId } from '@/lib/tax/quote-acceptance';

export async function POST(request: NextRequest) {
  try {
    const rateLimit = await rateLimitResponseAsync(getRateLimitKey(request, 'quote-respond'), 20, 60_000);
    if (rateLimit) return rateLimit;

    const body = await request.json();
    const auth = await authenticateRequest(request, { requireBusinessOwnership: true, body, businessIdKey: 'business_id' });
    if (auth instanceof NextResponse) return auth;

    const { quote_id, business_id, quoted_amount, quoted_items, quote_notes, preview } = body;

    if (!quote_id || !business_id || (quoted_amount == null && !quoted_items?.length)) {
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

    // One transaction validates prices, applies current merchant rules and pins the
    // itemized customer terms before any notification can be sent.
    const { data: savedQuote, error: saveError } = await supabase.rpc('respond_order_quote_tax_980', {
      p_business_id: business_id, p_quote_id: quote_id, p_items: quoted_items || null,
      p_legacy_amount: quoted_amount ?? null, p_notes: quote_notes || null, p_preview: preview === true,
      p_expected_snapshot: body.expected_tax_snapshot ?? null,
    });
    if (saveError || !savedQuote) {
      return NextResponse.json({ error: 'Unable to save quote. Check itemized prices and refresh the request.' }, { status: 400 });
    }
    if (preview === true) return NextResponse.json(savedQuote);
    const savedTax = savedQuote.tax_snapshot
      ? buildReceiptTax({ snapshot: savedQuote.tax_snapshot }, 0) : undefined;

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
          return NextResponse.json({ success: true, quote: savedQuote });
        }
        const sender = resolved.sender;

        const phone = quote.customer_phone.startsWith('+')
          ? quote.customer_phone.slice(1)
          : quote.customer_phone;

        const lines = [
          `📋 *Price from ${biz?.name || 'Business'}*`,
          '',
          `💰 Price: *${formatCurrency(Number(savedQuote.quoted_amount), cc)}*`,
        ];

        if (savedTax) {
          for (const item of savedTax.items) lines.push(`${item.name} × ${item.quantity}: ${formatCurrency(item.lineTotal, cc)}`);
          lines.push(`Before tax: ${formatCurrency(savedTax.netAmount, cc)}`);
          for (const group of savedTax.groups) lines.push(`${group.label}: ${formatCurrency(group.taxAmount, cc)}`);
        }
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
            { id: quoteAcceptButtonId(quote_id, savedQuote.tax_snapshot), title: 'Accept' },
            { id: `reject_quote_${quote_id}`, title: 'Decline' },
          ],
        });
      } catch (err) {
        logger.error('[QUOTE-RESPOND] WhatsApp notification error:', err);
      }
    }

    return NextResponse.json({ success: true, quote: savedQuote });
  } catch (error) {
    logger.error('[QUOTE-RESPOND] Error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
