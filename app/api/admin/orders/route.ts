import { NextRequest, NextResponse } from 'next/server';
import { requirePlatformAdmin } from '@/lib/admin-auth';
import { createServiceClient } from '@/lib/supabase/service';
import { adminCorsHeaders } from '@/lib/admin-cors';

interface RawOrder {
  id: string; reference_code: string; business_id: string; user_id: string;
  status: string; total_amount: number; shipping_cost: number | null;
  delivery_address: string | null; delivery_phone: string | null; notes: string | null;
  created_at: string; updated_at: string | null;
  business: { name: string; country_code: string } | null;
  customer: { first_name: string | null; last_name: string | null; email: string | null } | null;
  order_items: Array<{ count: number }>;
}
interface RawItem {
  id: string; order_id: string; product_id: string; quantity: number; unit_price: number;
  variant_label: string | null; addons: unknown;
  product: { name: string } | null;
}
const LIMIT = 500;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Fixed projection: this endpoint cannot be used to query arbitrary customer data.
const ORDER_FIELDS = 'id,reference_code,business_id,user_id,status,total_amount,shipping_cost,delivery_address,delivery_phone,notes,created_at,updated_at,business:businesses!orders_business_id_fkey(name,country_code),customer:profiles!orders_user_id_fkey(first_name,last_name,email),order_items(count)';
const headers = (request: NextRequest) => ({ ...adminCorsHeaders(request.headers.get('origin'), 'GET, OPTIONS'), 'Cache-Control': 'no-store', Vary: 'Origin' });
export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: headers(request) });
}
export async function GET(request: NextRequest) {
  const respond = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: headers(request) });
  const admin = await requirePlatformAdmin(request, { requiredRole: ['admin', 'support', 'operations'] });
  if (!admin) return respond({ error: 'Unauthorized' }, 403);
  const orderId = request.nextUrl.searchParams.get('orderId');
  if (orderId !== null && !UUID.test(orderId)) return respond({ error: 'Invalid order ID' }, 400);
  try {
    const db = createServiceClient();
    let query = db.from('orders').select(ORDER_FIELDS).order('created_at', { ascending: false }).order('id', { ascending: false });
    if (orderId) query = query.eq('id', orderId);
    const { data, error } = await query.limit(orderId ? 1 : LIMIT + 1);
    if (error || !data) throw new Error('Order read failed');
    if (orderId && data.length === 0) return respond({ error: 'Order not found' }, 404);
    const rows = (data as unknown as RawOrder[]).slice(0, LIMIT);
    const codes = [...new Set(rows.map(row => row.business?.country_code).filter(Boolean))];
    const countries = codes.length ? await db.from('countries').select('code,currency_code').in('code', codes) : { data: [], error: null };
    if (countries.error) throw new Error('Currency read failed');
    const currencies = new Map((countries.data || []).map(country => [country.code, country.currency_code]));
    const orders = rows.map(({ business, customer, order_items, ...order }) => ({
      ...order,
      business_name: business?.name || 'Unknown',
      country_code: business?.country_code || null,
      currency: currencies.get(business?.country_code) || null,
      customer_name: [customer?.first_name, customer?.last_name].filter(Boolean).join(' ') || 'Unknown',
      customer_email: customer?.email || null,
      items_count: order_items?.[0]?.count ?? 0,
    }));
    if (!orderId) return respond({ data: orders, limit: LIMIT, truncated: data.length > LIMIT });
    // Range through all lines instead of silently presenting a server-capped subset.
    const items = [];
    for (let offset = 0; ; offset += 500) {
      const result = await db.from('order_items')
        .select('id,order_id,product_id,quantity,unit_price,variant_label,addons,product:products!order_items_product_id_fkey(name)')
        .eq('order_id', orderId).order('id', { ascending: true }).range(offset, offset + 499);
      if (result.error || !result.data) throw new Error('Item read failed');
      items.push(...(result.data as unknown as RawItem[]).map(({ product, ...item }) => ({ ...item, product_name: product?.name || null })));
      if (result.data.length < 500) break;
    }
    return respond({ data: { ...orders[0], items } });
  } catch {
    return respond({ error: 'Unable to load orders. Please retry.' }, 503);
  }
}
