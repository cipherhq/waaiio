'use client';

import { useEffect, useState, useCallback } from 'react';

export function useAlertUnreadCount(): number {
  const [count, setCount] = useState(0);

  const fetchCount = useCallback(async () => {
    try {
      const res = await fetch('/api/dashboard/alerts?page=1');
      if (!res.ok) return;
      const data = await res.json();
      setCount(data.total || 0);
    } catch {
      // Silently fail
    }
  }, []);

  useEffect(() => {
    fetchCount();
    const interval = setInterval(fetchCount, 60000);
    return () => clearInterval(interval);
  }, [fetchCount]);

  return count;
}
