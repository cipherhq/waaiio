import { useEffect, useState } from 'react';
import { adminDb } from '@/lib/supabase';
import { useAdminSession } from '@/components/AdminLayout';

interface Permission {
  resource: string;
  can_read: boolean;
  can_write: boolean;
  can_delete: boolean;
}

export function usePermissions() {
  const session = useAdminSession();
  const [permissions, setPermissions] = useState<Permission[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!session?.role) return;
    // Admin has full access — skip DB query
    if (session.role === 'admin') {
      setPermissions([]);
      setLoading(false);
      return;
    }
    adminDb.from('admin_role_permissions')
      .select('resource, can_read, can_write, can_delete')
      .eq('role', session.role)
      .then(({ data }) => {
        setPermissions(data || []);
        setLoading(false);
      });
  }, [session?.role]);

  function can(resource: string, action: 'read' | 'write' | 'delete'): boolean {
    if (session?.role === 'admin') return true;
    const perm = permissions.find(p => p.resource === resource);
    if (!perm) return false;
    if (action === 'read') return perm.can_read;
    if (action === 'write') return perm.can_write;
    if (action === 'delete') return perm.can_delete;
    return false;
  }

  return { can, permissions, loading };
}
