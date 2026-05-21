-- Add indexes on unindexed foreign key columns for query performance.
-- These are the ~30 most critical FKs on high-traffic tables.
-- Using CREATE INDEX (not CONCURRENTLY — Supabase Management API doesn't support it in transactions).

-- ══ bookings (7 missing) ══
CREATE INDEX IF NOT EXISTS idx_bookings_service_id ON bookings(service_id);
CREATE INDEX IF NOT EXISTS idx_bookings_staff_id ON bookings(staff_id);
CREATE INDEX IF NOT EXISTS idx_bookings_payment_id ON bookings(payment_id);
CREATE INDEX IF NOT EXISTS idx_bookings_promo_code_id ON bookings(promo_code_id);
CREATE INDEX IF NOT EXISTS idx_bookings_appointment_id ON bookings(appointment_id);
CREATE INDEX IF NOT EXISTS idx_bookings_location_id ON bookings(location_id);
CREATE INDEX IF NOT EXISTS idx_bookings_checked_in_by ON bookings(checked_in_by);

-- ══ payments (4 missing) ══
CREATE INDEX IF NOT EXISTS idx_payments_user_id ON payments(user_id);
CREATE INDEX IF NOT EXISTS idx_payments_invoice_id ON payments(invoice_id);
CREATE INDEX IF NOT EXISTS idx_payments_reservation_id ON payments(reservation_id);
CREATE INDEX IF NOT EXISTS idx_payments_campaign_id ON payments(campaign_id);

-- ══ orders (5 missing) ══
CREATE INDEX IF NOT EXISTS idx_orders_payment_id ON orders(payment_id);
CREATE INDEX IF NOT EXISTS idx_orders_promo_code_id ON orders(promo_code_id);
CREATE INDEX IF NOT EXISTS idx_orders_delivery_zone_id ON orders(delivery_zone_id);
CREATE INDEX IF NOT EXISTS idx_orders_location_id ON orders(location_id);
CREATE INDEX IF NOT EXISTS idx_orders_quote_request_id ON orders(quote_request_id);

-- ══ order_items (2 missing) ══
CREATE INDEX IF NOT EXISTS idx_order_items_product_id ON order_items(product_id);
CREATE INDEX IF NOT EXISTS idx_order_items_variant_id ON order_items(variant_id);

-- ══ platform_fees (5 missing) ══
CREATE INDEX IF NOT EXISTS idx_platform_fees_booking_id ON platform_fees(booking_id);
CREATE INDEX IF NOT EXISTS idx_platform_fees_order_id ON platform_fees(order_id);
CREATE INDEX IF NOT EXISTS idx_platform_fees_invoice_id ON platform_fees(invoice_id);
CREATE INDEX IF NOT EXISTS idx_platform_fees_campaign_id ON platform_fees(campaign_id);
CREATE INDEX IF NOT EXISTS idx_platform_fees_reservation_id ON platform_fees(reservation_id);

-- ══ chat_messages (1 missing) ══
CREATE INDEX IF NOT EXISTS idx_chat_messages_conversation_id ON chat_messages(conversation_id);

-- ══ bot_sessions (1 missing) ══
CREATE INDEX IF NOT EXISTS idx_bot_sessions_user_id ON bot_sessions(user_id);

-- ══ customer_feedback (3 missing) ══
CREATE INDEX IF NOT EXISTS idx_customer_feedback_booking_id ON customer_feedback(booking_id);
CREATE INDEX IF NOT EXISTS idx_customer_feedback_order_id ON customer_feedback(order_id);
CREATE INDEX IF NOT EXISTS idx_customer_feedback_queue_entry_id ON customer_feedback(queue_entry_id);

-- ══ reservations (2 missing) ══
CREATE INDEX IF NOT EXISTS idx_reservations_payment_id ON reservations(payment_id);
CREATE INDEX IF NOT EXISTS idx_reservations_service_id ON reservations(service_id);

-- ══ event_tickets (2 missing) ══
CREATE INDEX IF NOT EXISTS idx_event_tickets_business_id ON event_tickets(business_id);
CREATE INDEX IF NOT EXISTS idx_event_tickets_ticket_type_id ON event_tickets(ticket_type_id);

-- ══ event_ticket_types (1 missing) ══
CREATE INDEX IF NOT EXISTS idx_event_ticket_types_event_id ON event_ticket_types(event_id);

-- ══ invoices (2 missing) ══
CREATE INDEX IF NOT EXISTS idx_invoices_customer_profile_id ON invoices(customer_profile_id);
CREATE INDEX IF NOT EXISTS idx_invoices_recurring_parent_id ON invoices(recurring_parent_id);

-- ══ refund_requests (2 missing) ══
CREATE INDEX IF NOT EXISTS idx_refund_requests_booking_id ON refund_requests(booking_id);
CREATE INDEX IF NOT EXISTS idx_refund_requests_payment_id ON refund_requests(payment_id);

-- ══ subscription_charges (3 missing) ══
CREATE INDEX IF NOT EXISTS idx_subscription_charges_booking_id ON subscription_charges(booking_id);
CREATE INDEX IF NOT EXISTS idx_subscription_charges_payment_id ON subscription_charges(payment_id);
CREATE INDEX IF NOT EXISTS idx_subscription_charges_user_id ON subscription_charges(user_id);
