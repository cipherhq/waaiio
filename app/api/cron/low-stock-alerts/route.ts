import { NextResponse, type NextRequest } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { ChannelResolver } from '@/lib/channels/channel-resolver';
import { sendEmail } from '@/lib/email/client';
import { verifyCronAuth } from '@/lib/cron-auth';
import { logger } from '@/lib/logger';
import { shouldNotify } from '@/lib/bot/flows/shared/notifications';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  const authError = verifyCronAuth(request);
  if (authError) return authError;

  const supabase = createServiceClient();
  const resolver = new ChannelResolver(supabase);
  let alertsSent = 0;

  // 1. Find products with stock at or below threshold that haven't been alerted
  const { data: lowStockProducts, error } = await supabase
    .from('products')
    .select(`
      id, name, stock_quantity, low_stock_threshold, metadata,
      business_id,
      businesses:business_id (name, phone, owner_id, metadata, profiles:owner_id (phone, email))
    `)
    .eq('is_active', true)
    .is('deleted_at', null)
    .eq('low_stock_alerted', false)
    .not('stock_quantity', 'is', null)
    .limit(500);

  if (error) {
    logger.error('[LOW-STOCK-CRON] Query error:', error.message);
    return NextResponse.json({ ok: false, error: 'Query failed' }, { status: 500 });
  }

  // 2. Group by business_id, filtering to products actually at or below threshold
  const bizMap = new Map<
    string,
    {
      bizName: string;
      ownerPhone: string | null;
      ownerEmail: string | null;
      bizMetadata: Record<string, unknown> | null;
      productIds: string[];
      items: Array<{ name: string; stock: number; threshold: number }>;
    }
  >();

  for (const product of lowStockProducts || []) {
    const stock = product.stock_quantity as number;
    const threshold = (product.low_stock_threshold as number) || 5;

    if (stock > threshold) continue;

    const biz = product.businesses as unknown as {
      name: string;
      phone: string;
      owner_id: string;
      metadata: Record<string, unknown> | null;
      profiles: { phone: string; email: string } | null;
    } | null;
    if (!biz) continue;

    const key = product.business_id as string;
    if (!bizMap.has(key)) {
      bizMap.set(key, {
        bizName: biz.name,
        ownerPhone: biz.profiles?.phone || biz.phone || null,
        ownerEmail: biz.profiles?.email || null,
        bizMetadata: biz.metadata || null,
        productIds: [],
        items: [],
      });
    }
    const entry = bizMap.get(key)!;
    entry.productIds.push(product.id);
    entry.items.push({ name: product.name, stock, threshold });
  }

  // 3. For each business: send WhatsApp alert + email
  for (const [bizId, info] of bizMap) {
    const productList = info.items
      .map((p) => `\u2022 ${p.name} \u2014 ${p.stock} left (threshold: ${p.threshold})`)
      .join('\n');

    const msg = `\u26a0\ufe0f Low Stock Alert\n\nThe following products are running low:\n${productList}\n\nRestock soon to avoid missing orders.`;

    let whatsappSent = false;

    // Send WhatsApp via channel resolver (if preference allows)
    if (info.ownerPhone && shouldNotify(info.bizMetadata, 'low_stock', 'whatsapp')) {
      try {
        const resolved = await resolver.resolveByBusinessId(bizId);
        if (resolved) {
          await resolved.sender.sendText({ to: info.ownerPhone, text: msg });
          whatsappSent = true;
        }
      } catch (err) {
        logger.error(`[LOW-STOCK-CRON] WhatsApp send failed for ${bizId}:`, err);
      }
    }

    // Send email to business owner (if preference allows)
    if (info.ownerEmail && shouldNotify(info.bizMetadata, 'low_stock', 'email')) {
      const htmlItems = info.items
        .map(
          (p) =>
            `<li><strong>${p.name}</strong> &mdash; ${p.stock} left (threshold: ${p.threshold})</li>`,
        )
        .join('');

      await sendEmail({
        to: info.ownerEmail,
        subject: `Low Stock Alert \u2014 ${info.bizName}`,
        html: `<p>Hi,</p>
<p>The following products at <strong>${info.bizName}</strong> are running low on stock:</p>
<ul>${htmlItems}</ul>
<p>Restock soon to avoid missing orders. <a href="${process.env.NEXT_PUBLIC_APP_URL || 'https://www.waaiio.com'}/dashboard/products">Manage inventory</a></p>`,
      }).catch((err) => {
        logger.error(`[LOW-STOCK-CRON] Email send failed for ${bizId}:`, err);
      });
    }

    // 4. Mark products as alerted
    if (whatsappSent || info.ownerEmail) {
      const { error: updateErr } = await supabase
        .from('products')
        .update({ low_stock_alerted: true })
        .in('id', info.productIds);

      if (updateErr) {
        logger.error(`[LOW-STOCK-CRON] Failed to mark alerted for ${bizId}:`, updateErr.message);
      } else {
        alertsSent++;
      }
    }
  }

  // 5. Reset alert flag for products that have been restocked above threshold
  const { error: resetErr } = await supabase.rpc('reset_low_stock_alerts');
  if (resetErr) {
    logger.error('[LOW-STOCK-CRON] reset_low_stock_alerts RPC failed:', resetErr.message);
  }

  const summary = `Low stock alerts sent to ${alertsSent} businesses`;
  logger.debug(`[LOW-STOCK-CRON] ${summary}`);

  return NextResponse.json({ ok: true, summary, alertsSent });
}
