'use client';

import { useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import type { SettingsTabProps } from './types';

interface NotificationPref {
  whatsapp: boolean;
  email: boolean;
}

interface NotificationPreferences {
  new_booking: NotificationPref;
  payment_received: NotificationPref;
  booking_cancelled: NotificationPref;
  low_stock: NotificationPref;
  new_order: NotificationPref;
  refund_request: NotificationPref;
  new_inquiry: NotificationPref;
  new_ticket_sale: NotificationPref;
  new_donation: NotificationPref;
  new_invoice_payment: NotificationPref;
  new_queue_checkin: NotificationPref;
}

const NOTIFICATION_TYPES: Array<{
  key: keyof NotificationPreferences;
  label: string;
  description: string;
}> = [
  { key: 'new_booking', label: 'New Booking', description: 'When a customer makes a new booking or appointment' },
  { key: 'payment_received', label: 'Payment Received', description: 'When a payment is successfully completed' },
  { key: 'new_order', label: 'New Order', description: 'When a customer places an order' },
  { key: 'new_ticket_sale', label: 'Ticket Sale', description: 'When a ticket is purchased for your event' },
  { key: 'new_donation', label: 'New Donation', description: 'When someone makes a donation or offering' },
  { key: 'new_invoice_payment', label: 'Invoice Paid', description: 'When an invoice payment is received' },
  { key: 'booking_cancelled', label: 'Booking Cancelled', description: 'When a customer cancels a booking' },
  { key: 'low_stock', label: 'Low Stock Alert', description: 'When product stock falls below the threshold' },
  { key: 'refund_request', label: 'Refund Request', description: 'When a customer requests a refund' },
  { key: 'new_inquiry', label: 'New Inquiry', description: 'When a customer sends a message or inquiry' },
  { key: 'new_queue_checkin', label: 'Queue Check-in', description: 'When a customer checks into your queue' },
];

const DEFAULT_PREFERENCES: NotificationPreferences = {
  new_booking: { whatsapp: true, email: true },
  payment_received: { whatsapp: true, email: true },
  booking_cancelled: { whatsapp: true, email: true },
  low_stock: { whatsapp: true, email: true },
  new_order: { whatsapp: true, email: true },
  refund_request: { whatsapp: true, email: true },
  new_inquiry: { whatsapp: true, email: true },
  new_ticket_sale: { whatsapp: true, email: true },
  new_donation: { whatsapp: true, email: true },
  new_invoice_payment: { whatsapp: true, email: true },
  new_queue_checkin: { whatsapp: true, email: true },
};

export function NotificationsTab({ business, saving, setSaving, saved, setSaved, openSections, toggleSection }: SettingsTabProps) {
  const meta = (business.metadata || {}) as Record<string, unknown>;
  const existingPrefs = (meta.notification_preferences || {}) as Partial<NotificationPreferences>;

  // Merge existing with defaults
  const [preferences, setPreferences] = useState<NotificationPreferences>(() => {
    const merged = { ...DEFAULT_PREFERENCES };
    for (const key of Object.keys(merged) as Array<keyof NotificationPreferences>) {
      if (existingPrefs[key]) {
        merged[key] = {
          whatsapp: existingPrefs[key]?.whatsapp !== false,
          email: existingPrefs[key]?.email !== false,
        };
      }
    }
    return merged;
  });

  function togglePref(type: keyof NotificationPreferences, channel: 'whatsapp' | 'email') {
    setPreferences((prev) => ({
      ...prev,
      [type]: {
        ...prev[type],
        [channel]: !prev[type][channel],
      },
    }));
  }

  async function handleSave() {
    setSaving(true);
    const supabase = createClient();
    await supabase
      .from('businesses')
      .update({
        metadata: {
          ...meta,
          notification_preferences: preferences,
        },
      })
      .eq('id', business.id);
    setSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  return (
    <div className="mt-6 max-w-3xl space-y-4">
      <div>
        <button
          onClick={() => toggleSection('notification_preferences')}
          className="flex w-full items-center justify-between rounded-lg border border-gray-200 bg-white px-4 py-3.5 hover:bg-gray-50 transition shadow-sm cursor-pointer"
        >
          <h3 className="text-sm font-bold text-gray-900">Notification Preferences</h3>
          <svg
            aria-hidden="true"
            className={`h-5 w-5 text-brand transition-transform ${openSections.includes('notification_preferences') ? 'rotate-180' : ''}`}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </button>

        {openSections.includes('notification_preferences') && (
          <div className="mt-4">
            <div className="rounded-xl border border-gray-100 bg-white p-6">
              <h2 className="text-sm font-bold text-gray-900">Notification Preferences</h2>
              <p className="mt-1 text-xs text-gray-500">
                Choose which notifications you receive and how. Disabling a channel stops that notification type from being sent via that method.
              </p>

              {/* Header row */}
              <div className="mt-5 border-b border-gray-100 pb-2">
                <div className="grid grid-cols-[1fr_80px_80px] items-center gap-2">
                  <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
                    Notification
                  </div>
                  <div className="text-center text-xs font-semibold text-gray-500 uppercase tracking-wide">
                    WhatsApp
                  </div>
                  <div className="text-center text-xs font-semibold text-gray-500 uppercase tracking-wide">
                    Email
                  </div>
                </div>
              </div>

              {/* Toggle grid */}
              <div className="divide-y divide-gray-50">
                {NOTIFICATION_TYPES.map((notif) => (
                  <div
                    key={notif.key}
                    className="grid grid-cols-[1fr_80px_80px] items-center gap-2 py-3"
                  >
                    <div>
                      <p className="text-sm font-medium text-gray-900">{notif.label}</p>
                      <p className="text-xs text-gray-500">{notif.description}</p>
                    </div>
                    <div className="flex justify-center">
                      <button
                        type="button"
                        onClick={() => togglePref(notif.key, 'whatsapp')}
                        className={`relative h-6 w-11 shrink-0 rounded-full transition ${
                          preferences[notif.key].whatsapp ? 'bg-brand' : 'bg-gray-200'
                        }`}
                        aria-label={`${notif.label} WhatsApp ${preferences[notif.key].whatsapp ? 'enabled' : 'disabled'}`}
                      >
                        <div
                          className="absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-[left]"
                          style={{ left: preferences[notif.key].whatsapp ? '22px' : '2px' }}
                        />
                      </button>
                    </div>
                    <div className="flex justify-center">
                      <button
                        type="button"
                        onClick={() => togglePref(notif.key, 'email')}
                        className={`relative h-6 w-11 shrink-0 rounded-full transition ${
                          preferences[notif.key].email ? 'bg-brand' : 'bg-gray-200'
                        }`}
                        aria-label={`${notif.label} Email ${preferences[notif.key].email ? 'enabled' : 'disabled'}`}
                      >
                        <div
                          className="absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-[left]"
                          style={{ left: preferences[notif.key].email ? '22px' : '2px' }}
                        />
                      </button>
                    </div>
                  </div>
                ))}
              </div>

              {/* Info note */}
              <div className="mt-4 rounded-lg border border-blue-100 bg-blue-50 p-3">
                <p className="text-xs text-blue-700">
                  These preferences control owner/business notifications only. Customer-facing messages (booking confirmations, receipts) are always sent regardless of these settings.
                </p>
              </div>

              {/* Save button */}
              <button
                onClick={handleSave}
                disabled={saving}
                className="mt-5 rounded-lg bg-brand px-6 py-2.5 text-sm font-semibold text-white hover:bg-brand-600 disabled:opacity-50"
              >
                {saving ? 'Saving...' : saved ? 'Saved!' : 'Save Preferences'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
