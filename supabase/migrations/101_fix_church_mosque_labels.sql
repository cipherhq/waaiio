-- Fix church/mosque category_templates: labels, flow_type, greeting, default_capabilities
-- The giving capability now has its own dedicated page, so services page should show "Appointments"

UPDATE category_templates
SET
  flow_type = 'scheduling',
  default_greeting = 'Welcome to {{name}}! 🙏 We''re glad you''re here. How can we serve you today?',
  default_capabilities = '["giving", "scheduling", "ticketing", "feedback", "chat"]'::jsonb,
  labels = '{
    "actionVerb": "Book",
    "entityName": "appointment",
    "personLabel": "Member",
    "serviceName": "Appointment",
    "receiptTitle": "Appointment Confirmed",
    "quantityLabel": "guests",
    "hiddenStatuses": ["no_show"],
    "defaultHasPrice": true,
    "namePlaceholder": "e.g. Counseling Session, Meeting with Pastor, Prayer Request",
    "entityNamePlural": "appointments",
    "confirmationEmoji": "⛪",
    "personLabelPlural": "Members",
    "serviceNamePlural": "Appointments"
  }'::jsonb
WHERE key = 'church';

UPDATE category_templates
SET
  flow_type = 'scheduling',
  default_greeting = 'Assalamu Alaikum! Welcome to {{name}}. 🕌 How can we help you today?',
  default_capabilities = '["giving", "scheduling", "ticketing", "feedback", "chat"]'::jsonb,
  labels = '{
    "actionVerb": "Book",
    "entityName": "appointment",
    "personLabel": "Member",
    "serviceName": "Appointment",
    "receiptTitle": "Appointment Confirmed",
    "quantityLabel": "guests",
    "hiddenStatuses": ["no_show"],
    "defaultHasPrice": true,
    "namePlaceholder": "e.g. Counseling, Nikah Consultation, Quran Class",
    "entityNamePlural": "appointments",
    "confirmationEmoji": "🕌",
    "personLabelPlural": "Members",
    "serviceNamePlural": "Appointments"
  }'::jsonb
WHERE key = 'mosque';
