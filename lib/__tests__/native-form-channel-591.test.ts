import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createMemoryDb } from './helpers/memory-db';
import { ChannelResolver } from '@/lib/channels/channel-resolver';
describe('#591 opt-in strict channel reads preserve ordinary defaults', () => {
  it('native transport lookup propagates database failure while the default remains unchanged', async () => {
    const db = createMemoryDb(); db.failReads.add('whatsapp_channels');
    expect(await new ChannelResolver(db as unknown as SupabaseClient).resolveByPhoneNumberId('123')).toBeNull();
    await expect(new ChannelResolver(db as unknown as SupabaseClient).resolveByPhoneNumberId('123', true)).rejects.toThrow('lookup unavailable');
  });
  it('native business lookup distinguishes database failure from a missing connection', async () => {
    const db = createMemoryDb(); db.failReads.add('businesses');
    await expect(new ChannelResolver(db as unknown as SupabaseClient).resolveByBusinessId('business', true)).rejects.toThrow('lookup unavailable');
    db.failReads.clear(); db.tables.businesses = [{id:'business',wa_method:'shared'}];
    expect(await new ChannelResolver(db as unknown as SupabaseClient).resolveByBusinessId('business',true)).toBeNull();
  });
});
