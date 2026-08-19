import { NextResponse, type NextRequest } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { verifyCronAuth } from '@/lib/cron-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  const authError = verifyCronAuth(request);
  if (authError) return authError;

  const supabase = createServiceClient();

  // ── 1. Expire stale pending bookings older than 48 hours ──
  const staleDate = new Date();
  staleDate.setHours(staleDate.getHours() - 48);

  // First, fetch stale pending bookings (before cancelling) to restore tickets
  const { data: staleBookings } = await supabase
    .from('bookings')
    .select('id, event_id, quantity, flow_type')
    .eq('status', 'pending')
    .lt('created_at', staleDate.toISOString());

  // Cancel them
  const { data: expiredBookings } = await supabase
    .from('bookings')
    .update({ status: 'cancelled' })
    .eq('status', 'pending')
    .lt('created_at', staleDate.toISOString())
    .select('id');

  // Atomically restore tickets_sold for stale ticketing bookings
  let ticketsRestored = 0;
  if (staleBookings && staleBookings.length > 0) {
    for (const booking of staleBookings) {
      if (booking.flow_type === 'ticketing' && booking.event_id && booking.quantity) {
        await supabase.rpc('restore_tickets_sold', {
          p_event_id: booking.event_id,
          qty: booking.quantity,
        });
        ticketsRestored += booking.quantity;
      }
    }
  }

  // ── 1b. Cancel stale pending orders older than 48 hours (atomic per-order) ──
  // Uses cancel_stale_order_atomic RPC which:
  //   - Locks order, verifies still pending + stale + no successful payment
  //   - Restores stock ONLY if canonical stock marker exists
  //   - Cancels order atomically (crash-safe, concurrent-safe)
  const { data: staleOrders } = await supabase
    .from('orders')
    .select('id')
    .eq('status', 'pending')
    .lt('created_at', staleDate.toISOString());

  let ordersCancelled = 0;
  let ordersStockRestored = 0;
  if (staleOrders && staleOrders.length > 0) {
    for (const order of staleOrders) {
      const { data: result, error } = await supabase.rpc('cancel_stale_order_atomic', {
        p_order_id: order.id,
      });

      if (error) {
        // Log but continue — other orders may still be cleanable
        console.error(`[CLEANUP] cancel_stale_order_atomic error for ${order.id}:`, error.message);
        continue;
      }

      if (result?.cancelled) {
        ordersCancelled++;
        if (result.stock_restored) ordersStockRestored++;
      }
    }
  }

  // ── 2. Clean up old processed webhook events (older than 30 days) ──
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  const { data: deletedEvents } = await supabase
    .from('processed_webhook_events')
    .delete()
    .lt('processed_at', thirtyDaysAgo.toISOString())
    .select('id');

  // ── 3. Clean up expired sessions/conversation states older than 7 days ──
  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

  const { data: deletedSessions } = await supabase
    .from('conversation_states')
    .delete()
    .lt('updated_at', sevenDaysAgo.toISOString())
    .select('id');

  return NextResponse.json({
    ok: true,
    expiredBookings: expiredBookings?.length || 0,
    ticketsRestored,
    ordersCancelled,
    ordersStockRestored,
    deletedWebhookEvents: deletedEvents?.length || 0,
    deletedStaleSessions: deletedSessions?.length || 0,
  });
}
