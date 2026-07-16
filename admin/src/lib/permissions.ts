import type { AdminRole } from './adminAuth';

/** All admin pages and which roles can access them */
export const ADMIN_PERMISSIONS: Record<string, AdminRole[]> = {
  // Dashboard
  'dashboard': ['admin', 'support', 'finance', 'operations'],

  // Users
  'users': ['admin'],
  'customers': ['admin', 'support', 'operations'],
  'admin-team': ['admin'],

  // Businesses
  'businesses': ['admin', 'support', 'operations'],
  'verification': ['admin', 'operations'],
  'category-templates': ['admin'],
  'impersonation': ['admin'],
  'impersonation-audit': ['admin'],
  'resellers': ['admin'],
  'demo-requests': ['admin', 'support'],
  'reseller-financials': ['admin', 'finance'],
  'reseller-payouts': ['admin', 'finance'],

  // Operations
  'bookings': ['admin', 'support', 'operations'],
  'orders': ['admin', 'support', 'operations'],
  'payments': ['admin', 'finance'],
  'subscriptions': ['admin', 'finance'],
  'recurring': ['admin', 'finance'],
  'pending-transfers': ['admin', 'finance'],
  'tickets': ['admin', 'support', 'operations'],
  'alerts': ['admin', 'support', 'operations'],
  'reports': ['admin', 'operations'],
  'queue-management': ['admin', 'operations'],
  'engagement': ['admin', 'operations'],

  // Giving
  'giving': ['admin', 'finance'],

  // Communication
  'bot-management': ['admin', 'operations'],
  'bot-keywords': ['admin', 'operations'],
  'llm-logs': ['admin'],
  'whatsapp-channels': ['admin', 'operations'],
  'whatsapp-templates': ['admin'],
  'notifications': ['admin'],
  'broadcasts': ['admin'],
  'support': ['admin', 'support'],
  'chat-history': ['admin', 'support', 'operations'],
  'surveys': ['admin', 'operations'],

  // Finance
  'payouts': ['admin', 'finance'],
  'finance': ['admin', 'finance'],
  'fee-invoices': ['admin', 'finance'],

  // System
  'content': ['admin'],
  'events': ['admin', 'operations'],
  'campaigns': ['admin', 'operations'],
  'countries': ['admin'],
  'ai-setup-log': ['admin'],
  'ai-usage': ['admin'],
  'conversation-usage': ['admin'],
  'platform-settings': ['admin'],
  'audit-log': ['admin'],
  'system-health': ['admin'],
  'permissions': ['admin'],
  'ai-marketplace': ['admin'],
};

/** Check if a role has access to a page */
export function hasAccess(page: string, role: AdminRole): boolean {
  const allowed = ADMIN_PERMISSIONS[page];
  if (!allowed) return false; // Unknown page = deny
  return allowed.includes(role);
}

/** Get all accessible pages for a role */
export function getAccessiblePages(role: AdminRole): string[] {
  return Object.entries(ADMIN_PERMISSIONS)
    .filter(([, roles]) => roles.includes(role))
    .map(([page]) => page);
}
