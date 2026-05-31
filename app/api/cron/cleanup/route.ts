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

  // Decrement tickets_sold for stale ticketing bookings
  let ticketsRestored = 0;
  if (staleBookings && staleBookings.length > 0) {
    for (const booking of staleBookings) {
      if (booking.flow_type === 'ticketing' && booking.event_id && booking.quantity) {
        const { data: ev } = await supabase
          .from('events')
          .select('tickets_sold')
          .eq('id', booking.event_id)
          .single();
        if (ev) {
          const newSold = Math.max(0, (ev.tickets_sold || 0) - booking.quantity);
          await supabase
            .from('events')
            .update({ tickets_sold: newSold })
            .eq('id', booking.event_id);
          ticketsRestored += booking.quantity;
        }
      }
    }
  }

  // ── 1b. Restore stock for stale pending orders older than 48 hours ──
  const { data: staleOrders } = await supabase
    .from('orders')
    .select('id')
    .eq('status', 'pending')
    .lt('created_at', staleDate.toISOString());

  let ordersRestored = 0;
  if (staleOrders && staleOrders.length > 0) {
    for (const order of staleOrders) {
      // Get order items to restore stock
      const { data: items } = await supabase
        .from('order_items')
        .select('product_id, variant_id, quantity')
        .eq('order_id', order.id);

      if (items) {
        for (const item of items) {
          if (item.variant_id) {
            // Restore variant stock
            const { data: variant } = await supabase
              .from('product_variants')
              .select('stock_quantity')
              .eq('id', item.variant_id)
              .single();
            if (variant && variant.stock_quantity !== null) {
              await supabase
                .from('product_variants')
                .update({ stock_quantity: variant.stock_quantity + item.quantity })
                .eq('id', item.variant_id);
            }
          } else {
            // Restore product stock
            const { data: product } = await supabase
              .from('products')
              .select('stock_quantity')
              .eq('id', item.product_id)
              .single();
            if (product && product.stock_quantity !== null) {
              await supabase
                .from('products')
                .update({ stock_quantity: product.stock_quantity + item.quantity })
                .eq('id', item.product_id);
            }
          }
        }
      }

      ordersRestored++;
    }

    // Cancel the stale orders
    await supabase
      .from('orders')
      .update({ status: 'cancelled' })
      .eq('status', 'pending')
      .lt('created_at', staleDate.toISOString());
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
    ordersRestored,
    deletedWebhookEvents: deletedEvents?.length || 0,
    deletedStaleSessions: deletedSessions?.length || 0,
  });
}
