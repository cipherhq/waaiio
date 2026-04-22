import type { SupabaseClient } from '@supabase/supabase-js';

export interface Recommendation {
  id: string;
  title: string;
  description: string;
  impact: 'high' | 'medium' | 'low';
  category: 'revenue' | 'retention' | 'operations' | 'growth';
  actionLabel: string | null;
  actionPath: string | null;
  metric: string | null;
}

/**
 * Generate actionable recommendations for a business based on their data.
 * Each recommendation includes a suggested action the business can take.
 */
export async function generateRecommendations(
  supabase: SupabaseClient,
  businessId: string,
): Promise<Recommendation[]> {
  const recommendations: Recommendation[] = [];
  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();

  try {
    const [bookingsRes, paymentsRes, customersRes, noShowsRes, feedbackRes, sessionsRes] = await Promise.all([
      supabase.from('bookings').select('id, status, total_amount, deposit_amount, deposit_status, date, time')
        .eq('business_id', businessId).gte('date', thirtyDaysAgo.split('T')[0]),
      supabase.from('payments').select('id, status, amount')
        .eq('business_id', businessId).gte('created_at', thirtyDaysAgo),
      supabase.from('customer_profiles').select('id, total_visits, last_seen_at, churn_risk, customer_segment')
        .eq('business_id', businessId),
      supabase.from('bookings').select('id')
        .eq('business_id', businessId).eq('status', 'no_show').gte('date', thirtyDaysAgo.split('T')[0]),
      supabase.from('customer_feedback').select('rating')
        .eq('business_id', businessId).gte('created_at', thirtyDaysAgo),
      supabase.from('bot_sessions').select('id, is_active, session_data')
        .eq('business_id', businessId).gte('created_at', sevenDaysAgo),
    ]);

    const bookings = bookingsRes.data || [];
    const payments = paymentsRes.data || [];
    const customers = customersRes.data || [];
    const noShows = noShowsRes.data || [];
    const feedback = feedbackRes.data || [];
    const sessions = sessionsRes.data || [];

    // ── No-show problem ──
    if (noShows.length > 0 && bookings.length > 0) {
      const noShowRate = Math.round((noShows.length / bookings.length) * 100);
      if (noShowRate >= 10) {
        const lostRevenue = bookings
          .filter(b => b.status === 'no_show')
          .reduce((sum, b) => sum + (b.total_amount || 0), 0);
        const hasDeposits = bookings.some(b => b.deposit_amount && b.deposit_amount > 0);

        recommendations.push({
          id: 'reduce-no-shows',
          title: hasDeposits ? 'Increase deposit amounts to reduce no-shows' : 'Enable deposits to reduce no-shows',
          description: `${noShowRate}% no-show rate this month (${noShows.length} missed). That's approximately ${lostRevenue.toLocaleString()} in lost revenue. ${hasDeposits ? 'Consider raising deposit amounts.' : 'Requiring a deposit reduces no-shows by up to 60%.'}`,
          impact: noShowRate >= 20 ? 'high' : 'medium',
          category: 'revenue',
          actionLabel: 'Manage Services',
          actionPath: '/dashboard/services',
          metric: `${noShowRate}% no-show rate`,
        });
      }
    }

    // ── At-risk customers ──
    const atRiskCustomers = customers.filter(c => c.customer_segment === 'at_risk' || c.churn_risk > 50);
    if (atRiskCustomers.length >= 3) {
      recommendations.push({
        id: 'win-back-customers',
        title: `${atRiskCustomers.length} customers at risk of churning`,
        description: `These customers haven't visited in 30+ days. Send a win-back message with a special offer to bring them back.`,
        impact: atRiskCustomers.length >= 10 ? 'high' : 'medium',
        category: 'retention',
        actionLabel: 'Send Broadcast',
        actionPath: '/dashboard/broadcasts',
        metric: `${atRiskCustomers.length} at-risk`,
      });
    }

    // ── Churned customers ──
    const churnedCustomers = customers.filter(c => c.customer_segment === 'churned');
    if (churnedCustomers.length >= 5) {
      recommendations.push({
        id: 'churned-customers',
        title: `${churnedCustomers.length} customers have churned`,
        description: `These customers haven't returned in 90+ days. A targeted re-engagement campaign could recover some of them.`,
        impact: 'medium',
        category: 'retention',
        actionLabel: 'Create Sequence',
        actionPath: '/dashboard/sequences',
        metric: `${churnedCustomers.length} churned`,
      });
    }

    // ── Payment failures ──
    const failedPayments = payments.filter(p => p.status === 'failed');
    if (failedPayments.length > 0 && payments.length > 0) {
      const failRate = Math.round((failedPayments.length / payments.length) * 100);
      if (failRate >= 5) {
        const lostAmount = failedPayments.reduce((sum, p) => sum + (p.amount || 0), 0);
        recommendations.push({
          id: 'payment-failures',
          title: `${failRate}% payment failure rate`,
          description: `${failedPayments.length} payments failed this month (${lostAmount.toLocaleString()} total). Check your payment gateway settings or contact support.`,
          impact: failRate >= 15 ? 'high' : 'medium',
          category: 'revenue',
          actionLabel: 'View Alerts',
          actionPath: '/dashboard/financials',
          metric: `${failedPayments.length} failed`,
        });
      }
    }

    // ── Low ratings ──
    if (feedback.length >= 5) {
      const avgRating = feedback.reduce((sum, f) => sum + (f.rating || 0), 0) / feedback.length;
      if (avgRating < 4.0) {
        const lowRatings = feedback.filter(f => f.rating <= 2).length;
        recommendations.push({
          id: 'improve-ratings',
          title: `Average rating is ${avgRating.toFixed(1)} stars`,
          description: `${lowRatings} customers gave 1-2 star ratings this month. Review the feedback to identify issues.`,
          impact: avgRating < 3.0 ? 'high' : 'medium',
          category: 'operations',
          actionLabel: 'View Feedback',
          actionPath: '/dashboard/feedback',
          metric: `${avgRating.toFixed(1)} avg`,
        });
      }
    }

    // ── Empty time slots ──
    if (bookings.length >= 10) {
      const hourCounts = new Map<number, number>();
      for (const b of bookings) {
        if (b.time) {
          const hour = parseInt(b.time.split(':')[0]);
          hourCounts.set(hour, (hourCounts.get(hour) || 0) + 1);
        }
      }
      // Find hours with zero or very low bookings (9am-8pm business hours)
      const emptyHours: number[] = [];
      for (let h = 9; h <= 20; h++) {
        if ((hourCounts.get(h) || 0) <= 1) emptyHours.push(h);
      }
      if (emptyHours.length >= 3) {
        const emptyStr = emptyHours.slice(0, 3).map(h => `${h > 12 ? h - 12 : h}${h >= 12 ? 'PM' : 'AM'}`).join(', ');
        recommendations.push({
          id: 'fill-empty-slots',
          title: 'Fill empty time slots with promotions',
          description: `Low bookings at ${emptyStr}. Create a time-based discount to fill these slots.`,
          impact: 'medium',
          category: 'revenue',
          actionLabel: 'Create Promo',
          actionPath: '/dashboard/promo-codes',
          metric: `${emptyHours.length} quiet hours`,
        });
      }
    }

    // ── Loyalty not enabled ──
    if (customers.length >= 10) {
      const { count: loyaltyCount } = await supabase
        .from('loyalty_points')
        .select('id', { count: 'exact', head: true })
        .eq('business_id', businessId);

      if (!loyaltyCount || loyaltyCount === 0) {
        recommendations.push({
          id: 'enable-loyalty',
          title: 'Start a loyalty program',
          description: `You have ${customers.length} customers but no loyalty program. Loyalty programs increase repeat visits by 25%.`,
          impact: 'medium',
          category: 'growth',
          actionLabel: 'Set Up Loyalty',
          actionPath: '/dashboard/loyalty',
          metric: `${customers.length} customers`,
        });
      }
    }

    // ── Bot escalation rate ──
    if (sessions.length >= 10) {
      const escalated = sessions.filter(s => {
        const data = s.session_data as Record<string, unknown> | null;
        return data?.escalated_to_human === true;
      });
      const escalationRate = Math.round((escalated.length / sessions.length) * 100);
      if (escalationRate >= 20) {
        recommendations.push({
          id: 'reduce-escalation',
          title: `${escalationRate}% of bot conversations need human help`,
          description: `${escalated.length} of ${sessions.length} conversations this week were escalated. Review your bot keywords and FAQ to handle common questions automatically.`,
          impact: escalationRate >= 40 ? 'high' : 'medium',
          category: 'operations',
          actionLabel: 'Manage Bot',
          actionPath: '/dashboard/whatsapp',
          metric: `${escalationRate}% escalated`,
        });
      }
    }

    // Sort by impact
    const impactOrder = { high: 0, medium: 1, low: 2 };
    recommendations.sort((a, b) => impactOrder[a.impact] - impactOrder[b.impact]);

    return recommendations;
  } catch {
    return recommendations;
  }
}
