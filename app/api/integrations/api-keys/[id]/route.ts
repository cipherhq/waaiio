import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';

/**
 * DELETE /api/integrations/api-keys/[id] — revoke an API key (soft delete)
 */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    // Verify the key belongs to a business owned by this user
    const { data: key } = await supabase
      .from('api_keys')
      .select('id, business_id, businesses!inner(owner_id)')
      .eq('id', id)
      .single();

    if (!key) return NextResponse.json({ error: 'Key not found' }, { status: 404 });

    const biz = key.businesses as unknown as { owner_id: string };
    if (biz.owner_id !== user.id) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    await supabase
      .from('api_keys')
      .update({ revoked_at: new Date().toISOString() })
      .eq('id', id);

    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
