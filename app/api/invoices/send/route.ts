import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { ChannelResolver } from '@/lib/channels/channel-resolver';
import { GupshupService } from '@/lib/channels/gupshup';
import { sendEmail } from '@/lib/email/client';
import { invoiceEmail } from '@/lib/email/templates';
import { rateLimitResponse, getRateLimitKey } from '@/lib/rate-limit';

function generateToken(): string {
  const tokenBytes = new Uint8Array(48);
  crypto.getRandomValues(tokenBytes);
  return Array.from(tokenBytes, b =>
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'[b % 62]
  ).join('');
}

async function sendWhatsAppMessage(
  service: ReturnType<typeof createServiceClient>,
  businessId: string,
  countryCode: string,
  phone: string,
  message: string,
): Promise<string | null> {
  const resolver = new ChannelResolver(service);
  const resolved =
    (await resolver.resolveByBusinessId(businessId)) ||
    (await resolver.getSharedChannelForCountry(countryCode || 'NG'));

  const cleanPhone = phone.replace(/\D/g, '');
  let sent = false;
  let messageId: string | null = null;

  if (resolved) {
    try {
      const result = await resolved.sender.sendText({ to: cleanPhone, text: message });
      sent = result.success !== false;
      if (sent && result.messageId) messageId = result.messageId;
    } catch (waErr) {
      console.warn('Primary channel send failed, trying Gupshup fallback:', waErr);
    }
  }

  if (!sent) {
    const gupshup = new GupshupService();
    if (gupshup.isConfigured) {
      const result = await gupshup.sendText({ to: cleanPhone, text: message });
      if (result.success && result.messageId) messageId = result.messageId;
    } else {
      console.log(`[mock] WhatsApp to ${cleanPhone}: ${message.slice(0, 80)}...`);
    }
  }

  return messageId;
}

function formatAmount(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(amount);
  } catch {
    return `${currency} ${amount.toLocaleString()}`;
  }
}

export async function POST(request: NextRequest) {
  const rl = rateLimitResponse(getRateLimitKey(request, 'invoice-send'), 20, 60_000);
  if (rl) return rl;

  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await request.json();
    const { invoice_id, channel } = body; // channel: 'whatsapp' | 'email' | 'both'

    if (!invoice_id) {
      return NextResponse.json({ error: 'invoice_id is required' }, { status: 400 });
    }

    // Fetch invoice with items
    const { data: invoice } = await supabase
      .from('invoices')
      .select('*, invoice_items(*)')
      .eq('id', invoice_id)
      .single();

    if (!invoice) {
      return NextResponse.json({ error: 'Invoice not found' }, { status: 404 });
    }

    // Verify ownership
    const { data: biz } = await supabase
      .from('businesses')
      .select('id, name, owner_id, country_code')
      .eq('id', invoice.business_id)
      .single();

    if (!biz || biz.owner_id !== user.id) {
      return NextResponse.json({ error: 'Not authorized' }, { status: 403 });
    }

    const service = createServiceClient();
    const appUrl = process.env.NEXT_PUBLIC_APP_URL || process.env.NEXT_PUBLIC_SITE_URL || 'https://app.waaiio.com';
    const token = generateToken();
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(); // 30 days

    // Update invoice with token and status
    await service
      .from('invoices')
      .update({
        token,
        token_expires_at: expiresAt,
        status: 'sent',
        sent_at: new Date().toISOString(),
        sent_via: channel || 'whatsapp',
      })
      .eq('id', invoice_id);

    const invoiceUrl = `${appUrl}/invoice/${token}`;
    const formattedAmount = formatAmount(invoice.total_amount, invoice.currency);
    const dueDate = invoice.due_date
      ? new Date(invoice.due_date).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
      : 'On receipt';

    const sendVia = channel || 'whatsapp';
    let waMessageId: string | null = null;

    // Send via WhatsApp
    if ((sendVia === 'whatsapp' || sendVia === 'both') && invoice.customer_phone) {
      const message = [
        `\ud83e\uddf3 *Invoice from ${biz.name}*`,
        '',
        `\ud83d\udccc Ref: *${invoice.reference_code}*`,
        `\ud83d\udcb0 Amount: *${formattedAmount}*`,
        `\ud83d\udcc5 Due: ${dueDate}`,
        '',
        `View & pay \ud83d\udc47`,
        invoiceUrl,
      ].join('\n');

      waMessageId = await sendWhatsAppMessage(service, invoice.business_id, biz.country_code, invoice.customer_phone, message);

      if (waMessageId) {
        await service
          .from('invoices')
          .update({ wa_message_id: waMessageId, wa_delivery_status: 'sent' })
          .eq('id', invoice_id);
      }
    }

    // Send via email
    if ((sendVia === 'email' || sendVia === 'both') && invoice.customer_email) {
      const emailContent = invoiceEmail({
        businessName: biz.name,
        referenceCode: invoice.reference_code,
        totalAmount: formattedAmount,
        dueDate,
        customerName: invoice.customer_name,
        items: (invoice.invoice_items || []).map((item: { description: string; quantity: number; unit_price: number; amount: number }) => ({
          description: item.description,
          quantity: item.quantity,
          unitPrice: item.unit_price,
          amount: item.amount,
        })),
        invoiceUrl,
        currency: invoice.currency,
      });

      await sendEmail({
        to: invoice.customer_email,
        subject: emailContent.subject,
        html: emailContent.html,
      });
    }

    // Create in-app notification record
    try {
      await service.from('notifications').insert({
        business_id: invoice.business_id,
        type: 'system',
        channel: sendVia === 'both' ? 'whatsapp' : sendVia,
        status: 'sent',
        subject: `Invoice sent — ${invoice.reference_code}`,
        body: `Invoice ${invoice.reference_code} for ${formattedAmount} was sent to ${invoice.customer_name} via ${sendVia}.`,
        sent_at: new Date().toISOString(),
      });
    } catch { /* non-critical */ }

    return NextResponse.json({
      success: true,
      invoice_url: invoiceUrl,
      wa_message_id: waMessageId,
      expires_at: expiresAt,
    });
  } catch (err) {
    console.error('invoices/send error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
