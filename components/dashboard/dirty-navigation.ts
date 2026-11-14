'use client';

import { useEffect } from 'react';

const eventName = 'waaiio:before-dashboard-navigation';

/** Optional guard: only an actively dirty builder registers a listener. */
export function allowDashboardNavigation(): boolean {
  return window.dispatchEvent(new Event(eventName, { cancelable: true }));
}

export function useDirtyNavigation(dirty: boolean) {
  useEffect(() => {
    if (!dirty) return;
    const confirm = () => window.confirm('Leave without saving? Draft changes will be lost.');
    const beforeNavigation = (event: Event) => { if (!confirm()) event.preventDefault(); };
    const click = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null;
      if (!(anchor instanceof HTMLAnchorElement) || anchor.hasAttribute('download') || (anchor.target && anchor.target !== '_self')) return;
      const target = new URL(anchor.href, window.location.href);
      if (target.origin === window.location.origin && target.pathname === window.location.pathname && target.search === window.location.search) return;
      if (!confirm()) { event.preventDefault(); event.stopPropagation(); }
    };
    window.addEventListener(eventName, beforeNavigation);
    document.addEventListener('click', click, true);
    return () => {
      window.removeEventListener(eventName, beforeNavigation);
      document.removeEventListener('click', click, true);
    };
  }, [dirty]);
}
