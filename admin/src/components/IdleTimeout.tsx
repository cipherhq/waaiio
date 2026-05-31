import { useEffect, useRef, useState, useCallback } from 'react';
import { useNavigate } from 'react-router';
import { supabase } from '@/lib/supabase';

const IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const WARNING_BEFORE_MS = 5 * 60 * 1000; // 5 minutes warning
const THROTTLE_MS = 30 * 1000; // 30 seconds throttle
const STORAGE_KEY = 'waaiio_admin_last_activity';

export function IdleTimeout() {
  const navigate = useNavigate();
  const [showWarning, setShowWarning] = useState(false);
  const warningTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const logoutTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastActivityRef = useRef<number>(Date.now());
  const throttleRef = useRef<number>(0);

  const handleSignOut = useCallback(async () => {
    await supabase.auth.signOut();
    localStorage.removeItem(STORAGE_KEY);
    navigate('/login', { replace: true });
  }, [navigate]);

  const resetTimers = useCallback(() => {
    const now = Date.now();
    lastActivityRef.current = now;
    localStorage.setItem(STORAGE_KEY, String(now));
    setShowWarning(false);

    if (warningTimerRef.current) clearTimeout(warningTimerRef.current);
    if (logoutTimerRef.current) clearTimeout(logoutTimerRef.current);

    warningTimerRef.current = setTimeout(() => {
      setShowWarning(true);
      logoutTimerRef.current = setTimeout(() => {
        handleSignOut();
      }, WARNING_BEFORE_MS);
    }, IDLE_TIMEOUT_MS - WARNING_BEFORE_MS);
  }, [handleSignOut]);

  const handleActivity = useCallback(() => {
    const now = Date.now();
    if (now - throttleRef.current < THROTTLE_MS) return;
    throttleRef.current = now;
    resetTimers();
  }, [resetTimers]);

  const handleStaySignedIn = () => {
    resetTimers();
  };

  useEffect(() => {
    // Check localStorage for cross-tab activity
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const elapsed = Date.now() - Number(stored);
      if (elapsed >= IDLE_TIMEOUT_MS) {
        handleSignOut();
        return;
      }
      lastActivityRef.current = Number(stored);
    }

    resetTimers();

    const events = ['mousemove', 'keydown', 'click', 'scroll', 'touchstart'];
    events.forEach((event) => window.addEventListener(event, handleActivity, { passive: true }));

    // Listen for storage changes from other tabs
    const handleStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY && e.newValue) {
        lastActivityRef.current = Number(e.newValue);
        resetTimers();
      }
    };
    window.addEventListener('storage', handleStorage);

    return () => {
      events.forEach((event) => window.removeEventListener(event, handleActivity));
      window.removeEventListener('storage', handleStorage);
      if (warningTimerRef.current) clearTimeout(warningTimerRef.current);
      if (logoutTimerRef.current) clearTimeout(logoutTimerRef.current);
    };
  }, [handleActivity, handleSignOut, resetTimers]);

  if (!showWarning) return null;

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="mx-4 w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl dark:bg-gray-800">
        <div className="mb-4 flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-amber-100 dark:bg-amber-900/30">
            <svg className="h-5 w-5 text-amber-600 dark:text-amber-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Session Expiring</h2>
        </div>
        <p className="text-sm text-gray-600 dark:text-gray-300">
          Your session will expire in 5 minutes due to inactivity. Would you like to stay signed in?
        </p>
        <div className="mt-6 flex gap-3">
          <button
            onClick={handleStaySignedIn}
            className="flex-1 rounded-lg bg-purple-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-purple-700 transition-colors"
          >
            Stay Signed In
          </button>
          <button
            onClick={handleSignOut}
            className="flex-1 rounded-lg border border-gray-300 px-4 py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700 transition-colors"
          >
            Sign Out
          </button>
        </div>
      </div>
    </div>
  );
}
