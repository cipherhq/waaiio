import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { logger } from '@/lib/logger';
import { safeLogErrorContext } from '@/lib/errors';

interface BulkProduct {
  name: string;
  price: number;
  description?: string;
  category?: string;
  stock_quantity?: number;
}

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { business_id, products } = await request.json() as {
    business_id: string;
    products: BulkProduct[];
  };

  if (!business_id || !products || !Array.isArray(products)) {
    return NextResponse.json({ error: 'Missing business_id or products array' }, { status: 400 });
  }

  if (products.length > 500) {
    return NextResponse.json({ error: 'Maximum 500 products per request' }, { status: 400 });
  }

  // Verify ownership
  const { data: biz } = await supabase
    .from('businesses')
    .select('id')
    .eq('id', business_id)
    .eq('owner_id', user.id)
    .maybeSingle();

  if (!biz) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
  }

  // Validate and clean products
  const valid: Record<string, unknown>[] = [];
  const errors: { row: number; reason: string }[] = [];

  // Get current max sort_order
  const { data: lastProduct } = await supabase
    .from('products')
    .select('sort_order')
    .eq('business_id', business_id)
    .order('sort_order', { ascending: false })
    .limit(1)
    .maybeSingle();

  let sortOrder = (lastProduct?.sort_order ?? -1) + 1;

  for (let i = 0; i < products.length; i++) {
    const p = products[i];
    if (!p.name || typeof p.name !== 'string' || !p.name.trim()) {
      errors.push({ row: i + 1, reason: 'Missing product name' });
      continue;
    }
    const price = Number(p.price);
    if (isNaN(price) || price < 0) {
      errors.push({ row: i + 1, reason: `Invalid price for "${p.name}"` });
      continue;
    }

    valid.push({
      business_id,
      name: p.name.trim(),
      price,
      description: p.description?.trim() || null,
      category: p.category?.trim() || null,
      stock_quantity: p.stock_quantity != null ? Number(p.stock_quantity) : null,
      is_active: true,
      sort_order: sortOrder++,
    });
  }

  if (valid.length === 0) {
    return NextResponse.json({ error: 'No valid products to import', errors }, { status: 400 });
  }

  // Insert in batches of 50
  let inserted = 0;
  for (let i = 0; i < valid.length; i += 50) {
    const batch = valid.slice(i, i + 50);
    const { error } = await supabase.from('products').insert(batch);
    if (!error) {
      inserted += batch.length;
    } else {
      logger.withContext({ op: 'products-bulk.insert', ...safeLogErrorContext(error) }).error('[PRODUCTS-BULK] Batch insert error');
      errors.push({ row: i + 1, reason: 'Batch insert failed. Check product data and try again.' });
    }
  }

  return NextResponse.json({
    success: true,
    imported: inserted,
    skipped: products.length - inserted,
    errors: errors.length > 0 ? errors : undefined,
  });
}
