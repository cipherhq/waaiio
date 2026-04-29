import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { logger } from '@/lib/logger';

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

  // Verify ownership
  const { data: biz } = await supabase
    .from('businesses')
    .select('id')
    .eq('id', business_id)
    .eq('owner_id', user.id)
    .single();
  if (!biz) return NextResponse.json({ error: 'Business not found' }, { status: 404 });

  const service = createServiceClient();
  const results: Record<string, unknown> = {};

  try {
    // 1. Create services
    if (services?.length) {
      // Get current max sort_order
      const { data: lastService } = await service
        .from('services')
        .select('sort_order')
        .eq('business_id', business_id)
        .order('sort_order', { ascending: false })
        .limit(1)
        .maybeSingle();

      let sortOrder = (lastService?.sort_order ?? -1) + 1;

      const rows = services.map((s) => ({
        business_id,
        name: s.name,
        price: s.price || 0,
        duration_minutes: s.duration_minutes || 30,
        deposit_amount: s.deposit_amount || 0,
        description: s.description || null,
        price_is_variable: false,
        is_active: true,
        sort_order: sortOrder++,
      }));

      const { data: created, error } = await service.from('services').insert(rows).select('id, name');
      if (error) logger.error('[AI-SETUP] Services insert error:', error.message);
      results.services = { created: created?.length || 0, error: error?.message };
    }

    // 2. Create products
    if (products?.length) {
      const { data: lastProduct } = await service
        .from('products')
        .select('sort_order')
        .eq('business_id', business_id)
        .order('sort_order', { ascending: false })
        .limit(1)
        .maybeSingle();

      let sortOrder = (lastProduct?.sort_order ?? -1) + 1;

      const rows = products.map((p) => ({
        business_id,
        name: p.name,
        price: p.price || 0,
        description: p.description || null,
        category: p.category || null,
        is_active: true,
        sort_order: sortOrder++,
      }));

      const { data: created, error } = await service.from('products').insert(rows).select('id, name');
      if (error) logger.error('[AI-SETUP] Products insert error:', error.message);
      results.products = { created: created?.length || 0, error: error?.message };
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

    // 5. Update capabilities
    if (capabilities?.length) {
      const { setCapabilities } = await import('@/lib/capabilities/service');
      await setCapabilities(service, business_id, capabilities as import('@/lib/capabilities/types').CapabilityId[]);
      results.capabilities = { updated: true };
    }

    return NextResponse.json({ success: true, results });
  } catch (error) {
    logger.error('[AI-SETUP] Apply error:', (error as Error).message);
    return NextResponse.json({ error: 'Failed to apply setup' }, { status: 500 });
  }
}
