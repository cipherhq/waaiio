import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await request.json();
  const { business_id, package_id, customer_phone, customer_name } = body;

  if (!business_id || !package_id || !customer_phone) {
    return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
  }

  // Verify ownership
  const { data: biz } = await supabase
    .from('businesses')
    .select('id')
    .eq('id', business_id)
    .eq('owner_id', user.id)
    .single();

  if (!biz) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  // Get the package details
  const { data: pkg, error: pkgError } = await supabase
    .from('service_packages')
    .select('*')
    .eq('id', package_id)
    .eq('business_id', business_id)
    .eq('is_active', true)
    .single();

  if (pkgError || !pkg) {
    return NextResponse.json({ error: 'Package not found or inactive' }, { status: 404 });
  }

  // Calculate expiry date
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + (pkg.valid_days || 365));

  const { data: enrollment, error } = await supabase
    .from('package_enrollments')
    .insert({
      business_id,
      package_id,
      customer_phone: customer_phone.trim(),
      customer_name: customer_name?.trim() || null,
      sessions_total: pkg.num_sessions,
      sessions_used: 0,
      purchased_at: new Date().toISOString(),
      expires_at: expiresAt.toISOString(),
      is_active: true,
    })
    .select()
    .single();

  if (error) return NextResponse.json({ error: 'Failed to create enrollment' }, { status: 500 });
  return NextResponse.json({ enrollment });
}
