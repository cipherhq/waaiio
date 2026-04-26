/**
 * Supabase Edge Function: low-stock-alerts
 *
 * Triggered daily via CRON to:
 * 1. Find products with stock below threshold
 * 2. Send WhatsApp alert to business owner
 *
 * CRON schedule (add to supabase/config.toml):
 *   [functions.low-stock-alerts]
 *   schedule = "0 9 * * *"  # Daily at 9am UTC
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const isDev = Deno.env.get('ENVIRONMENT') !== 'production';
const log = {
  debug: (...args: unknown[]) => { if (isDev) console.log(...args); },
  error: (...args: unknown[]) => console.error(...args),
};

const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const whatsappToken = Deno.env.get('WHATSAPP_TOKEN') || '';
const whatsappPhoneId = Deno.env.get('WHATSAPP_PHONE_NUMBER_ID') || '';

async function sendWhatsApp(to: string, text: string): Promise<boolean> {
  if (!whatsappToken || !whatsappPhoneId) {
    log.debug(`[mock] WhatsApp to ${to}: ${text.slice(0, 100)}...`);
    return true;
  }

  try {
    const phone = to.replace('+', '');
    const response = await fetch(
      `https://graph.facebook.com/v22.0/${whatsappPhoneId}/messages`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${whatsappToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to: phone,
          type: 'text',
          text: { body: text },
        }),
      },
    );
    return response.ok;
  } catch (err) {
    log.error(`Failed to send WhatsApp to ${to}:`, err);
    return false;
  }
}

Deno.serve(async () => {
  const supabase = createClient(supabaseUrl, supabaseKey);
  let alertsSent = 0;

  // Find products with stock below threshold that haven't been alerted
  const { data: lowStockProducts } = await supabase
    .from('products')
    .select(`
      id, name, stock_quantity, low_stock_threshold,
      business_id,
      businesses:business_id (name, phone, owner_id, profiles:owner_id (phone))
    `)
    .eq('is_active', true)
    .is('deleted_at', null)
    .eq('low_stock_alerted', false)
    .not('stock_quantity', 'is', null)
    .limit(200);

  // Group by business to send one message per business
  const bizMap = new Map<string, { bizName: string; ownerPhone: string; products: Array<{ name: string; stock: number }> }>();

  for (const product of lowStockProducts || []) {
    const stock = product.stock_quantity as number;
    const threshold = (product.low_stock_threshold as number) || 5;

    if (stock > threshold) continue;

    const biz = product.businesses as unknown as { name: string; phone: string; owner_id: string; profiles: { phone: string } | null } | null;
    if (!biz) continue;

    const ownerPhone = biz.profiles?.phone || biz.phone;
    if (!ownerPhone) continue;

    const key = product.business_id as string;
    if (!bizMap.has(key)) {
      bizMap.set(key, { bizName: biz.name, ownerPhone, products: [] });
    }
    bizMap.get(key)!.products.push({ name: product.name, stock });
  }

  for (const [bizId, info] of bizMap) {
    const productList = info.products
      .map(p => `• *${p.name}*: ${p.stock} left`)
      .join('\n');

    const msg = `⚠️ *Low Stock Alert — ${info.bizName}*\n\nThe following products are running low:\n\n${productList}\n\nRestock soon to avoid missed orders! Log in to your dashboard to update inventory.`;

    const sent = await sendWhatsApp(info.ownerPhone, msg);
    if (sent) {
      // Mark products as alerted
      const productIds = (lowStockProducts || [])
        .filter(p => (p.business_id as string) === bizId && (p.stock_quantity as number) <= ((p.low_stock_threshold as number) || 5))
        .map(p => p.id);

      for (const pid of productIds) {
        await supabase
          .from('products')
          .update({ low_stock_alerted: true })
          .eq('id', pid);
      }
      alertsSent++;
    }
  }

  // Reset alert flag for products that have been restocked above threshold
  await supabase
    .rpc('reset_low_stock_alerts');

  const summary = `Low stock alerts sent to ${alertsSent} businesses`;
  log.debug(summary);

  return new Response(JSON.stringify({ success: true, summary, alertsSent }), {
    headers: { 'Content-Type': 'application/json' },
  });
});
