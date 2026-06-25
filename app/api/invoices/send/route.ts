import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { ChannelResolver } from '@/lib/channels/channel-resolver';
import { sendEmail } from '@/lib/email/client';
import { invoiceEmail } from '@/lib/email/templates';
import { rateLimitResponse, getRateLimitKey } from '@/lib/rate-limit';
import { logger } from '@/lib/logger';
import { generateInvoicePdf, type InvoicePdfData } from '@/lib/pdf/invoice-pdf-generator';
import { PRICING_TIERS, type CountryCode, type SubscriptionTier } from '@/lib/constants';
import { loadPlatformSettings } from '@/lib/platformSettings';

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
  templateParams?: { businessName: string; invoiceNumber: string; amount: string },
): Promise<string | null> {
  const resolver = new ChannelResolver(service);
  const resolved =
    (await resolver.resolveByBusinessId(businessId)) ||
    (await resolver.getSharedChannelForCountry(countryCode || 'NG'));

  const cleanPhone = phone.replace(/\D/g, '');

  if (!resolved) {
    logger.warn(`[INVOICE] No WhatsApp channel for business ${businessId}`);
    return null;
  }

  // Try template first (works outside 24h window)
  if (resolved.sender.sendTemplate && templateParams) {
    try {
      const result = await resolved.sender.sendTemplate({
        to: cleanPhone,
        templateName: 'invoice_payment_request',
        templateParams: [templateParams.businessName, templateParams.invoiceNumber, templateParams.amount],
      });
      if (result.success !== false && result.messageId) {
        return result.messageId;
      }
    } catch (tmplErr) {
      logger.warn('[INVOICE] Template failed, trying text:', tmplErr);
    }
  }

  // Fallback to plain text (within 24h window only)
  try {
    const result = await resolved.sender.sendText({ to: cleanPhone, text: message });
    if (result.success !== false && result.messageId) return result.messageId;
  } catch (waErr) {
    logger.warn('[INVOICE] sendText failed:', waErr);
  }

  return null;
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
      .select('id, name, owner_id, country_code, logo_url, subscription_tier')
      .eq('id', invoice.business_id)
      .single();

    if (!biz || biz.owner_id !== user.id) {
      return NextResponse.json({ error: 'Not authorized' }, { status: 403 });
    }

    // Check conversation limit before sending WhatsApp
    const { checkConversationLimit } = await import('@/lib/bot/conversation-guard');
    const service = createServiceClient();
    const convLimit = await checkConversationLimit(service, invoice.business_id);
    if (!convLimit.allowed) {
      return NextResponse.json({ error: `Monthly conversation limit reached (${convLimit.used}/${convLimit.limit}). Upgrade for more.` }, { status: 403 });
    }
    const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.waaiio.com';
    const token = generateToken();
    const settings = await loadPlatformSettings({ useServiceClient: true });
    const expiresAt = new Date(Date.now() + settings.invoice_expiry_days * 24 * 60 * 60 * 1000).toISOString();

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

      waMessageId = await sendWhatsAppMessage(service, invoice.business_id, biz.country_code, invoice.customer_phone, message, {
        businessName: biz.name,
        invoiceNumber: invoice.reference_code,
        amount: formattedAmount,
      });

      if (waMessageId) {
        await service
          .from('invoices')
          .update({ wa_message_id: waMessageId, wa_delivery_status: 'sent' })
          .eq('id', invoice_id);
      }

      // Send PDF attachment (non-blocking — don't fail the whole send if PDF fails)
      try {
        const resolver = new ChannelResolver(service);
        const resolved = await resolver.resolveByBusinessId(invoice.business_id);
        if (resolved) {
          const cc = (biz.country_code || 'NG') as CountryCode;
          const tier = (biz.subscription_tier || 'free') as SubscriptionTier;
          const isPaidTier = PRICING_TIERS[tier]?.whitelabel === true || tier !== 'free';

          const pdfData: InvoicePdfData = {
            businessName: biz.name,
            referenceCode: invoice.reference_code,
            issueDate: invoice.created_at,
            dueDate: invoice.due_date,
            customerName: invoice.customer_name,
            customerPhone: invoice.customer_phone,
            customerEmail: invoice.customer_email,
            customerAddress: null,
            items: (invoice.invoice_items || []).map((item: any) => ({
              description: item.description,
              quantity: item.quantity,
              unitPrice: item.unit_price,
              amount: item.amount,
            })),
            subtotal: invoice.subtotal || invoice.total_amount,
            taxRate: invoice.tax_rate || 0,
            taxAmount: invoice.tax_amount || 0,
            discountType: invoice.discount_type || null,
            discountValue: invoice.discount_value || 0,
            discountAmount: invoice.discount_amount || 0,
            totalAmount: invoice.total_amount,
            amountPaid: invoice.amount_paid || 0,
            currency: invoice.currency || 'USD',
            notes: invoice.notes || null,
            terms: invoice.terms || null,
            status: invoice.status,
            countryCode: cc,
            whitelabel: isPaidTier,
            logoUrl: isPaidTier ? (biz.logo_url || null) : null,
          };

          const pdfBuffer = await generateInvoicePdf(pdfData);

          // Upload PDF to storage and get signed URL
          const pdfPath = `invoices/${invoice.business_id}/${invoice.reference_code}.pdf`;
          await service.storage.from('customer-reports').upload(pdfPath, pdfBuffer, {
            contentType: 'application/pdf',
            upsert: true,
          });

          const { data: signedUrl } = await service.storage
            .from('customer-reports')
            .createSignedUrl(pdfPath, 3600);

          if (signedUrl?.signedUrl) {
            const cleanPhone = invoice.customer_phone.replace(/\D/g, '');
            await resolved.sender.sendDocument({
              to: cleanPhone,
              documentUrl: signedUrl.signedUrl,
              filename: `${invoice.reference_code}.pdf`,
              caption: `Invoice ${invoice.reference_code} from ${biz.name}`,
            });
          }
        }
      } catch (pdfErr) {
        logger.error('[INVOICE] PDF send error (non-fatal):', pdfErr);
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
        ...emailContent,
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
    logger.error('invoices/send error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
