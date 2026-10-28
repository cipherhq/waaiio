import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';

/**
 * DELETE /api/integrations/api-keys/[id] — revoke an API key (soft delete)
 * Uses service-role RPC for atomic ownership verification + revocation.
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

    // Atomic revocation via service-role RPC:
    // Verifies key exists, actor owns the business, sets revoked_at.
    const service = createServiceClient();
    const { data: success, error: rpcError } = await service.rpc('revoke_api_key', {
      p_key_id: id,
      p_actor_user_id: user.id,
    });

    if (rpcError) {
      const code = rpcError.code;
      if (code === 'WA001') {
        // Key not found or actor doesn't own it
        return NextResponse.json({ error: 'Key not found or forbidden' }, { status: 404 });
      }
      // Unexpected error — fail closed
      return NextResponse.json({ error: 'Failed to revoke API key' }, { status: 500 });
    }

    if (success === null || success === undefined) {
      return NextResponse.json({ error: 'Failed to revoke API key' }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
