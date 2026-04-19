-- ═══════════════════════════════════════════════════════
-- Migration 065: Queue as primary flow type + category capabilities
-- Adds 'queue' to flow_type enum
-- Adds default_capabilities JSONB column to category_templates
-- ═══════════════════════════════════════════════════════

-- 1. Add 'queue' to the flow_type enum
ALTER TYPE flow_type ADD VALUE IF NOT EXISTS 'queue';

-- 2. Add default_capabilities column to category_templates
ALTER TABLE public.category_templates
  ADD COLUMN IF NOT EXISTS default_capabilities JSONB DEFAULT NULL;

-- 3. Seed default_capabilities for all categories
UPDATE public.category_templates SET default_capabilities = '["scheduling","feedback","loyalty","chat","waitlist","referral","staff"]' WHERE key = 'restaurant';
UPDATE public.category_templates SET default_capabilities = '["scheduling","feedback","loyalty","chat","referral","staff"]' WHERE key = 'barber';
UPDATE public.category_templates SET default_capabilities = '["scheduling","feedback","loyalty","chat","waitlist","referral","staff"]' WHERE key = 'spa';
UPDATE public.category_templates SET default_capabilities = '["scheduling","feedback","loyalty","chat","referral","staff"]' WHERE key = 'salon';
UPDATE public.category_templates SET default_capabilities = '["scheduling","feedback","loyalty","chat","referral"]' WHERE key = 'gym';
UPDATE public.category_templates SET default_capabilities = '["scheduling","reports","queue","feedback","chat","waitlist","staff"]' WHERE key = 'clinic';
UPDATE public.category_templates SET default_capabilities = '["scheduling","feedback","chat","referral"]' WHERE key = 'consultant';
UPDATE public.category_templates SET default_capabilities = '["payment","feedback","chat"]' WHERE key = 'church';
UPDATE public.category_templates SET default_capabilities = '["payment","feedback","chat"]' WHERE key = 'mosque';
UPDATE public.category_templates SET default_capabilities = '["payment","feedback","chat"]' WHERE key = 'school';
UPDATE public.category_templates SET default_capabilities = '["payment","feedback","chat","referral"]' WHERE key = 'ngo';
UPDATE public.category_templates SET default_capabilities = '["ordering","feedback","loyalty","chat","referral"]' WHERE key = 'shop';
UPDATE public.category_templates SET default_capabilities = '["ordering","feedback","loyalty","referral"]' WHERE key = 'food_delivery';
UPDATE public.category_templates SET default_capabilities = '["ticketing","feedback","waitlist","referral"]' WHERE key = 'events';
UPDATE public.category_templates SET default_capabilities = '["ticketing","feedback"]' WHERE key = 'transport';
UPDATE public.category_templates SET default_capabilities = '["ticketing","feedback","waitlist","loyalty"]' WHERE key = 'cinema';
UPDATE public.category_templates SET default_capabilities = '["payment","feedback"]' WHERE key = 'car_park';
UPDATE public.category_templates SET default_capabilities = '["scheduling","payment","feedback","loyalty","chat","staff"]' WHERE key = 'tattoo';
UPDATE public.category_templates SET default_capabilities = '["scheduling","payment","whatsapp_sign","feedback","chat","referral"]' WHERE key = 'real_estate';
UPDATE public.category_templates SET default_capabilities = '["scheduling","payment","ticketing","feedback","chat","referral"]' WHERE key = 'travel_agency';
UPDATE public.category_templates SET default_capabilities = '["ordering","payment","feedback","chat"]' WHERE key = 'logistics';
UPDATE public.category_templates SET default_capabilities = '["payment","feedback","referral"]' WHERE key = 'taxi';
UPDATE public.category_templates SET default_capabilities = '["payment","feedback"]' WHERE key = 'government';
UPDATE public.category_templates SET default_capabilities = '["ordering","feedback","loyalty","chat","referral"]' WHERE key = 'instagram_vendor';
UPDATE public.category_templates SET default_capabilities = '["crowdfunding","payment","referral"]' WHERE key = 'crowdfunding_org';
UPDATE public.category_templates SET default_capabilities = '["scheduling","ordering","feedback","loyalty","chat","referral"]' WHERE key = 'laundry';
UPDATE public.category_templates SET default_capabilities = '["scheduling","payment","reports","feedback","chat","waitlist","staff"]' WHERE key = 'veterinary';
UPDATE public.category_templates SET default_capabilities = '["scheduling","payment","reminders","reports","queue","feedback","chat","waitlist","staff"]' WHERE key = 'dental';
UPDATE public.category_templates SET default_capabilities = '["scheduling","payment","feedback","loyalty","chat","referral"]' WHERE key = 'coworking';
UPDATE public.category_templates SET default_capabilities = '["scheduling","payment","feedback","chat","referral"]' WHERE key = 'tutor';
UPDATE public.category_templates SET default_capabilities = '["scheduling","payment","feedback","chat","referral","staff"]' WHERE key = 'photographer';
UPDATE public.category_templates SET default_capabilities = '["payment","ordering","feedback","loyalty","chat"]' WHERE key = 'mall_vendor';
UPDATE public.category_templates SET default_capabilities = '["ordering","payment","feedback","loyalty","chat"]' WHERE key = 'pharmacy';
UPDATE public.category_templates SET default_capabilities = '["scheduling","payment","feedback","loyalty","chat","waitlist","referral","staff"]' WHERE key = 'hotel';
UPDATE public.category_templates SET default_capabilities = '["scheduling","payment","feedback","loyalty","chat","referral"]' WHERE key = 'car_wash';
UPDATE public.category_templates SET default_capabilities = '["ordering","payment","feedback","chat","referral"]' WHERE key = 'catering';
UPDATE public.category_templates SET default_capabilities = '["payment","scheduling","feedback","chat"]' WHERE key = 'funeral';
UPDATE public.category_templates SET default_capabilities = '["ordering","scheduling","payment","feedback","loyalty","chat"]' WHERE key = 'tailor';
UPDATE public.category_templates SET default_capabilities = '["reservation","payment","feedback","chat"]' WHERE key = 'shortlet';
UPDATE public.category_templates SET default_capabilities = '["scheduling","feedback","chat"]' WHERE key = 'other';

