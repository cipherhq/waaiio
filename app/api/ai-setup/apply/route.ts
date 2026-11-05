import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { logger } from '@/lib/logger';
import { CAPABILITY_TIER_REQUIREMENTS, type CapabilityId } from '@/lib/capabilities/types';
import { buildAiSetupProductRow, buildAiSetupServiceRow } from '@/lib/services/payload-builders';

interface ServiceItem {
  name: string;
  price: number | null;
  duration_minutes?: number;
  deposit_amount?: number;
  description?: string;
}

interface ProductItem {
  name: string;
  price: number | null;
  description?: string;
  category?: string;
  image_url?: string | null;
}

interface ItemError { name: string; error: string }

const MAX_ITEMS_PER_SECTION = 500;

/** Duplicate key: the name exactly as it will be saved (trimmed, ≤200 chars), lower-cased. */
function nameKey(value: unknown): string {
  return String(value ?? '').trim().slice(0, 200).trim().toLowerCase();
}

/**
 * Lower-cased names this business already has, read page by page so any
 * name (quotes, commas, brackets) and any catalog size works. null when a
 * page cannot be read; the caller then saves nothing (fail closed).
 */
async function loadExistingNames(
  service: ReturnType<typeof createServiceClient>,
  table: 'services' | 'products',
  businessId: string,
): Promise<Set<string> | null> {
  const names = new Set<string>();
  const pageSize = 1000;
  // Advance by rows actually returned and stop on an empty page, so a lower
  // server row cap cannot end the read early.
  for (let from = 0; ; ) {
    const { data, error } = await service
      .from(table)
      .select('id, name')
      .eq('business_id', businessId)
      .order('id')
      .range(from, from + pageSize - 1);
    if (error) {
      logger.error(`[AI-SETUP] ${table} duplicate check error:`, error.message);
      return null;
    }
    if (!data || data.length === 0) return names;
    for (const row of data) names.add(nameKey(row.name));
    from += data.length;
  }
}

