'use client';

import { useEffect, useState } from 'react';
import { useBusiness } from '@/components/dashboard/DashboardProvider';
import { createClient } from '@/lib/supabase/client';
import { APP_NAME } from '@/lib/constants';

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
  const [config, setConfig] = useState<WhatsAppConfig | null>(null);
  const [loading, setLoading] = useState(true);
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
            <div className="mt-3 flex items-center gap-3">
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

          {/* Bot Settings */}
          {config && (
            <div className="rounded-xl border border-gray-100 bg-white p-6">
              <h2 className="text-sm font-semibold text-gray-900">Bot Settings</h2>

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
                          updated[i] = { ...btn, action: e.target.value as WelcomeButton['action'] };
                          setWelcomeButtons(updated);
                        }}
                        className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand"
                      >
                        <option value="start_flow">Start Flow</option>
                        <option value="quick_reply">Quick Reply</option>
                        <option value="url">Send URL</option>
                      </select>
                    </div>
                    {btn.action !== 'start_flow' && (
                      <div>
                        <label className="mb-1 block text-xs font-medium text-gray-500">
                          {btn.action === 'quick_reply' ? 'Reply Trigger' : 'URL'}
                        </label>
                        <input
                          type="text"
                          value={btn.payload || ''}
                          onChange={(e) => {
                            const updated = [...welcomeButtons];
                            updated[i] = { ...btn, payload: e.target.value };
                            setWelcomeButtons(updated);
                          }}
                          placeholder={btn.action === 'quick_reply' ? 'hours' : 'https://...'}
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

      {/* Message Templates Section */}
      <div className="mt-8">
        <div className="rounded-xl border border-gray-100 bg-white p-6">
          <h2 className="text-lg font-bold text-gray-900">Message Templates</h2>
          <p className="mt-0.5 text-sm text-gray-500">Customize the messages your bot sends at key moments</p>

          <div className="mt-2 flex flex-wrap gap-1.5">
            {['{business_name}', '{customer_name}', '{date}', '{time}', '{reference_code}', '{amount}', '{service_name}', '{quantity}', '{status}'].map(v => (
              <button
                key={v}
                onClick={() => navigator.clipboard.writeText(v)}
                className="rounded-full bg-gray-100 px-2.5 py-1 text-xs font-medium text-gray-600 hover:bg-gray-200"
                title="Click to copy"
              >
                {v}
              </button>
            ))}
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