-- 4. Backfill labels for categories that might have additional fields
-- (serviceName, serviceNamePlural, namePlaceholder, defaultHasPrice)
-- These fields exist in CATEGORY_LABELS in constants.ts but may be missing from the DB labels JSONB
UPDATE public.category_templates SET labels = labels || '{"serviceName":"Service","serviceNamePlural":"Services","namePlaceholder":"e.g. Table Reservation, Private Dining","defaultHasPrice":true}' WHERE key = 'restaurant' AND NOT (labels ? 'serviceName');
UPDATE public.category_templates SET labels = labels || '{"serviceName":"Service","serviceNamePlural":"Services","namePlaceholder":"e.g. Haircut, Beard Trim","defaultHasPrice":true}' WHERE key = 'barber' AND NOT (labels ? 'serviceName');
UPDATE public.category_templates SET labels = labels || '{"serviceName":"Service","serviceNamePlural":"Services","namePlaceholder":"e.g. Full Body Massage, Facial","defaultHasPrice":true}' WHERE key = 'spa' AND NOT (labels ? 'serviceName');
UPDATE public.category_templates SET labels = labels || '{"serviceName":"Service","serviceNamePlural":"Services","namePlaceholder":"e.g. Haircut & Styling, Braiding","defaultHasPrice":true}' WHERE key = 'salon' AND NOT (labels ? 'serviceName');
UPDATE public.category_templates SET labels = labels || '{"serviceName":"Service","serviceNamePlural":"Services","namePlaceholder":"e.g. Personal Training, Group Class","defaultHasPrice":true}' WHERE key = 'gym' AND NOT (labels ? 'serviceName');
UPDATE public.category_templates SET labels = labels || '{"serviceName":"Service","serviceNamePlural":"Services","namePlaceholder":"e.g. Consultation, Check-up","defaultHasPrice":true}' WHERE key = 'clinic' AND NOT (labels ? 'serviceName');
UPDATE public.category_templates SET labels = labels || '{"serviceName":"Service","serviceNamePlural":"Services","namePlaceholder":"e.g. Strategy Session, Advisory","defaultHasPrice":true}' WHERE key = 'consultant' AND NOT (labels ? 'serviceName');
UPDATE public.category_templates SET labels = labels || '{"serviceName":"Giving Category","serviceNamePlural":"Giving Categories","namePlaceholder":"e.g. Tithe, Offering, Building Fund","defaultHasPrice":false}' WHERE key = 'church' AND NOT (labels ? 'serviceName');
UPDATE public.category_templates SET labels = labels || '{"serviceName":"Offering","serviceNamePlural":"Offerings","namePlaceholder":"e.g. Zakat, Sadaqah, Fitrah","defaultHasPrice":false}' WHERE key = 'mosque' AND NOT (labels ? 'serviceName');
UPDATE public.category_templates SET labels = labels || '{"serviceName":"Fee Category","serviceNamePlural":"Fee Categories","namePlaceholder":"e.g. School Fees, PTA Dues, Exam Fees","defaultHasPrice":false}' WHERE key = 'school' AND NOT (labels ? 'serviceName');
UPDATE public.category_templates SET labels = labels || '{"serviceName":"Program","serviceNamePlural":"Programs","namePlaceholder":"e.g. Education Fund, Community Outreach","defaultHasPrice":false}' WHERE key = 'ngo' AND NOT (labels ? 'serviceName');
UPDATE public.category_templates SET labels = labels || '{"serviceName":"Product","serviceNamePlural":"Products","namePlaceholder":"e.g. T-Shirt, Gift Box","defaultHasPrice":true}' WHERE key = 'shop' AND NOT (labels ? 'serviceName');
UPDATE public.category_templates SET labels = labels || '{"serviceName":"Menu Item","serviceNamePlural":"Menu Items","namePlaceholder":"e.g. Jollof Rice, Shawarma","defaultHasPrice":true}' WHERE key = 'food_delivery' AND NOT (labels ? 'serviceName');
UPDATE public.category_templates SET labels = labels || '{"serviceName":"Event","serviceNamePlural":"Events","namePlaceholder":"e.g. Concert, Workshop","defaultHasPrice":true}' WHERE key = 'events' AND NOT (labels ? 'serviceName');
UPDATE public.category_templates SET labels = labels || '{"serviceName":"Service","serviceNamePlural":"Services","namePlaceholder":"e.g. Lagos–Abuja, Express Route","defaultHasPrice":true}' WHERE key = 'transport' AND NOT (labels ? 'serviceName');
UPDATE public.category_templates SET labels = labels || '{"serviceName":"Service","serviceNamePlural":"Services","namePlaceholder":"e.g. Regular, VIP, IMAX","defaultHasPrice":true}' WHERE key = 'cinema' AND NOT (labels ? 'serviceName');
UPDATE public.category_templates SET labels = labels || '{"serviceName":"Service","serviceNamePlural":"Services","namePlaceholder":"e.g. Hourly Parking, Monthly Pass","defaultHasPrice":true}' WHERE key = 'car_park' AND NOT (labels ? 'serviceName');
UPDATE public.category_templates SET labels = labels || '{"serviceName":"Service","serviceNamePlural":"Services","namePlaceholder":"e.g. Small Tattoo, Cover-up","defaultHasPrice":true}' WHERE key = 'tattoo' AND NOT (labels ? 'serviceName');
UPDATE public.category_templates SET labels = labels || '{"serviceName":"Service","serviceNamePlural":"Services","namePlaceholder":"e.g. Property Viewing, Consultation","defaultHasPrice":true}' WHERE key = 'real_estate' AND NOT (labels ? 'serviceName');
UPDATE public.category_templates SET labels = labels || '{"serviceName":"Service","serviceNamePlural":"Services","namePlaceholder":"e.g. Travel Consultation, Visa Assist","defaultHasPrice":true}' WHERE key = 'travel_agency' AND NOT (labels ? 'serviceName');
UPDATE public.category_templates SET labels = labels || '{"serviceName":"Service","serviceNamePlural":"Services","namePlaceholder":"e.g. Same-day Delivery, Interstate","defaultHasPrice":true}' WHERE key = 'logistics' AND NOT (labels ? 'serviceName');
UPDATE public.category_templates SET labels = labels || '{"serviceName":"Service","serviceNamePlural":"Services","namePlaceholder":"e.g. City Ride, Airport Transfer","defaultHasPrice":false}' WHERE key = 'taxi' AND NOT (labels ? 'serviceName');
UPDATE public.category_templates SET labels = labels || '{"serviceName":"Service","serviceNamePlural":"Services","namePlaceholder":"e.g. Utility Bill, Application Fee","defaultHasPrice":false}' WHERE key = 'government' AND NOT (labels ? 'serviceName');
UPDATE public.category_templates SET labels = labels || '{"serviceName":"Product","serviceNamePlural":"Products","namePlaceholder":"e.g. Custom Order, Bundle Deal","defaultHasPrice":true}' WHERE key = 'instagram_vendor' AND NOT (labels ? 'serviceName');
UPDATE public.category_templates SET labels = labels || '{"serviceName":"Campaign","serviceNamePlural":"Campaigns","namePlaceholder":"e.g. Medical Fund, Community Project","defaultHasPrice":false}' WHERE key = 'crowdfunding_org' AND NOT (labels ? 'serviceName');
UPDATE public.category_templates SET labels = labels || '{"serviceName":"Service","serviceNamePlural":"Services","namePlaceholder":"e.g. Wash & Fold, Dry Cleaning","defaultHasPrice":true}' WHERE key = 'laundry' AND NOT (labels ? 'serviceName');
UPDATE public.category_templates SET labels = labels || '{"serviceName":"Service","serviceNamePlural":"Services","namePlaceholder":"e.g. Consultation, Vaccination","defaultHasPrice":true}' WHERE key = 'veterinary' AND NOT (labels ? 'serviceName');
UPDATE public.category_templates SET labels = labels || '{"serviceName":"Service","serviceNamePlural":"Services","namePlaceholder":"e.g. Check-up, Cleaning, Filling","defaultHasPrice":true}' WHERE key = 'dental' AND NOT (labels ? 'serviceName');
UPDATE public.category_templates SET labels = labels || '{"serviceName":"Service","serviceNamePlural":"Services","namePlaceholder":"e.g. Hot Desk, Private Office","defaultHasPrice":true}' WHERE key = 'coworking' AND NOT (labels ? 'serviceName');
UPDATE public.category_templates SET labels = labels || '{"serviceName":"Service","serviceNamePlural":"Services","namePlaceholder":"e.g. Private Lesson, Group Session","defaultHasPrice":true}' WHERE key = 'tutor' AND NOT (labels ? 'serviceName');
UPDATE public.category_templates SET labels = labels || '{"serviceName":"Service","serviceNamePlural":"Services","namePlaceholder":"e.g. Portrait Session, Event Coverage","defaultHasPrice":true}' WHERE key = 'photographer' AND NOT (labels ? 'serviceName');
UPDATE public.category_templates SET labels = labels || '{"serviceName":"Product","serviceNamePlural":"Products","namePlaceholder":"e.g. Perfume, Accessories","defaultHasPrice":true}' WHERE key = 'mall_vendor' AND NOT (labels ? 'serviceName');
UPDATE public.category_templates SET labels = labels || '{"serviceName":"Product","serviceNamePlural":"Products","namePlaceholder":"e.g. Prescription, OTC Medicine","defaultHasPrice":true}' WHERE key = 'pharmacy' AND NOT (labels ? 'serviceName');
UPDATE public.category_templates SET labels = labels || '{"serviceName":"Service","serviceNamePlural":"Services","namePlaceholder":"e.g. Standard Room, Deluxe Suite","defaultHasPrice":true}' WHERE key = 'hotel' AND NOT (labels ? 'serviceName');
UPDATE public.category_templates SET labels = labels || '{"serviceName":"Apartment","serviceNamePlural":"Apartments","namePlaceholder":"e.g. Studio Apartment, 2-Bed Flat","defaultHasPrice":true}' WHERE key = 'shortlet' AND NOT (labels ? 'serviceName');
UPDATE public.category_templates SET labels = labels || '{"serviceName":"Service","serviceNamePlural":"Services","namePlaceholder":"e.g. Basic Wash, Full Detail","defaultHasPrice":true}' WHERE key = 'car_wash' AND NOT (labels ? 'serviceName');
UPDATE public.category_templates SET labels = labels || '{"serviceName":"Service","serviceNamePlural":"Services","namePlaceholder":"e.g. Party Package, Corporate Lunch","defaultHasPrice":true}' WHERE key = 'catering' AND NOT (labels ? 'serviceName');
UPDATE public.category_templates SET labels = labels || '{"serviceName":"Service","serviceNamePlural":"Services","namePlaceholder":"e.g. Service Fee, Memorial Contribution","defaultHasPrice":false}' WHERE key = 'funeral' AND NOT (labels ? 'serviceName');
UPDATE public.category_templates SET labels = labels || '{"serviceName":"Service","serviceNamePlural":"Services","namePlaceholder":"e.g. Custom Suit, Alteration","defaultHasPrice":true}' WHERE key = 'tailor' AND NOT (labels ? 'serviceName');
UPDATE public.category_templates SET labels = labels || '{"serviceName":"Service","serviceNamePlural":"Services","namePlaceholder":"e.g. General Booking","defaultHasPrice":true}' WHERE key = 'other' AND NOT (labels ? 'serviceName');
