import type { NextRequest } from 'next/server';
import { requirePlatformAdmin } from '@/lib/admin-auth';
import { channelChangeDescriptor, channelChangeFailure, channelChangeOptions, channelChangeResponse, safeChannelOperation } from '@/lib/admin-channel-change';

export const OPTIONS = channelChangeOptions;
export async function POST(request: NextRequest) {
  const admin = await requirePlatformAdmin(request, { requiredRole: 'admin' });
  if (!admin) return channelChangeResponse(request, { error: 'Forbidden' }, 403);
  try {
    const bound = await channelChangeDescriptor(admin, await request.json());
    return channelChangeResponse(request, {
      previewHash: bound.hash, actionType: bound.actionType, targetId: bound.targetId,
      operation: safeChannelOperation(bound.descriptor.operation),
    });
  } catch (error) { return channelChangeFailure(request, error); }
}
