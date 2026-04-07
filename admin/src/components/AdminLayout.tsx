import { createContext, useContext, useEffect, useState } from 'react';
import { Outlet, useNavigate, useLocation } from 'react-router';
import { requireAdminSession, type AdminSession } from '@/lib/adminAuth';
import { supabase } from '@/lib/supabase';
import { loadCountries } from '@/lib/countries';
import { AdminSidebar } from './AdminSidebar';

const AdminSessionContext = createContext<AdminSession | null>(null);

export function useAdminSession(): AdminSession | null {
  return useContext(AdminSessionContext);
}

export function AdminLayout() {
  const [checking, setChecking] = useState(true);
  const [session, setSession] = useState<AdminSession | null>(null);
  const navigate = useNavigate();
  const location = useLocation();

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
        <AdminSidebar />
        <div className="flex-1 overflow-y-auto p-6 lg:p-8">
          <Outlet />
        </div>
      </div>
    </AdminSessionContext.Provider>
  );
}
