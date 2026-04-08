-- Add serviceName / serviceNamePlural to category_templates labels JSONB
-- These control what "Services" is called in the dashboard per business category

UPDATE category_templates SET labels = labels || '{"serviceName": "Giving Category", "serviceNamePlural": "Giving Categories"}'::jsonb WHERE key = 'church';
UPDATE category_templates SET labels = labels || '{"serviceName": "Offering", "serviceNamePlural": "Offerings"}'::jsonb WHERE key = 'mosque';
UPDATE category_templates SET labels = labels || '{"serviceName": "Campaign", "serviceNamePlural": "Campaigns"}'::jsonb WHERE key = 'crowdfunding_org';
UPDATE category_templates SET labels = labels || '{"serviceName": "Program", "serviceNamePlural": "Programs"}'::jsonb WHERE key = 'ngo';
UPDATE category_templates SET labels = labels || '{"serviceName": "Fee Category", "serviceNamePlural": "Fee Categories"}'::jsonb WHERE key = 'school';
UPDATE category_templates SET labels = labels || '{"serviceName": "Product", "serviceNamePlural": "Products"}'::jsonb WHERE key = 'shop';
UPDATE category_templates SET labels = labels || '{"serviceName": "Menu Item", "serviceNamePlural": "Menu Items"}'::jsonb WHERE key = 'food_delivery';
UPDATE category_templates SET labels = labels || '{"serviceName": "Event", "serviceNamePlural": "Events"}'::jsonb WHERE key = 'events';
UPDATE category_templates SET labels = labels || '{"serviceName": "Product", "serviceNamePlural": "Products"}'::jsonb WHERE key = 'instagram_vendor';
UPDATE category_templates SET labels = labels || '{"serviceName": "Product", "serviceNamePlural": "Products"}'::jsonb WHERE key = 'mall_vendor';
UPDATE category_templates SET labels = labels || '{"serviceName": "Product", "serviceNamePlural": "Products"}'::jsonb WHERE key = 'pharmacy';
-- All others default to "Service" / "Services" via constants.ts fallback
