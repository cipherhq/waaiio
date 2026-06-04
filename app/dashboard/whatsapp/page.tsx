'use client';

import { useEffect, useState, useCallback } from 'react';
import { useBusiness, useCapabilities } from '@/components/dashboard/DashboardProvider';
import { createClient } from '@/lib/supabase/client';
import { APP_NAME } from '@/lib/constants';
import { CAPABILITIES, type CapabilityId } from '@/lib/capabilities/types';
import { getCapabilityLabel } from '@/lib/capabilities/labels';

const CAP_MAP = new Map(CAPABILITIES.map(c => [c.id, c]));

// Non-user-facing capabilities — these NEVER appear in the bot menu.
// Must match the nonUserFacing set in capability-selection.flow.ts skipIf().
const NON_USER_FACING: Set<CapabilityId> = new Set([
  'reminders', 'feedback', 'loyalty', 'referral', 'reports', 'staff',
  'whatsapp_sign', 'survey', 'poll', 'broadcast', 'recurring', 'auto_reply',
  'membership', 'estimates', 'packages', 'class_booking', 'multi_location',
]);

// Warning messages for capabilities that need backing data before appearing in the bot
const DATA_REQUIREMENT_LABELS: Partial<Record<CapabilityId, string>> = {
  scheduling: 'No services set up',
  appointment: 'No appointments set up',
  ordering: 'No products set up',
  ticketing: 'No published events',
  reservation: 'No properties set up',
  table_reservation: 'No services set up',
  giving: 'No giving categories set up',
  crowdfunding: 'No active campaigns',
};

interface QuickReply {
  trigger: string;
  label: string;
  response: string;
}

interface WelcomeButton {
  label: string;
  action: 'start_flow' | 'quick_reply' | 'url';
  payload?: string;
}

interface WhatsAppConfig {
  id: string;
  bot_greeting: string;
  bot_alias: string | null;
  auto_confirm: boolean;
  welcome_image_url: string | null;
  bot_confirmation_template: string;
  bot_reminder_template: string;
  bot_order_confirmation_template: string | null;
  bot_payment_receipt_template: string | null;
  bot_order_status_template: string | null;
  quick_replies: QuickReply[];
  welcome_buttons: WelcomeButton[];
  default_reply: string | null;
}

