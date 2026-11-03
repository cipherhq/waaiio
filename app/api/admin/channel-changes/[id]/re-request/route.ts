import type { NextRequest } from 'next/server';
import { channelChangeOptions, mutateChannelChange } from '@/lib/admin-channel-change';

export const OPTIONS = channelChangeOptions;
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return mutateChannelChange(request, 'refresh', (await params).id);
}
