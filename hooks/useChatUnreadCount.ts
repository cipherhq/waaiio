'use client';

import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';

export function useChatUnreadCount(businessId: string): number {
  const [count, setCount] = useState(0);

  useEffect(() => {
    if (!businessId) return;

    const supabase = createClient();

    // Initial count
    async function fetchCount() {
      const { count: unread } = await supabase
        .from('chat_messages')
        .select('*', { count: 'exact', head: true })
        .eq('business_id', businessId)
        .eq('direction', 'inbound')
        .eq('is_read', false);

      setCount(unread || 0);
    }

    fetchCount();

    // Realtime: re-fetch on any change to chat_messages for this business
    const channel = supabase
      .channel(`chat_unread:${businessId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'chat_messages',
          filter: `business_id=eq.${businessId}`,
        },
        () => {
          fetchCount();
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [businessId]);

  return count;
}
