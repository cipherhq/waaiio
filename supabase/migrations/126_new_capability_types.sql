-- ════════════════════════════════════════════════════════
-- Migration 126: Add new capability types
-- broadcast, recurring, auto_reply, membership
-- ════════════════════════════════════════════════════════

-- Add new capability values to the enum (if it's an enum)
-- If capability_type is stored as text in business_capabilities, no schema change needed.
-- The capability IDs are just text values stored in business_capabilities.capability_id

-- Ensure the business_capabilities table can store the new IDs
-- (No schema change needed — capability_id is TEXT/VARCHAR)

-- Add comments for documentation
COMMENT ON TABLE business_capabilities IS 'Stores which capabilities are enabled per business. capability_id values include: scheduling, appointment, payment, ordering, ticketing, reservation, whatsapp_sign, reminders, crowdfunding, reports, queue, feedback, loyalty, chat, waitlist, referral, staff, invoice, survey, poll, giving, broadcast, recurring, auto_reply, membership';