/** Items whose name is not already saved and not repeated earlier in this batch (case-insensitive). */
function keepNewNames<T extends { name?: unknown }>(items: T[], existing: Set<string>): T[] {
  const seen = new Set(existing);
  return items.filter((item) => {
    const key = nameKey(item.name);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Build each row independently so one bad item never sinks the batch. */
function buildRows<T, R>(items: T[], nameOf: (item: T) => string, build: (item: T) => R) {
  const rows: R[] = [];
  const errors: ItemError[] = [];
  for (const item of items) {
    try {
      rows.push(build(item));
    } catch (err) {
      errors.push({
        name: nameOf(item).slice(0, 200),
        error: err instanceof RangeError ? err.message : 'Invalid item.',
      });
    }
  }
  return { rows, errors };
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
  if ((services !== undefined && !Array.isArray(services)) || (products !== undefined && !Array.isArray(products))) {
    return NextResponse.json({ error: 'services and products must be lists' }, { status: 400 });
  }
  if ((services?.length || 0) > MAX_ITEMS_PER_SECTION || (products?.length || 0) > MAX_ITEMS_PER_SECTION) {
    return NextResponse.json({ error: `At most ${MAX_ITEMS_PER_SECTION} items per section` }, { status: 400 });
  }

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
      // Names over 200 characters are cut to 200 when saved (as for products), not silently dropped.
      const validServices = services.filter((s) => s.name && String(s.name).trim().length > 0);
      const existingServiceNames = await loadExistingNames(service, 'services', business_id);
      const newServices = existingServiceNames ? keepNewNames(validServices, existingServiceNames) : [];
      const skippedServices = validServices.length - newServices.length;

      if (!existingServiceNames) {
        // Fail closed: without the duplicate check, saving could create copies.
        results.services = { created: 0, skipped: 0, error: 'Could not check for items you already have, so nothing was saved. Please try again.' };
      } else if (newServices.length > 0) {
        // Get current max sort_order
        const { data: lastService } = await service
          .from('services')
          .select('sort_order')
          .eq('business_id', business_id)
          .order('sort_order', { ascending: false })
          .limit(1)
          .maybeSingle();

        let sortOrder = (lastService?.sort_order ?? -1) + 1;

        const { rows, errors } = buildRows(newServices, (s) => String(s.name), (s) => buildAiSetupServiceRow({
          businessId: business_id, name: s.name, price: s.price,
          duration_minutes: s.duration_minutes, deposit_amount: s.deposit_amount,
          description: s.description, sortOrder: sortOrder++,
        }));

        let created = 0;
        let insertError: string | undefined;
        if (rows.length > 0) {
          const { data, error } = await service.from('services').insert(rows).select('id, name');
          if (error) logger.error('[AI-SETUP] Services insert error:', error.message);
          created = data?.length || 0;
          // Raw database messages stay in the server log
          insertError = error ? 'Could not save these items. Please try again.' : undefined;
        }
        results.services = {
          created, skipped: skippedServices,
          ...(errors.length ? { errors } : {}),
          ...(insertError ? { error: insertError } : {}),
        };
      } else {
        results.services = { created: 0, skipped: skippedServices };
      }
    }

    // 2. Create products (with duplicate detection)
    if (products?.length) {
      const validProducts = products.filter(p => p.name && String(p.name).trim().length > 0);
      const existingProductNames = await loadExistingNames(service, 'products', business_id);
      const newProducts = existingProductNames ? keepNewNames(validProducts, existingProductNames) : [];
      const skippedProducts = validProducts.length - newProducts.length;

      if (!existingProductNames) {
        // Fail closed: without the duplicate check, saving could create copies.
        results.products = { created: 0, skipped: 0, error: 'Could not check for items you already have, so nothing was saved. Please try again.' };
      } else if (newProducts.length > 0) {
        const { data: lastProduct } = await service
          .from('products')
          .select('sort_order')
          .eq('business_id', business_id)
          .order('sort_order', { ascending: false })
          .limit(1)
          .maybeSingle();

        let sortOrder = (lastProduct?.sort_order ?? -1) + 1;

        const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
        const { rows, errors } = buildRows(newProducts, (p) => String(p.name), (p) => buildAiSetupProductRow({
          businessId: business_id, name: p.name, price: p.price,
          description: p.description, category: p.category, image_url: p.image_url,
          sortOrder: sortOrder++, supabaseUrl,
        }));

        let created = 0;
        let insertError: string | undefined;
        if (rows.length > 0) {
          const { data, error } = await service.from('products').insert(rows).select('id, name');
          if (error) logger.error('[AI-SETUP] Products insert error:', error.message);
          created = data?.length || 0;
          // Raw database messages stay in the server log
          insertError = error ? 'Could not save these items. Please try again.' : undefined;
        }
        results.products = {
          created, skipped: skippedProducts,
          ...(errors.length ? { errors } : {}),
          ...(insertError ? { error: insertError } : {}),
        };
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
      results.operating_hours = { updated: !error, ...(error ? { error: 'Could not save opening hours. Please try again.' } : {}) };
    }

    // 4. Update bot greeting
    if (greeting) {
      const { error } = await service
        .from('whatsapp_configs')
        .update({ bot_greeting: greeting })
        .eq('business_id', business_id);
      if (error) logger.error('[AI-SETUP] Greeting update error:', error.message);
      results.greeting = { updated: !error, ...(error ? { error: 'Could not save the greeting. Please try again.' } : {}) };
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

    // Any section error (item validation or write failure) means the setup is
    // NOT complete — the client must not show success. Re-running is safe:
    // already-created names are skipped as duplicates.
    const failed = Object.values(results).some((r) => {
      const section = r as { error?: string; errors?: ItemError[] };
      return Boolean(section.error) || Boolean(section.errors?.length);
    });

    return NextResponse.json({ success: !failed, results }, { status: failed ? 207 : 200 });
  } catch (error) {
    logger.error('[AI-SETUP] Apply error:', (error as Error).message);
    return NextResponse.json({ error: 'Failed to apply setup' }, { status: 500 });
  }
}
