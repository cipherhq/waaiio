import { Shield, ShieldCheck, LockKeyhole, Info } from 'lucide-react';
import { useAdminSession } from '@/components/AdminLayout';
import { ADMIN_PERMISSIONS, hasAccess } from '@/lib/permissions';
import type { AdminRole } from '@/lib/adminAuth';

const ROLES: AdminRole[] = ['admin', 'support', 'finance', 'operations'];

const PAGE_LABELS: Record<string, string> = {
  dashboard: 'Dashboard',
  users: 'Users',
  customers: 'Customers',
  'admin-team': 'Admin Team',
  businesses: 'Accounts',
  verification: 'Verification',
  'category-templates': 'Category Templates',
  impersonation: 'Impersonation',
  'impersonation-audit': 'Impersonation Audit',
  resellers: 'Resellers',
  'demo-requests': 'Demo Requests',
  'reseller-financials': 'Reseller Financials',
  'reseller-payouts': 'Reseller Payouts',
  promotions: 'Instant Win',
  bookings: 'Bookings / Class Sessions',
  orders: 'Orders',
  payments: 'Payments',
  subscriptions: 'Subscriptions',
  recurring: 'Recurring',
  'pending-transfers': 'Bank Transfers',
  tickets: 'Tickets',
  alerts: 'Alerts',
  surveys: 'Surveys',
  reports: 'Reports',
  'queue-management': 'Queue Management',
  engagement: 'Engagement',
  giving: 'Giving',
  'bot-management': 'Bot Management',
  'bot-keywords': 'Bot Keywords',
  'llm-logs': 'LLM Logs',
  'whatsapp-channels': 'WhatsApp Channels',
  'whatsapp-templates': 'WhatsApp Templates',
  notifications: 'Notifications',
  broadcasts: 'Broadcasts',
  support: 'Support',
  'chat-history': 'Chat History',
  payouts: 'Payouts',
  finance: 'Finance',
  'fee-invoices': 'Fee Invoices',
  content: 'Content Management',
  events: 'Events',
  campaigns: 'Campaigns',
  countries: 'Countries',
  'ai-setup-log': 'AI Setup Log',
  'ai-usage': 'AI Usage',
  'conversation-usage': 'Conversation Usage',
  'platform-settings': 'Platform Settings / Site Announcement / Launch Subscribers',
  'audit-log': 'Audit Log',
  'system-health': 'System Health',
  permissions: 'Permissions',
  'ai-marketplace': 'AI Marketplace',
};

function labelFor(page: string): string {
  return PAGE_LABELS[page] || page;
}

export default function AdminPermissions() {
  const session = useAdminSession();
  const isFullAdmin = session?.role === 'admin';

  if (!isFullAdmin) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <div className="text-center">
          <h2 className="mb-2 text-xl font-semibold text-gray-900">Access Restricted</h2>
          <p className="text-gray-500">Only full admins can view the platform access reference.</p>
        </div>
      </div>
    );
  }

  const pages = Object.keys(ADMIN_PERMISSIONS).sort((a, b) =>
    labelFor(a).localeCompare(labelFor(b)),
  );

  return (
    <div className="space-y-6">
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-purple-100 text-purple-600">
          <Shield className="h-5 w-5" />
        </div>
        <div>
          <h1 className="text-xl font-bold text-gray-900">Platform Access Reference</h1>
          <p className="mt-1 text-sm text-gray-500">
            Read-only view of the code-defined Admin navigation and route-access matrix.
          </p>
        </div>
      </div>

      <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
        <div className="flex items-start gap-3">
          <LockKeyhole className="mt-0.5 h-5 w-5 shrink-0" />
          <div className="space-y-1">
            <p className="font-semibold">Dynamic permission editing is intentionally disabled.</p>
            <p>
              This screen previously edited a database matrix that did not control the Admin route/sidebar
              authority and was not a universal API/RLS authorization source. To avoid misleading grants or
              revocations, this page now shows the effective code-defined navigation access only.
            </p>
          </div>
        </div>
      </div>

      <div className="rounded-xl border border-blue-200 bg-blue-50 p-4 text-sm text-blue-900">
        <div className="flex items-start gap-3">
          <Info className="mt-0.5 h-5 w-5 shrink-0" />
          <div className="space-y-1">
            <p className="font-semibold">Authorization has multiple enforcement layers.</p>
            <p>
              Server Admin APIs and Supabase RLS/RPCs enforce their own trusted role checks. A checkmark here
              means the role may navigate to that Admin page; it does not weaken or replace server/database
              authorization. Unknown page keys fail closed.
            </p>
          </div>
        </div>
      </div>

      <div className="overflow-hidden rounded-xl border border-gray-200 bg-white">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 bg-gray-50">
                <th className="px-4 py-3 text-left font-semibold text-gray-700">Admin page</th>
                {ROLES.map((role) => (
                  <th key={role} className="px-4 py-3 text-center font-semibold capitalize text-gray-700">
                    {role}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {pages.map((page, index) => (
                <tr key={page} className={index % 2 === 0 ? 'bg-white' : 'bg-gray-50/40'}>
                  <td className="px-4 py-3">
                    <div className="font-medium text-gray-800">{labelFor(page)}</div>
                    <div className="mt-0.5 font-mono text-[11px] text-gray-400">{page}</div>
                  </td>
                  {ROLES.map((role) => {
                    const allowed = hasAccess(page, role);
                    return (
                      <td key={role} className="px-4 py-3 text-center">
                        {allowed ? (
                          <span
                            aria-label={`${role} can access ${page}`}
                            title="Navigation access allowed"
                            className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-green-100 text-green-700"
                          >
                            <ShieldCheck className="h-4 w-4" />
                          </span>
                        ) : (
                          <span
                            aria-label={`${role} cannot access ${page}`}
                            title="Navigation access denied"
                            className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-gray-100 text-gray-400"
                          >
                            <LockKeyhole className="h-4 w-4" />
                          </span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="rounded-xl border border-gray-200 bg-white p-4 text-xs text-gray-500">
        Source of this reference: <code className="font-mono">admin/src/lib/permissions.ts</code>.
        Changes to platform authorization should be made through reviewed code and the relevant server/database
        authority—not by editing a partial client-side matrix.
      </div>
    </div>
  );
}
