import { createContext, useContext, useEffect, useState } from 'react';
import { Outlet, useNavigate, useLocation } from 'react-router';
import { requireAdminSession, type AdminSession } from '@/lib/adminAuth';
import { supabase } from '@/lib/supabase';
import { loadCountries } from '@/lib/countries';
import { AdminSidebar } from './AdminSidebar';
import { IdleTimeout } from './IdleTimeout';

const AdminSessionContext = createContext<AdminSession | null>(null);

export function useAdminSession(): AdminSession | null {
  return useContext(AdminSessionContext);
}

export function AdminLayout() {
  const [checking, setChecking] = useState(true);
  const [session, setSession] = useState<AdminSession | null>(null);
  const [mobileOpen, setMobileOpen] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();

  // Load saved theme preference
  useEffect(() => {
    const stored = localStorage.getItem('admin-theme');
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    if (stored === 'dark' || (!stored && prefersDark)) {
      document.documentElement.classList.add('dark');
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    loadCountries();

    const verify = async () => {
      try {
        const adminSession = await requireAdminSession();
        if (!cancelled) setSession(adminSession);
      } catch {
        if (!cancelled) {
          setSession(null);
          navigate('/login', { replace: true, state: { from: location.pathname } });
        }
      } finally {
        if (!cancelled) setChecking(false);
      }
    };

    verify();

    const { data: authSub } = supabase.auth.onAuthStateChange(() => {
      verify();
    });

    return () => {
      cancelled = true;
      authSub.subscription.unsubscribe();
    };
  }, [location.pathname, navigate]);

  // Close sidebar on route change
  useEffect(() => {
    setMobileOpen(false);
  }, [location.pathname]);

  if (checking) {
    return (
      <div className="min-h-screen bg-white flex items-center justify-center">
        <p className="text-gray-500">Checking admin access...</p>
      </div>
    );
  }

  if (!session) return null;

  return (
    <AdminSessionContext.Provider value={session}>
      <div className="flex h-screen bg-gray-50 overflow-hidden">
        <AdminSidebar mobileOpen={mobileOpen} onClose={() => setMobileOpen(false)} />
        <IdleTimeout />
        <div className="flex-1 flex flex-col overflow-hidden">
          {/* Mobile header */}
          <div className="lg:hidden flex items-center gap-3 px-4 py-3 bg-white border-b border-gray-200 shrink-0">
            <button
              onClick={() => setMobileOpen(true)}
              className="p-1.5 rounded-lg hover:bg-gray-100 transition"
              aria-label="Open sidebar"
            >
              <svg className="w-6 h-6 text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
              </svg>
            </button>
            <img src="/logo.png" alt="Waaiio" className="h-6" />
            <p className="text-[10px] text-gray-400">Admin</p>
          </div>
          <div className="flex-1 overflow-y-auto p-4 sm:p-6 lg:p-8">
            <Outlet />
          </div>
        </div>
      </div>
    </AdminSessionContext.Provider>
  );
}
