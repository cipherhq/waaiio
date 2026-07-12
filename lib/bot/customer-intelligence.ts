import type { SupabaseClient } from '@supabase/supabase-js';
import { logger } from '@/lib/logger';

export interface CustomerHistory {
  isReturning: boolean;
  totalVisits: number;
  totalSpent: number;
  lastServiceName: string | null;
  lastServiceId: string | null;
  lastFlowType: string | null;  // 'scheduling', 'payment', 'ticketing', etc.
  lastVisitDate: string | null;
  daysSinceLastVisit: number | null;
  favoriteServiceName: string | null;
  favoriteServiceId: string | null;
  loyaltyPoints: number | null;
}

/**
 * Look up a customer's history with a specific business.
 * Used by the bot to personalize greetings and suggest repeat bookings.
 */
export async function getCustomerHistory(
  supabase: SupabaseClient,
  phone: string,
  businessId: string,
): Promise<CustomerHistory> {
  const empty: CustomerHistory = {
    isReturning: false,
    totalVisits: 0,
    totalSpent: 0,
    lastServiceName: null,
    lastServiceId: null,
    lastFlowType: null,
    lastVisitDate: null,
    daysSinceLastVisit: null,
    favoriteServiceName: null,
    favoriteServiceId: null,
    loyaltyPoints: null,
  };

  try {
    // Normalize phone
    const phoneVariants = [
      phone,
      phone.startsWith('+') ? phone.slice(1) : `+${phone}`,
    ];

    // Get past bookings for this customer at this business
    const { data: bookings } = await supabase
      .from('bookings')
      .select('id, service_id, appointment_id, flow_type, date, total_amount, status, guest_phone')
      .eq('business_id', businessId)
      .in('guest_phone', phoneVariants)
      .in('status', ['completed', 'confirmed'])
      .order('date', { ascending: false })
      .limit(50);

    if (!bookings || bookings.length === 0) return empty;

    // Get service names for the bookings
    const serviceIds = [...new Set(bookings.map(b => b.service_id).filter(Boolean))];
    const { data: services } = serviceIds.length > 0
      ? await supabase.from('services').select('id, name').in('id', serviceIds)
      : { data: [] };
    const serviceMap = new Map((services || []).map(s => [s.id, s.name]));

    // Also resolve appointment names for bookings that have appointment_id but no service_id
    const appointmentIds = [...new Set(bookings.filter(b => b.appointment_id && !b.service_id).map(b => b.appointment_id).filter(Boolean))];
    if (appointmentIds.length > 0) {
      const { data: appointments } = await supabase
        .from('appointments')
        .select('id, name')
        .in('id', appointmentIds);
      if (appointments) {
        for (const a of appointments) serviceMap.set(a.id, a.name);
      }
    }

    // Calculate stats
    const totalVisits = bookings.length;
    const totalSpent = bookings.reduce((sum, b) => sum + (b.total_amount || 0), 0);

    // Last visit
    const lastBooking = bookings[0];
    const lastServiceName = lastBooking.service_id
      ? serviceMap.get(lastBooking.service_id) || null
      : lastBooking.appointment_id
        ? serviceMap.get(lastBooking.appointment_id) || null
        : null;
    const lastVisitDate = lastBooking.date;
    const daysSince = lastVisitDate
      ? Math.floor((Date.now() - new Date(lastVisitDate + 'T00:00').getTime()) / (1000 * 60 * 60 * 24))
      : null;

    // Favorite service (most booked) — considers both service_id and appointment_id
    const serviceCounts = new Map<string, number>();
    for (const b of bookings) {
      const itemId = b.service_id || b.appointment_id;
      if (itemId) {
        serviceCounts.set(itemId, (serviceCounts.get(itemId) || 0) + 1);
      }
    }
    let favoriteId: string | null = null;
    let maxCount = 0;
    for (const [id, count] of serviceCounts) {
      if (count > maxCount) {
        maxCount = count;
        favoriteId = id;
      }
    }

    // Loyalty points
    const { data: loyalty } = await supabase
      .from('loyalty_points')
      .select('points_balance')
      .eq('business_id', businessId)
      .in('customer_phone', phoneVariants)
      .maybeSingle();

    return {
      isReturning: true,
      totalVisits,
      totalSpent,
      lastServiceName,
      lastServiceId: lastBooking.service_id || lastBooking.appointment_id || null,
      lastFlowType: lastBooking.flow_type || null,
      lastVisitDate,
      daysSinceLastVisit: daysSince,
      favoriteServiceName: favoriteId ? serviceMap.get(favoriteId) || null : null,
      favoriteServiceId: favoriteId,
      loyaltyPoints: loyalty?.points_balance || null,
    };
  } catch (err) {
    logger.warn('[CUSTOMER-INTELLIGENCE] Failed to load customer profile:', err);
    return empty;
  }
}

