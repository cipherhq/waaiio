import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { logger } from '@/lib/logger';
import { CAPABILITY_TIER_REQUIREMENTS, type CapabilityId } from '@/lib/capabilities/types';

interface ServiceItem {
  name: string;
  price: number;
  duration_minutes?: number;
  deposit_amount?: number;
  description?: string;
}

interface ProductItem {
  name: string;
  price: number;
  description?: string;
  category?: string;
}

interface OperatingHours {
  [day: string]: { open?: string; close?: string; closed?: boolean };
}

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await request.json();
  const { business_id, services, products, operating_hours, greeting, capabilities } = body as {
    business_id: string;
    services?: ServiceItem[];
    products?: ProductItem[];
    operating_hours?: OperatingHours;
    greeting?: string;
    capabilities?: string[];
  };

  if (!business_id) return NextResponse.json({ error: 'Missing business_id' }, { status: 400 });

  // Verify ownership + get tier
  const { data: biz } = await supabase
    .from('businesses')
    .select('id, subscription_tier')
    .eq('id', business_id)
    .eq('owner_id', user.id)
    .single();
  if (!biz) return NextResponse.json({ error: 'Business not found' }, { status: 404 });

  // Determine allowed capabilities for this tier
  const tier = (biz.subscription_tier || 'free') as 'free' | 'growth' | 'business';
  const tierRank: Record<string, number> = { free: 0, growth: 1, business: 2 };
  const allowedCapabilities = Object.entries(CAPABILITY_TIER_REQUIREMENTS)
    .filter(([, requiredTier]) => tierRank[tier] >= tierRank[requiredTier])
    .map(([capId]) => capId);

  const service = createServiceClient();
  const results: Record<string, unknown> = {};

  try {
    // 1. Create services (with duplicate detection)
    if (services?.length) {
      // Check for existing services with same names
      const validServices = services.filter((s) => s.name && String(s.name).trim().length > 0 && String(s.name).length <= 200);
      const { data: existingServices } = await service
        .from('services')
        .select('name')
        .eq('business_id', business_id)
        .in('name', validServices.map(s => String(s.name).trim()));

      const existingServiceNames = new Set((existingServices || []).map(s => s.name.toLowerCase()));
      const newServices = validServices.filter(s => !existingServiceNames.has(String(s.name).trim().toLowerCase()));
      const skippedServices = validServices.length - newServices.length;

      if (newServices.length > 0) {
        // Get current max sort_order
        const { data: lastService } = await service
          .from('services')
          .select('sort_order')
          .eq('business_id', business_id)
          .order('sort_order', { ascending: false })
          .limit(1)
          .maybeSingle();

        let sortOrder = (lastService?.sort_order ?? -1) + 1;

        const rows = newServices.map((s) => ({
          business_id,
          name: String(s.name).trim().slice(0, 200),
          price: Math.max(0, Math.min(Number(s.price) || 0, 99999999)),
          duration_minutes: Math.max(0, Math.min(Number(s.duration_minutes) || 30, 1440)),
          deposit_amount: Math.max(0, Math.min(Number(s.deposit_amount) || 0, 99999999)),
          description: s.description ? String(s.description).slice(0, 1000) : null,
          price_is_variable: false,
          is_active: true,
          sort_order: sortOrder++,
        }));

        const { data: created, error } = await service.from('services').insert(rows).select('id, name');
        if (error) logger.error('[AI-SETUP] Services insert error:', error.message);
        results.services = { created: created?.length || 0, skipped: skippedServices, error: error?.message };
      } else {
        results.services = { created: 0, skipped: skippedServices };
      }
    }

    // 2. Create products (with duplicate detection)
    if (products?.length) {
      const validProducts = products.filter(p => p.name && String(p.name).trim().length > 0);
      const { data: existingProducts } = await service
        .from('products')
        .select('name')
        .eq('business_id', business_id)
        .in('name', validProducts.map(p => String(p.name).trim()));

      const existingProductNames = new Set((existingProducts || []).map(p => p.name.toLowerCase()));
      const newProducts = validProducts.filter(p => !existingProductNames.has(String(p.name).trim().toLowerCase()));
      const skippedProducts = validProducts.length - newProducts.length;

      if (newProducts.length > 0) {
        const { data: lastProduct } = await service
          .from('products')
          .select('sort_order')
          .eq('business_id', business_id)
          .order('sort_order', { ascending: false })
          .limit(1)
          .maybeSingle();

        let sortOrder = (lastProduct?.sort_order ?? -1) + 1;

        const rows = newProducts.map((p) => ({
          business_id,
          name: String(p.name).trim(),
          price: p.price || 0,
          description: p.description || null,
          category: p.category || null,
          is_active: true,
          sort_order: sortOrder++,
        }));

        const { data: created, error } = await service.from('products').insert(rows).select('id, name');
        if (error) logger.error('[AI-SETUP] Products insert error:', error.message);
        results.products = { created: created?.length || 0, skipped: skippedProducts, error: error?.message };
      } else {
        results.products = { created: 0, skipped: skippedProducts };
      }
    }

    // 3. Update operating hours
    if (operating_hours) {
      const { error } = await service
        .from('businesses')
        .update({ operating_hours })
        .eq('id', business_id);
      if (error) logger.error('[AI-SETUP] Hours update error:', error.message);
      results.operating_hours = { updated: !error, error: error?.message };
    }

    // 4. Update bot greeting
    if (greeting) {
      const { error } = await service
        .from('whatsapp_configs')
        .update({ bot_greeting: greeting })
        .eq('business_id', business_id);
      if (error) logger.error('[AI-SETUP] Greeting update error:', error.message);
      results.greeting = { updated: !error, error: error?.message };
    }

    // 5. Update capabilities — enforce tier gating
    if (capabilities?.length) {
      const filtered = capabilities.filter(cap => allowedCapabilities.includes(cap));
      const blocked = capabilities.filter(cap => !allowedCapabilities.includes(cap));

      if (filtered.length > 0) {
        const { setCapabilities } = await import('@/lib/capabilities/service');
        await setCapabilities(service, business_id, filtered as CapabilityId[]);
      }
      results.capabilities = {
        updated: filtered.length > 0,
        enabled: filtered,
        blocked_by_tier: blocked.length > 0 ? blocked : undefined,
      };
    }

    return NextResponse.json({ success: true, results });
  } catch (error) {
    logger.error('[AI-SETUP] Apply error:', (error as Error).message);
    return NextResponse.json({ error: 'Failed to apply setup' }, { status: 500 });
  }
}