export default function WhatsAppPage() {
  const business = useBusiness();
  const { capabilities } = useCapabilities();
  const [config, setConfig] = useState<WhatsAppConfig | null>(null);
  const [loading, setLoading] = useState(true);

  // Bot Menu Order state
  const [orderedCaps, setOrderedCaps] = useState<CapabilityId[]>(capabilities);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const [savingOrder, setSavingOrder] = useState(false);
  // Custom labels: capabilityId -> custom label text (empty string = use default)
  const [customLabels, setCustomLabels] = useState<Record<string, string>>({});
  const [savingLabel, setSavingLabel] = useState<string | null>(null);
  // Backing-data map: which capabilities have actual data behind them
  const [backingData, setBackingData] = useState<Record<string, boolean>>({});
  const [backingDataLoaded, setBackingDataLoaded] = useState(false);

  useEffect(() => { setOrderedCaps(capabilities); }, [capabilities]);

  // Load custom labels from DB
  useEffect(() => {
    async function loadCustomLabels() {
      const supabase = createClient();
      const { data } = await supabase
        .from('business_capabilities')
        .select('capability, custom_label')
        .eq('business_id', business.id)
        .eq('is_enabled', true);
      if (data) {
        const labels: Record<string, string> = {};
        for (const row of data) {
          if (row.custom_label) labels[row.capability] = row.custom_label;
        }
        setCustomLabels(labels);
      }
    }
    loadCustomLabels();
  }, [business.id]);

  // Load backing data counts — mirrors the checks in capability-selection.flow.ts skipIf()
  useEffect(() => {
    async function loadBackingData() {
      const supabase = createClient();
      const bid = business.id;
      const [
        { count: servicesCount },
        { count: givingServicesCount },
        { count: appointmentsCount },
        { count: productsCount },
        { count: eventsCount },
        { count: propertiesCount },
        { count: campaignsCount },
      ] = await Promise.all([
        // scheduling + table_reservation: non-giving services
        supabase.from('services').select('id', { count: 'exact', head: true })
          .eq('business_id', bid).eq('is_active', true).neq('service_type', 'giving').is('deleted_at', null),
        // giving: services with service_type='giving'
        supabase.from('services').select('id', { count: 'exact', head: true })
          .eq('business_id', bid).eq('is_active', true).eq('service_type', 'giving').is('deleted_at', null),
        // appointment
        supabase.from('appointments').select('id', { count: 'exact', head: true })
          .eq('business_id', bid).eq('is_active', true),
        // ordering
        supabase.from('products').select('id', { count: 'exact', head: true })
          .eq('business_id', bid).eq('is_active', true).is('deleted_at', null),
        // ticketing: published events
        supabase.from('events').select('id', { count: 'exact', head: true })
          .eq('business_id', bid).eq('status', 'published'),
        // reservation
        supabase.from('properties').select('id', { count: 'exact', head: true })
          .eq('business_id', bid).eq('is_active', true),
        // crowdfunding: active campaigns
        supabase.from('campaigns').select('id', { count: 'exact', head: true })
          .eq('business_id', bid).eq('status', 'active'),
      ]);

      setBackingData({
        scheduling: (servicesCount || 0) > 0,
        table_reservation: (servicesCount || 0) > 0,
        giving: (givingServicesCount || 0) > 0,
        appointment: (appointmentsCount || 0) > 0,
        ordering: (productsCount || 0) > 0,
        ticketing: (eventsCount || 0) > 0,
        reservation: (propertiesCount || 0) > 0,
        crowdfunding: (campaignsCount || 0) > 0,
        // These are always shown when enabled (no backing data needed)
        chat: true,
        queue: true,
        payment: true,
      });
      setBackingDataLoaded(true);
    }
    loadBackingData();
  }, [business.id]);

  // Save a custom label on blur
  const handleSaveCustomLabel = useCallback(async (capId: CapabilityId, value: string) => {
    const defaultLabel = getCapabilityLabel(capId, business.category || 'other');
    const trimmed = value.trim();
    // If empty or same as default, clear custom label
    const newCustomLabel = (!trimmed || trimmed === defaultLabel) ? null : trimmed;

    setSavingLabel(capId);
    const supabase = createClient();
    await supabase
      .from('business_capabilities')
      .update({ custom_label: newCustomLabel })
      .eq('business_id', business.id)
      .eq('capability', capId);

    setCustomLabels(prev => {
      const next = { ...prev };
      if (newCustomLabel) {
        next[capId] = newCustomLabel;
      } else {
        delete next[capId];
      }
      return next;
    });
    setSavingLabel(null);
  }, [business.id, business.category]);

  const handleDragStart = useCallback((e: React.DragEvent, index: number) => {
    setDragIndex(index);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(index));
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent, index: number) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDragOverIndex(index);
  }, []);

  const handleDrop = useCallback(async (e: React.DragEvent, dropIndex: number) => {
    e.preventDefault();
    const fromIndex = dragIndex;
    setDragIndex(null);
    setDragOverIndex(null);
    if (fromIndex === null || fromIndex === dropIndex) return;

    const newOrder = [...orderedCaps];
    const [moved] = newOrder.splice(fromIndex, 1);
    newOrder.splice(dropIndex, 0, moved);
    setOrderedCaps(newOrder);

    setSavingOrder(true);
    const supabase = createClient();
    try {
      await Promise.all(
        newOrder.map((cap, i) =>
          supabase.from('business_capabilities').update({ sort_order: i }).eq('business_id', business.id).eq('capability', cap),
        ),
      );
    } catch { /* silent */ }
    setSavingOrder(false);
  }, [dragIndex, orderedCaps, business.id]);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [buttonsError, setButtonsError] = useState<string | null>(null);
  const [templatesError, setTemplatesError] = useState<string | null>(null);
  const [form, setForm] = useState({
    bot_greeting: '',
    bot_alias: '',
    auto_confirm: true,
    default_reply: '',
  });
  const [welcomeButtons, setWelcomeButtons] = useState<WelcomeButton[]>([]);
  const [templates, setTemplates] = useState({
    bot_confirmation_template: '',
    bot_reminder_template: '',
    bot_order_confirmation_template: '',
    bot_payment_receipt_template: '',
    bot_order_status_template: '',
  });
  const [followupMessage, setFollowupMessage] = useState('');
  const [followupDelayHours, setFollowupDelayHours] = useState(24);
  const [savingTemplates, setSavingTemplates] = useState(false);
  const [savingButtons, setSavingButtons] = useState(false);
  const [expandedTemplate, setExpandedTemplate] = useState<string | null>(null);

  const [whatsappLink, setWhatsappLink] = useState('');

  // Load correct WhatsApp number from DB (not hardcoded env var)
  useEffect(() => {
    async function loadWhatsAppLink() {
      const supabase = createClient();
      const channelId = business.assigned_channel_id || business.whatsapp_channel_id;

      // 1. Check assigned/linked channel
      if (channelId) {
        const { data: ch } = await supabase
          .from('whatsapp_channels')
          .select('phone_number')
          .eq('id', channelId)
          .maybeSingle();
        if (ch?.phone_number) {
          const num = ch.phone_number.replace(/[^0-9]/g, '');
          setWhatsappLink(`https://wa.me/${num}`);
          return;
        }
      }

      // 2. Check dedicated channel
      const { data: dedicated } = await supabase
        .from('whatsapp_channels')
        .select('phone_number')
        .eq('business_id', business.id)
        .eq('channel_type', 'dedicated')
        .eq('is_active', true)
        .maybeSingle();
      if (dedicated?.phone_number) {
        const num = dedicated.phone_number.replace(/[^0-9]/g, '');
        setWhatsappLink(`https://wa.me/${num}`);
        return;
      }

      // 3. Shared channel — use bot code
      const { data: shared } = await supabase
        .from('whatsapp_channels')
        .select('phone_number')
        .eq('channel_type', 'shared')
        .eq('is_active', true)
        .limit(1)
        .maybeSingle();
      const num = shared?.phone_number?.replace(/[^0-9]/g, '') || '';
      if (num && business.bot_code) {
        setWhatsappLink(`https://wa.me/${num}?text=${encodeURIComponent(business.bot_code)}`);
      } else if (num) {
        setWhatsappLink(`https://wa.me/${num}`);
      }
    }
    loadWhatsAppLink();
  }, [business.id, business.assigned_channel_id, business.whatsapp_channel_id, business.bot_code]);

  useEffect(() => {
    async function load() {
      const supabase = createClient();
      const { data } = await supabase
        .from('whatsapp_config')
        .select('*')
        .eq('business_id', business.id)
        .single();

      if (data) {
        setConfig(data as WhatsAppConfig);
        setForm({
          bot_greeting: data.bot_greeting || '',
          bot_alias: data.bot_alias || '',
          auto_confirm: data.auto_confirm ?? true,
          default_reply: data.default_reply || '',
        });
        setWelcomeButtons((data.welcome_buttons as WelcomeButton[]) || []);
        setTemplates({
          bot_confirmation_template: data.bot_confirmation_template || '',
          bot_reminder_template: data.bot_reminder_template || '',
          bot_order_confirmation_template: data.bot_order_confirmation_template || '',
          bot_payment_receipt_template: data.bot_payment_receipt_template || '',
          bot_order_status_template: data.bot_order_status_template || '',
        });
        setFollowupMessage(data.followup_message || '');
        setFollowupDelayHours(data.followup_delay_hours ?? 24);
      }
      setLoading(false);
    }
    load();
  }, [business.id]);

  async function handleSave() {
    setSaving(true);
    setSaveError(null);
    const supabase = createClient();
    const { error } = await supabase
      .from('whatsapp_config')
      .update({
        bot_greeting: form.bot_greeting,
        bot_alias: form.bot_alias || null,
        auto_confirm: form.auto_confirm,
        default_reply: form.default_reply || null,
      })
      .eq('business_id', business.id);
    if (error) setSaveError('Failed to save settings. Please try again.');
    setSaving(false);
  }

  async function handleSaveButtons() {
    setSavingButtons(true);
    setButtonsError(null);
    const supabase = createClient();
    const { error } = await supabase
      .from('whatsapp_config')
      .update({ welcome_buttons: welcomeButtons })
      .eq('business_id', business.id);
    if (error) setButtonsError('Failed to save buttons. Please try again.');
    setSavingButtons(false);
  }

  async function handleSaveTemplates() {
    setSavingTemplates(true);
    setTemplatesError(null);
    const supabase = createClient();
    const { error } = await supabase
      .from('whatsapp_config')
      .update({
        bot_confirmation_template: templates.bot_confirmation_template || null,
        bot_reminder_template: templates.bot_reminder_template || null,
        bot_order_confirmation_template: templates.bot_order_confirmation_template || null,
        bot_payment_receipt_template: templates.bot_payment_receipt_template || null,
        bot_order_status_template: templates.bot_order_status_template || null,
        followup_message: followupMessage.trim() || null,
        followup_delay_hours: followupDelayHours,
      })
      .eq('business_id', business.id);
    if (error) setTemplatesError('Failed to save templates. Please try again.');
    setSavingTemplates(false);
  }

  if (loading) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-brand border-t-transparent" />
      </div>
    );
  }

  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-900">WhatsApp Bot</h1>
      <p className="mt-1 text-sm text-gray-500">Configure your {APP_NAME} WhatsApp assistant</p>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        {/* Left: Config */}
        <div className="space-y-6">
          {/* Bot Code & Link */}
          <div className="rounded-xl border border-gray-100 bg-white p-6">
            <h2 className="text-sm font-semibold text-gray-900">Your Bot Code</h2>
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <code className="rounded-lg bg-brand-50 px-4 py-2 text-lg font-bold text-brand">
                {business.bot_code || 'Not set'}
              </code>
            </div>
            {whatsappLink && (
              <div className="mt-4">
                <p className="text-xs text-gray-500">WhatsApp Link</p>
                <a
                  href={whatsappLink}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-1 block truncate text-sm text-brand hover:underline"
                >
                  {whatsappLink}
                </a>
                <button
                  onClick={() => navigator.clipboard.writeText(whatsappLink)}
                  className="mt-2 rounded-lg bg-whatsapp px-4 py-2 text-sm font-medium text-white hover:bg-green-600"
                >
                  Copy Link
                </button>
              </div>
            )}
          </div>

          {/* WhatsApp Settings */}
          {config && (
            <div className="rounded-xl border border-gray-100 bg-white p-6">
              <h2 className="text-sm font-semibold text-gray-900">WhatsApp Settings</h2>

              <div className="mt-4 space-y-4">
                <div>
                  <label className="mb-1 block text-sm font-medium text-gray-700">Bot Name / Alias</label>
                  <input
                    type="text"
                    value={form.bot_alias}
                    onChange={(e) => setForm({ ...form, bot_alias: e.target.value })}
                    placeholder={business.name}
                    className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand"
                  />
                  <p className="mt-1 text-xs text-gray-400">Leave empty to use your business name</p>
                </div>

                <div>
                  <label className="mb-1 block text-sm font-medium text-gray-700">Welcome Greeting</label>
                  <textarea
                    value={form.bot_greeting}
                    onChange={(e) => setForm({ ...form, bot_greeting: e.target.value })}
                    rows={3}
                    className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand"
                  />
                </div>

                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium text-gray-700">Auto-confirm bookings</p>
                    <p className="text-xs text-gray-400">Automatically confirm new bookings</p>
                  </div>
                  <button
                    onClick={() => setForm({ ...form, auto_confirm: !form.auto_confirm })}
                    className={`relative h-6 w-11 rounded-full transition ${form.auto_confirm ? 'bg-brand' : 'bg-gray-200'}`}
                  >
                    <div className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition ${form.auto_confirm ? 'left-5.5' : 'left-0.5'}`}
                      style={{ left: form.auto_confirm ? '22px' : '2px' }}
                    />
                  </button>
                </div>

                <div>
                  <label className="mb-1 block text-sm font-medium text-gray-700">Default Reply</label>
                  <textarea
                    value={form.default_reply}
                    onChange={(e) => setForm({ ...form, default_reply: e.target.value })}
                    rows={2}
                    placeholder="I didn't understand that. Type *menu* to see options."
                    className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand"
                  />
                  <p className="mt-1 text-xs text-gray-400">Sent when the bot doesn&apos;t understand a message</p>
                </div>

                {saveError && (
                  <p className="text-sm text-red-600">{saveError}</p>
                )}
                <button
                  onClick={handleSave}
                  disabled={saving}
                  className="w-full rounded-lg bg-brand px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-600 disabled:opacity-50"
                >
                  {saving ? 'Saving...' : 'Save Settings'}
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Right: Preview */}
        <div>
          <div className="rounded-xl border border-gray-100 bg-white p-6">
            <h2 className="text-sm font-semibold text-gray-900">Chat Preview</h2>
            <div className="mt-4 overflow-hidden rounded-2xl shadow-lg">
              {/* WhatsApp header */}
              <div className="flex items-center gap-3 px-4 py-3" style={{ backgroundColor: '#075E54' }}>
                <div className="flex h-9 w-9 items-center justify-center rounded-full bg-white/20 text-sm font-bold text-white">
                  {(form.bot_alias || business.name).charAt(0).toUpperCase()}
                </div>
                <div>
                  <p className="text-sm font-semibold text-white">{form.bot_alias || business.name}</p>
                  <p className="text-xs text-green-200">online</p>
                </div>
              </div>
              {/* Chat body */}
              <div className="space-y-3 p-4" style={{ backgroundColor: '#ECE5DD' }}>
                <div className="flex justify-start">
                  <div className="max-w-[85%] whitespace-pre-line rounded-lg bg-white px-3 py-2 text-sm text-gray-800">
                    {form.bot_greeting || `Welcome to ${business.name}! How can I help you today?`}
                  </div>
                </div>
                <div className="flex justify-end">
                  <div className="max-w-[85%] rounded-lg px-3 py-2 text-sm" style={{ backgroundColor: '#DCF8C6', color: '#111' }}>
                    I want to book
                  </div>
                </div>
                <div className="flex justify-start">
                  <div className="max-w-[85%] whitespace-pre-line rounded-lg bg-white px-3 py-2 text-sm text-gray-800">
                    Sure! When would you like to come? Please share the date, time and number of guests.
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Welcome Buttons Section */}
      <div className="mt-8">
        <div className="rounded-xl border border-gray-100 bg-white p-6">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-lg font-bold text-gray-900">Welcome Buttons</h2>
              <p className="mt-0.5 text-sm text-gray-500">Up to 3 buttons shown after the greeting message</p>
            </div>
            {welcomeButtons.length < 3 && (
              <button
                onClick={() => setWelcomeButtons([...welcomeButtons, { label: '', action: 'start_flow' }])}
                className="rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white hover:bg-brand-600"
              >
                + Add Button
              </button>
            )}
          </div>

          {welcomeButtons.length === 0 ? (
            <p className="mt-4 text-sm text-gray-400">No welcome buttons configured. The bot will send only the greeting text.</p>
          ) : (
            <div className="mt-4 space-y-3">
              {welcomeButtons.map((btn, i) => (
                <div key={i} className="flex items-start gap-3 rounded-lg border border-gray-100 bg-gray-50 p-3">
                  <div className="flex-1 grid grid-cols-1 sm:grid-cols-3 gap-3">
                    <div>
                      <label className="mb-1 block text-xs font-medium text-gray-500">Label</label>
                      <input
                        type="text"
                        value={btn.label}
                        onChange={(e) => {
                          const updated = [...welcomeButtons];
                          updated[i] = { ...btn, label: e.target.value.slice(0, 20) };
                          setWelcomeButtons(updated);
                        }}
                        placeholder="Book Now"
                        maxLength={20}
                        className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand"
                      />
                    </div>
                    <div>
                      <label className="mb-1 block text-xs font-medium text-gray-500">Action</label>
                      <select
                        value={btn.action}
                        onChange={(e) => {
                          const updated = [...welcomeButtons];
                          updated[i] = { ...btn, action: e.target.value as WelcomeButton['action'], payload: '' };
                          setWelcomeButtons(updated);
                        }}
                        className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand"
                      >
                        <option value="start_flow">Start a Feature</option>
                        <option value="quick_reply">Send a Message</option>
                        <option value="url">Open a Link</option>
                      </select>
                      <p className="mt-0.5 text-[10px] text-gray-400">
                        {btn.action === 'start_flow' ? 'Opens a bot feature directly' : btn.action === 'quick_reply' ? 'Sends text as the customer\'s message' : 'Opens a URL in the browser'}
                      </p>
                    </div>
                    {btn.action === 'start_flow' && (
                      <div>
                        <label className="mb-1 block text-xs font-medium text-gray-500">Feature</label>
                        <select
                          value={btn.payload || ''}
                          onChange={(e) => {
                            const updated = [...welcomeButtons];
                            updated[i] = { ...btn, payload: e.target.value };
                            setWelcomeButtons(updated);
                          }}
                          className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand"
                        >
                          <option value="">Select a feature...</option>
                          <option value="scheduling">Book a Service</option>
                          <option value="appointment">Book Appointment</option>
                          <option value="ordering">Order Products</option>
                          <option value="ticketing">Buy Tickets</option>
                          <option value="reservation">Make Reservation</option>
                          <option value="table_reservation">Reserve Table</option>
                          <option value="queue">Join Queue</option>
                          <option value="giving">Give / Donate</option>
                          <option value="invoice">My Invoices</option>
                          <option value="loyalty">My Rewards</option>
                          <option value="chat">Chat with Us</option>
                          <option value="my_account">My Account</option>
                        </select>
                      </div>
                    )}
                    {btn.action === 'quick_reply' && (
                      <div>
                        <label className="mb-1 block text-xs font-medium text-gray-500">Message Text</label>
                        <input
                          type="text"
                          value={btn.payload || ''}
                          onChange={(e) => {
                            const updated = [...welcomeButtons];
                            updated[i] = { ...btn, payload: e.target.value };
                            setWelcomeButtons(updated);
                          }}
                          placeholder="e.g. What are your hours?"
                          className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand"
                        />
                        <p className="mt-0.5 text-[10px] text-gray-400">When tapped, this text is sent as the customer&apos;s message. Set up an auto-reply keyword to respond.</p>
                      </div>
                    )}
                    {btn.action === 'url' && (
                      <div>
                        <label className="mb-1 block text-xs font-medium text-gray-500">URL</label>
                        <input
                          type="text"
                          value={btn.payload || ''}
                          onChange={(e) => {
                            const updated = [...welcomeButtons];
                            updated[i] = { ...btn, payload: e.target.value };
                            setWelcomeButtons(updated);
                          }}
                          placeholder="https://..."
                          className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand"
                        />
                      </div>
                    )}
                  </div>
                  <button
                    onClick={() => setWelcomeButtons(welcomeButtons.filter((_, j) => j !== i))}
                    className="mt-5 rounded-lg p-2 text-gray-400 hover:bg-red-50 hover:text-red-500"
                  >
                    <svg aria-hidden="true" className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </div>
              ))}
            </div>
          )}

          {welcomeButtons.length > 0 && (
            <div className="mt-4 rounded-lg bg-gray-50 p-4">
              <p className="text-xs font-medium text-gray-500 mb-2">Preview</p>
              <div className="bg-white rounded-lg p-3 shadow-sm border max-w-xs">
                <p className="text-sm text-gray-700 mb-2">{form.bot_greeting || `Welcome to ${business.name}! How can I help you today?`}</p>
                <div className="space-y-1.5">
                  {welcomeButtons.map((btn, i) => (
                    <div key={i} className="text-center rounded-lg border border-blue-200 bg-blue-50 px-3 py-1.5 text-sm text-blue-600 font-medium">
                      {btn.label || 'Untitled'}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {buttonsError && (
            <p className="mt-2 text-sm text-red-600">{buttonsError}</p>
          )}
          <button
            onClick={handleSaveButtons}
            disabled={savingButtons}
            className="mt-4 w-full rounded-lg bg-brand px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-600 disabled:opacity-50"
          >
            {savingButtons ? 'Saving...' : 'Save Buttons'}
          </button>
        </div>
      </div>

      {/* Bot Menu Order */}
      {(() => {
        // Replicate the bot's user-facing filter from capability-selection.flow.ts
        const nonUF = new Set(NON_USER_FACING);
        // Bot hides payment + invoice when scheduling is enabled (scheduling subsumes them)
        if (capabilities.includes('scheduling')) { nonUF.add('payment'); nonUF.add('invoice'); }
        const botMenuCaps = orderedCaps.filter(c => !nonUF.has(c));
        if (botMenuCaps.length <= 1) return null;
        return (
        <div className="mt-8">
          <div className="rounded-xl border border-gray-100 bg-white p-6">
            <h2 className="text-lg font-bold text-gray-900">Bot Menu Order</h2>
            <p className="mt-0.5 text-sm text-gray-500">
              Drag to reorder and rename how features appear in your WhatsApp bot menu.
              {savingOrder && <span className="ml-2 text-brand font-medium">Saving...</span>}
            </p>
            <div className="mt-4 space-y-1">
              {botMenuCaps.map((capId, index) => {
                const cap = CAP_MAP.get(capId);
                if (!cap) return null;
                const defaultLabel = getCapabilityLabel(capId, business.category || 'other');
                const hasCustom = !!customLabels[capId];
                const hasData = backingData[capId] !== false; // true or undefined (not yet loaded) = no warning
                const dataWarning = backingDataLoaded && !hasData ? DATA_REQUIREMENT_LABELS[capId] : null;
                return (
                  <div
                    key={capId}
                    draggable
                    onDragStart={e => handleDragStart(e, index)}
                    onDragOver={e => handleDragOver(e, index)}
                    onDragLeave={() => setDragOverIndex(null)}
                    onDrop={e => handleDrop(e, index)}
                    onDragEnd={() => { setDragIndex(null); setDragOverIndex(null); }}
                    className={`flex items-center gap-3 rounded-lg border px-4 py-3 cursor-grab active:cursor-grabbing select-none transition-all ${
                      dragIndex === index
                        ? 'opacity-40 border-brand bg-brand-50/50'
                        : dragOverIndex === index
                          ? 'border-brand border-2 bg-brand-50/30'
                          : dataWarning
                            ? 'border-amber-200 bg-amber-50/50 hover:border-amber-300'
                            : 'border-gray-200 bg-gray-50 hover:border-gray-300'
                    }`}
                  >
                    <span className="text-gray-400 text-lg font-bold">&#x2261;</span>
                    <span className="text-xs font-bold text-gray-400 w-5 text-center">{index + 1}.</span>
                    <div className="flex-1 min-w-0">
                      <input
                        type="text"
                        defaultValue={customLabels[capId] || defaultLabel}
                        onBlur={(e) => handleSaveCustomLabel(capId, e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                        onClick={(e) => e.stopPropagation()}
                        onDragStart={(e) => e.stopPropagation()}
                        draggable={false}
                        maxLength={24}
                        className="w-full rounded border border-transparent bg-transparent px-2 py-0.5 text-sm font-medium text-gray-900 outline-none hover:border-gray-300 focus:border-brand focus:bg-white"
                      />
                      {hasCustom && (
                        <p className="mt-0.5 pl-2 text-[10px] text-gray-400">Default: {defaultLabel}</p>
                      )}
                      {dataWarning && (
                        <p className="mt-0.5 pl-2 text-[10px] font-medium text-amber-600">
                          <span className="inline-block mr-0.5">&#x26A0;</span> {dataWarning} &mdash; hidden from bot until added
                        </p>
                      )}
                    </div>
                    <span className="text-lg">{cap.icon}</span>
                    {savingLabel === capId && (
                      <span className="text-xs text-brand">Saving...</span>
                    )}
                  </div>
                );
              })}

              {/* My Account — auto-added by the bot for returning customers */}
              <div className="flex items-center gap-3 rounded-lg border border-dashed border-gray-200 bg-gray-50/50 px-4 py-3 select-none">
                <span className="text-gray-300 text-lg font-bold">&#x2261;</span>
                <span className="text-xs font-bold text-gray-300 w-5 text-center">&bull;</span>
                <div className="flex-1 min-w-0">
                  <p className="px-2 py-0.5 text-sm font-medium text-gray-500">My Account</p>
                  <p className="mt-0.5 pl-2 text-[10px] text-gray-400">Auto-added for returning customers with past bookings or orders</p>
                </div>
                <span className="text-lg">&#x1F464;</span>
              </div>
            </div>
          </div>
        </div>
        );
      })()}

      {/* Message Templates Section */}
      <div className="mt-8">
        <div className="rounded-xl border border-gray-100 bg-white p-6">
          <h2 className="text-lg font-bold text-gray-900">Message Templates</h2>
          <p className="mt-0.5 text-sm text-gray-500">Customize the messages your bot sends at key moments</p>

          <div className="mt-3 rounded-lg bg-blue-50 px-4 py-3">
            <p className="text-xs font-medium text-blue-800 mb-2">💡 You can personalize messages using these smart tags — click to copy:</p>
            <div className="flex flex-wrap gap-1.5">
              {([
                { tag: '{business_name}', label: 'Your Business Name' },
                { tag: '{customer_name}', label: 'Customer Name' },
                { tag: '{date}', label: 'Booking Date' },
                { tag: '{time}', label: 'Booking Time' },
                { tag: '{reference_code}', label: 'Reference #' },
                { tag: '{amount}', label: 'Amount' },
                { tag: '{service_name}', label: 'Service/Product' },
                { tag: '{quantity}', label: 'Quantity' },
                { tag: '{status}', label: 'Status' },
              ]).map(v => (
                <button
                  key={v.tag}
                  onClick={() => { navigator.clipboard.writeText(v.tag); }}
                  className="group flex items-center gap-1 rounded-full bg-white border border-blue-200 px-2.5 py-1 text-xs font-medium text-blue-700 hover:bg-blue-100 transition"
                  title={`Inserts the ${v.label.toLowerCase()} automatically`}
                >
                  <span>{v.label}</span>
                  <svg aria-hidden="true" className="h-3 w-3 text-blue-400 opacity-0 group-hover:opacity-100 transition" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" /></svg>
                </button>
              ))}
            </div>
            <p className="mt-2 text-[10px] text-blue-600">Example: "Hi {'{customer_name}'}, your booking at {'{business_name}'} is confirmed for {'{date}'} at {'{time}'}."</p>
          </div>

          <div className="mt-4 space-y-2">
            {([
              { key: 'bot_confirmation_template', label: 'Booking Confirmation', desc: 'Sent after a booking is confirmed' },
              { key: 'bot_reminder_template', label: 'Booking Reminder', desc: 'Sent before the appointment' },
              { key: 'bot_order_confirmation_template', label: 'Order Confirmation', desc: 'Sent after an order is placed' },
              { key: 'bot_payment_receipt_template', label: 'Payment Receipt', desc: 'Sent after payment is received' },
              { key: 'bot_order_status_template', label: 'Order Status Update', desc: 'Sent when order status changes' },
            ] as const).map(tmpl => (
              <div key={tmpl.key} className="rounded-lg border border-gray-100">
                <button
                  onClick={() => setExpandedTemplate(expandedTemplate === tmpl.key ? null : tmpl.key)}
                  className="flex w-full items-center justify-between px-4 py-3 text-left"
                >
                  <div>
                    <p className="text-sm font-medium text-gray-900">{tmpl.label}</p>
                    <p className="text-xs text-gray-400">{tmpl.desc}</p>
                  </div>
                  <svg aria-hidden="true" className={`h-4 w-4 text-gray-400 transition ${expandedTemplate === tmpl.key ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                  </svg>
                </button>
                {expandedTemplate === tmpl.key && (
                  <div className="border-t border-gray-100 px-4 py-3">
                    <textarea
                      value={templates[tmpl.key]}
                      onChange={(e) => setTemplates({ ...templates, [tmpl.key]: e.target.value })}
                      rows={4}
                      placeholder="Leave empty to use the default template"
                      className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand"
                    />
                    {templates[tmpl.key] && (
                      <div className="mt-2">
                        <p className="text-xs font-medium text-gray-500">Preview:</p>
                        <div className="mt-1 whitespace-pre-line rounded-lg bg-gray-50 px-3 py-2 text-sm text-gray-700">
                          {templates[tmpl.key]
                            .replace(/\{business_name\}/g, business.name)
                            .replace(/\{customer_name\}/g, 'John')
                            .replace(/\{date\}/g, 'Mon 15 Apr')
                            .replace(/\{time\}/g, '10:00 AM')
                            .replace(/\{reference_code\}/g, 'BW-1234')
                            .replace(/\{amount\}/g, '5,000')
                            .replace(/\{service_name\}/g, 'Haircut')
                            .replace(/\{quantity\}/g, '2')
                            .replace(/\{status\}/g, 'Ready')}
                        </div>
                      </div>
                    )}
                    <button
                      onClick={() => setTemplates({ ...templates, [tmpl.key]: '' })}
                      className="mt-2 text-xs text-gray-400 hover:text-gray-600"
                    >
                      Reset to Default
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>

          {/* Follow-Up Message */}
          <div className="mt-4 rounded-lg border border-gray-100">
            <button
              onClick={() => setExpandedTemplate(expandedTemplate === 'followup' ? null : 'followup')}
              className="flex w-full items-center justify-between px-4 py-3 text-left"
            >
              <div>
                <p className="text-sm font-medium text-gray-900">Follow-Up Message</p>
                <p className="text-xs text-gray-400">Sent after the service is completed — ask for feedback or say thanks</p>
              </div>
              <svg aria-hidden="true" className={`h-4 w-4 text-gray-400 transition ${expandedTemplate === 'followup' ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </button>
            {expandedTemplate === 'followup' && (
              <div className="border-t border-gray-100 px-4 py-3">
                <textarea
                  value={followupMessage}
                  onChange={(e) => setFollowupMessage(e.target.value)}
                  rows={3}
                  placeholder="Thanks for visiting {business_name}, {customer_name}! How was your experience? We'd love your feedback."
                  className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand"
                />
                <div className="mt-3 flex items-center gap-3">
                  <label className="text-sm font-medium text-gray-700">Send after</label>
                  <select
                    value={followupDelayHours}
                    onChange={(e) => setFollowupDelayHours(Number(e.target.value))}
                    className="rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand"
                  >
                    <option value={2}>2 hours</option>
                    <option value={6}>6 hours</option>
                    <option value={12}>12 hours</option>
                    <option value={24}>24 hours (next day)</option>
                    <option value={48}>48 hours</option>
                    <option value={72}>3 days</option>
                  </select>
                  <span className="text-xs text-gray-400">after service date</span>
                </div>
                {followupMessage && (
                  <div className="mt-2">
                    <p className="text-xs font-medium text-gray-500">Preview:</p>
                    <div className="mt-1 whitespace-pre-line rounded-lg bg-gray-50 px-3 py-2 text-sm text-gray-700">
                      {(followupMessage || 'Thanks for visiting {business_name}, {customer_name}! How was your experience?')
                        .replace(/\{business_name\}/g, business.name)
                        .replace(/\{customer_name\}/g, 'John')
                        .replace(/\{service_name\}/g, 'Haircut')}
                    </div>
                  </div>
                )}
                <button
                  onClick={() => { setFollowupMessage(''); setFollowupDelayHours(24); }}
                  className="mt-2 text-xs text-gray-400 hover:text-gray-600"
                >
                  Reset to Default
                </button>
              </div>
            )}
          </div>

          {templatesError && (
            <p className="mt-2 text-sm text-red-600">{templatesError}</p>
          )}
          <button
            onClick={handleSaveTemplates}
            disabled={savingTemplates}
            className="mt-4 w-full rounded-lg bg-brand px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-600 disabled:opacity-50"
          >
            {savingTemplates ? 'Saving...' : 'Save Templates'}
          </button>
        </div>
      </div>

      {/* Quick Replies Migration Banner */}
      <div className="mt-8">
        <div className="rounded-xl border border-blue-100 bg-blue-50 p-5">
          <div className="flex items-start gap-3">
            <svg aria-hidden="true" className="mt-0.5 h-5 w-5 shrink-0 text-blue-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <div>
              <h3 className="text-sm font-semibold text-blue-900">Quick Replies moved to Keywords</h3>
              <p className="mt-1 text-sm text-blue-700">
                Quick replies have been migrated to the unified Keywords system. You can now manage all keyword triggers in one place with more powerful matching options.
              </p>
              <a
                href="/dashboard/keywords"
                className="mt-3 inline-flex items-center gap-1 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 transition"
              >
                Go to Keywords
                <svg aria-hidden="true" className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                </svg>
              </a>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