/**
 * Build a personalized returning customer message.
 */
export function buildReturnGreeting(
  customerName: string | null,
  history: CustomerHistory,
  businessName: string,
): string | null {
  if (!history.isReturning || history.totalVisits < 2) return null;

  const name = customerName ? customerName.split(' ')[0] : '';
  const parts: string[] = [];

  if (name) {
    parts.push(`Welcome back, *${name}*! 👋`);
  } else {
    parts.push('Welcome back! 👋');
  }

  if (history.lastServiceName && history.daysSinceLastVisit !== null) {
    if (history.daysSinceLastVisit <= 7) {
      parts.push(`Good to see you again so soon!`);
    } else if (history.daysSinceLastVisit <= 30) {
      parts.push(`Last time you had *${history.lastServiceName}*. Want the same?`);
    } else {
      parts.push(`It's been a while! Your last visit was *${history.lastServiceName}* ${history.daysSinceLastVisit} days ago.`);
    }
  }

  if (history.loyaltyPoints && history.loyaltyPoints > 0) {
    parts.push(`\n💎 You have *${history.loyaltyPoints} loyalty points*.`);
  }

  return parts.join(' ');
}

/**
 * Calculate a simple churn risk score (0-100).
 * Higher = more likely to churn.
 */
export function calculateChurnRisk(history: CustomerHistory): number {
  if (!history.isReturning) return 0; // Can't churn if never visited

  let risk = 0;

  // Recency: more days since last visit = higher risk
  if (history.daysSinceLastVisit !== null) {
    if (history.daysSinceLastVisit > 90) risk += 40;
    else if (history.daysSinceLastVisit > 60) risk += 30;
    else if (history.daysSinceLastVisit > 30) risk += 20;
    else if (history.daysSinceLastVisit > 14) risk += 10;
  }

  // Frequency: fewer visits = higher risk
  if (history.totalVisits <= 1) risk += 30;
  else if (history.totalVisits <= 3) risk += 20;
  else if (history.totalVisits <= 5) risk += 10;

  // Monetary: lower spend = higher risk
  if (history.totalSpent === 0) risk += 20;
  else if (history.totalSpent < 5000) risk += 10;

  // Loyalty engagement reduces risk
  if (history.loyaltyPoints && history.loyaltyPoints > 0) risk -= 10;

  return Math.max(0, Math.min(100, risk));
}

/**
 * Calculate simple customer lifetime value.
 * Average spend per visit * estimated remaining visits.
 */
export function calculateCLV(history: CustomerHistory): number {
  if (!history.isReturning || history.totalVisits === 0) return 0;

  const avgSpendPerVisit = history.totalSpent / history.totalVisits;
  const churnRisk = calculateChurnRisk(history);
  const retentionProbability = (100 - churnRisk) / 100;

  // Estimate 12 more visits over next year, weighted by retention probability
  const estimatedFutureVisits = 12 * retentionProbability;
  return Math.round(avgSpendPerVisit * estimatedFutureVisits);
}
