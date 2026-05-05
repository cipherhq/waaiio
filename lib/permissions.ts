/**
 * Business Team Roles & Permissions
 *
 * Defines what each role can access in the dashboard.
 * Used by middleware, API routes, and sidebar filtering.
 */

export type BusinessRole = 'owner' | 'admin' | 'manager' | 'staff' | 'finance' | 'support';

export interface RolePermissions {
  label: string;
  description: string;
  pages: string[];  // dashboard page paths this role can access
}

export const ROLE_PERMISSIONS: Record<BusinessRole, RolePermissions> = {
  owner: {
    label: 'Owner',
    description: 'Full access to everything including billing and team management',
    pages: ['*'], // all pages
  },
  admin: {
    label: 'Admin',
    description: 'Everything except billing and deleting the business',
    pages: [
      'overview', 'reservations', 'calendar', 'services', 'customers', 'products', 'orders',
      'quotes', 'chat', 'contracts', 'feedback', 'payouts', 'financials', 'broadcasts',
      'surveys', 'polls', 'analytics', 'whatsapp', 'whatsapp-usage', 'wa-templates',
      'integrations', 'bot-flows', 'qr-code', 'settings', 'capabilities', 'help', 'support',
      'events', 'tickets', 'events/scan', 'invoices', 'staff', 'queue', 'waitlist',
      'loyalty', 'referral', 'keywords', 'sequences', 'notifications', 'locations',
      'setup-assistant', 'insights', 'recurring', 'promo-codes', 'members', 'team',
    ],
  },
  manager: {
    label: 'Manager',
    description: 'Bookings, orders, chat, invoices, and analytics',
    pages: [
      'overview', 'reservations', 'calendar', 'services', 'customers', 'products', 'orders',
      'quotes', 'chat', 'contracts', 'feedback', 'broadcasts', 'surveys', 'polls',
      'analytics', 'events', 'tickets', 'events/scan', 'invoices', 'queue', 'waitlist',
      'loyalty', 'referral', 'notifications', 'insights', 'promo-codes', 'members',
    ],
  },
  staff: {
    label: 'Staff',
    description: 'View bookings, update status, and chat with customers',
    pages: [
      'overview', 'reservations', 'calendar', 'customers', 'chat', 'feedback',
      'queue', 'events/scan', 'notifications',
    ],
  },
  finance: {
    label: 'Finance',
    description: 'Invoices, payouts, and financial reports',
    pages: [
      'overview', 'invoices', 'payouts', 'financials', 'analytics', 'recurring',
      'notifications',
    ],
  },
  support: {
    label: 'Support',
    description: 'Chat with customers and view feedback',
    pages: [
      'overview', 'chat', 'customers', 'feedback', 'notifications', 'help', 'support',
    ],
  },
};

/** Check if a role can access a specific page */
export function canAccessPage(role: BusinessRole, page: string): boolean {
  const perms = ROLE_PERMISSIONS[role];
  if (!perms) return false;
  if (perms.pages.includes('*')) return true;
  return perms.pages.includes(page);
}

/** Get all roles that can access a specific page */
export function getRolesForPage(page: string): BusinessRole[] {
  return (Object.keys(ROLE_PERMISSIONS) as BusinessRole[]).filter(role =>
    canAccessPage(role, page)
  );
}

/** Role hierarchy for display ordering */
export const ROLE_ORDER: BusinessRole[] = ['owner', 'admin', 'manager', 'staff', 'finance', 'support'];

/** Team member limits per tier */
export const TEAM_LIMITS: Record<string, number> = {
  free: 1,     // owner only
  growth: 3,
  business: 999, // unlimited
};
