-- Fix: Add ticketing to church and mosque default_capabilities in category_templates.
-- The DB-backed defaults were missing ticketing, causing the bot to not show "Buy Tickets".

UPDATE public.category_templates
SET default_capabilities = '["payment","ticketing","feedback","chat"]'
WHERE key = 'church';

UPDATE public.category_templates
SET default_capabilities = '["payment","ticketing","feedback","chat"]'
WHERE key = 'mosque';
