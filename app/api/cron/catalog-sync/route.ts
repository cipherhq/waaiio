import { NextResponse, type NextRequest } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { verifyCronAuth } from '@/lib/cron-auth';
import { CatalogService, getCurrencyForCountry } from '@/lib/channels/catalog';
import { logger } from '@/lib/logger';

/**
 * GET /api/cron/catalog-sync
 *
 * Periodic re-sync of WhatsApp product catalogs.
 * Runs every 6 hours to keep catalog data (prices, stock, availability) in sync.
 * Only processes businesses with active catalogs and active WhatsApp channels.
 */
export async function GET(request: NextRequest) {
  const authError = verifyCronAuth(request);
  if (authError) return authError;

  const supabase = createServiceClient();

  // Find businesses with active catalogs
  const { data: businesses } = await supabase
    .from('businesses')
    .select('id, name, whatsapp_catalog_id, country_code')
    .not('whatsapp_catalog_id', 'is', null)
    .eq('status', 'active');

  let synced = 0;
  let failed = 0;

  for (const biz of businesses || []) {
    try {
      // Get channel credentials
      const { data: channel } = await supabase
        .from('whatsapp_channels')
        .select('meta_access_token, waba_id')
        .eq('business_id', biz.id)
        .eq('provider', 'meta_cloud')
        .eq('is_active', true)
        .maybeSingle();

      const accessToken = channel?.meta_access_token || process.env.META_CLOUD_ACCESS_TOKEN;
      const wabaId = channel?.waba_id || process.env.META_CLOUD_WABA_ID;
      if (!accessToken || !wabaId) continue;

      // Get active products
      const { data: products } = await supabase
        .from('products')
        .select('id, name, description, price, image_url, category, stock_quantity, track_inventory, is_active')
        .eq('business_id', biz.id)
        .eq('is_active', true)
        .is('deleted_at', null);

      if (!products || products.length === 0) continue;

      const currency = getCurrencyForCountry(biz.country_code || 'NG');
      const catalogService = new CatalogService(accessToken, wabaId);

      await catalogService.syncProducts(biz.whatsapp_catalog_id, products.map(p => ({
        retailer_id: p.id,
        name: p.name,
        description: p.description || undefined,
        price: Math.round(p.price * 100), // Convert to cents
        currency,
        image_url: p.image_url || undefined,
        url: `https://www.waaiio.com/b/${biz.id}`,
        availability: (!p.track_inventory || (p.stock_quantity === null || p.stock_quantity > 0))
          ? 'in stock' as const
          : 'out of stock' as const,
      })));

      // Update sync timestamps
      const productIds = products.map(p => p.id);
      await supabase
        .from('products')
        .update({ catalog_synced_at: new Date().toISOString() })
        .in('id', productIds)
        .eq('business_id', biz.id);

      // Log the sync
      await supabase.from('catalog_sync_logs').insert({
        business_id: biz.id,
        catalog_id: biz.whatsapp_catalog_id,
        synced_count: products.length,
        failed_count: 0,
        status: 'success',
      });

      synced++;
    } catch (err) {
      logger.error(`[CATALOG CRON] Sync failed for ${biz.name}:`, err);
      failed++;
    }
  }

  return NextResponse.json({
    synced,
    failed,
    total: (businesses || []).length,
  });
}
