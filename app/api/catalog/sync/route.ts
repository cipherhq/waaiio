import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { CatalogService, getCurrencyForCountry } from '@/lib/channels/catalog';
import { logger } from '@/lib/logger';

/**
 * POST /api/catalog/sync
 *
 * Syncs a business's products to their WhatsApp catalog.
 * Requires business to have a Meta Cloud channel with WABA ID.
 */
export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { business_id } = await request.json();
  if (!business_id) return NextResponse.json({ error: 'Missing business_id' }, { status: 400 });

  // Verify ownership
  const { data: biz } = await supabase
    .from('businesses')
    .select('id, name, country_code')
    .eq('id', business_id)
    .eq('owner_id', user.id)
    .single();
  if (!biz) return NextResponse.json({ error: 'Business not found' }, { status: 404 });

  // Get WhatsApp channel for this business
  const service = createServiceClient();
  const { data: channel } = await service
    .from('whatsapp_channels')
    .select('meta_access_token, waba_id')
    .eq('business_id', business_id)
    .eq('provider', 'meta_cloud')
    .eq('is_active', true)
    .maybeSingle();

  const accessToken = channel?.meta_access_token || process.env.META_CLOUD_ACCESS_TOKEN;
  const wabaId = channel?.waba_id || process.env.META_CLOUD_WABA_ID;

  if (!accessToken || !wabaId) {
    return NextResponse.json({ error: 'No WhatsApp channel configured. Connect your WhatsApp number first.' }, { status: 400 });
  }

  // Load products
  const { data: products } = await service
    .from('products')
    .select('id, name, description, price, category, image_url, stock_quantity, is_active')
    .eq('business_id', business_id)
    .eq('is_active', true);

  if (!products?.length) {
    return NextResponse.json({ error: 'No active products to sync' }, { status: 400 });
  }

  const currency = getCurrencyForCountry(biz.country_code || 'NG');
  const catalog = new CatalogService(accessToken, wabaId);

  // Get or create catalog
  const catalogId = await catalog.getOrCreateCatalog(biz.name);
  if (!catalogId) {
    return NextResponse.json({ error: 'Failed to create WhatsApp catalog' }, { status: 500 });
  }

  // Sync products
  const result = await catalog.syncProducts(catalogId, products.map(p => ({
    retailer_id: p.id,
    name: p.name,
    description: p.description || undefined,
    price: Math.round(p.price * 100), // Convert to cents
    currency,
    image_url: p.image_url || undefined,
    category: p.category || undefined,
    availability: (p.stock_quantity === null || p.stock_quantity > 0) ? 'in stock' as const : 'out of stock' as const,
  })));

  // Save catalog ID to business metadata
  const existingMeta = ((biz as Record<string, unknown>).metadata || {}) as Record<string, unknown>;
  await service.from('businesses').update({
    metadata: { ...existingMeta, wa_catalog_id: catalogId },
  }).eq('id', business_id);

  logger.debug('[CATALOG] Sync result:', result);

  return NextResponse.json({
    success: true,
    catalog_id: catalogId,
    synced: result.synced,
    failed: result.failed,
    total: products.length,
  });
}
