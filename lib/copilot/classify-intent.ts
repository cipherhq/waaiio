/**
 * Ace AI Copilot — Intent Classification
 *
 * Maps natural-language questions to a fixed report catalog.
 * No LLM involved — deterministic regex matching.
 */

export type ReportId =
  | 'bookings_today' | 'bookings_upcoming' | 'bookings_week' | 'bookings_month'
  | 'orders_today' | 'orders_pending'
  | 'revenue_today' | 'revenue_week' | 'revenue_month' | 'revenue_compare'
  | 'unpaid_bookings' | 'unpaid_invoices'
  | 'top_products' | 'top_services'
  | 'customers_new' | 'customers_returning'
  | 'cancellation_rate'
  | 'checkins_today'
  | 'low_stock'
  | 'attention_items';

export interface FollowUpContext {
  lastReport?: ReportId;
  lastPeriod?: string;
  lastEntity?: string;
}

/** Reports that require finance-level access */
export const FINANCE_REPORTS: ReportId[] = [
  'revenue_today', 'revenue_week', 'revenue_month', 'revenue_compare',
  'unpaid_bookings', 'unpaid_invoices', 'top_products', 'top_services',
];

/** Roles that can see financial reports */
export const FINANCE_ROLES = ['owner', 'admin', 'manager', 'finance'];

export function classifyIntent(
  question: string,
  context?: FollowUpContext,
): { report: ReportId | null; followUp: boolean } {
  const q = question.toLowerCase().trim();

  // Follow-up detection
  if (context?.lastReport) {
    if (/^(what about |how about |and )?(last|previous) week/i.test(q)) {
      const weekVersions: Record<string, ReportId> = {
        revenue_today: 'revenue_compare', revenue_week: 'revenue_compare',
        bookings_today: 'bookings_week',
      };
      return { report: weekVersions[context.lastReport] || context.lastReport, followUp: true };
    }
    if (/^(what about |how about |and )?(last|previous) month/i.test(q)) {
      const monthVersions: Record<string, ReportId> = {
        revenue_today: 'revenue_compare', revenue_week: 'revenue_compare', revenue_month: 'revenue_compare',
        bookings_today: 'bookings_month',
      };
      return { report: monthVersions[context.lastReport] || context.lastReport, followUp: true };
    }
    if (/^(compare|vs|versus|comparison)/i.test(q) && /revenue/i.test(context.lastReport)) {
      return { report: 'revenue_compare', followUp: true };
    }
  }

  // Bookings / appointments
  if (/booking|appointment/i.test(q)) {
    if (/today|now|right now/i.test(q)) return { report: 'bookings_today', followUp: false };
    if (/upcoming|next|tomorrow|future|scheduled/i.test(q)) return { report: 'bookings_upcoming', followUp: false };
    if (/week/i.test(q)) return { report: 'bookings_week', followUp: false };
    if (/month/i.test(q)) return { report: 'bookings_month', followUp: false };
    if (/unpaid|outstanding|owe|pending/i.test(q)) return { report: 'unpaid_bookings', followUp: false };
    if (/cancel/i.test(q)) return { report: 'cancellation_rate', followUp: false };
    return { report: 'bookings_today', followUp: false };
  }

  // Orders
  if (/order/i.test(q)) {
    if (/pending|open|unfulfilled|waiting/i.test(q)) return { report: 'orders_pending', followUp: false };
    return { report: 'orders_today', followUp: false };
  }

  // Revenue / earnings / income
  if (/revenue|earn|income|money|sales|made/i.test(q)) {
    if (/compare|vs|versus|comparison|differ/i.test(q)) return { report: 'revenue_compare', followUp: false };
    if (/month/i.test(q)) return { report: 'revenue_month', followUp: false };
    if (/week/i.test(q)) return { report: 'revenue_week', followUp: false };
    return { report: 'revenue_today', followUp: false };
  }

  // Unpaid / outstanding
  if (/unpaid|outstanding|owe|overdue/i.test(q)) {
    if (/invoice/i.test(q)) return { report: 'unpaid_invoices', followUp: false };
    return { report: 'unpaid_bookings', followUp: false };
  }

  // Products
  if (/top.*product|best.*sell|popular.*product|most.*sold/i.test(q)) return { report: 'top_products', followUp: false };
  if (/low.*stock|out.*stock|inventory.*low|running.*low/i.test(q)) return { report: 'low_stock', followUp: false };

  // Services
  if (/top.*service|best.*service|popular.*service|most.*booked/i.test(q)) return { report: 'top_services', followUp: false };

  // Customers
  if (/new.*customer|first.*time|new.*client/i.test(q)) return { report: 'customers_new', followUp: false };
  if (/return.*customer|repeat|loyal.*customer|coming.*back/i.test(q)) return { report: 'customers_returning', followUp: false };

  // Cancellations
  if (/cancel/i.test(q)) return { report: 'cancellation_rate', followUp: false };

  // Check-ins / attendance
  if (/check.?in|attendance/i.test(q)) return { report: 'checkins_today', followUp: false };

  // Attention / action items
  if (/attention|action|need.*do|to.?do|urgent|alert/i.test(q)) return { report: 'attention_items', followUp: false };

  return { report: null, followUp: false };
}
