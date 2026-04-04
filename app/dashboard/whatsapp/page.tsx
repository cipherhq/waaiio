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

interface WhatsAppConfig {
  id: string;
  bot_greeting: string;
  bot_alias: string | null;
  auto_confirm: boolean;
  welcome_image_url: string | null;
  bot_confirmation_template: string;
  bot_reminder_template: string;
  quick_replies: QuickReply[];
}

export default function WhatsAppPage() {
  const business = useBusiness();
  const [config, setConfig] = useState<WhatsAppConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savingReplies, setSavingReplies] = useState(false);
  const [form, setForm] = useState({
    bot_greeting: '',
    bot_alias: '',
    auto_confirm: true,
  });
  const [quickReplies, setQuickReplies] = useState<QuickReply[]>([]);
  const [editingReply, setEditingReply] = useState<QuickReply | null>(null);
  const [isNewReply, setIsNewReply] = useState(false);

  const whatsappNumber = process.env.NEXT_PUBLIC_WHATSAPP_NUMBER_NG || process.env.NEXT_PUBLIC_GUPSHUP_WHATSAPP_NUMBER || '';
  const whatsappLink = business.bot_code
    ? `https://wa.me/${whatsappNumber}?text=${encodeURIComponent(business.bot_code)}`
    : '';

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
        });
        setQuickReplies((data.quick_replies as QuickReply[]) || []);
      }
      setLoading(false);
    }
    load();
  }, [business.id]);

  async function handleSave() {
    setSaving(true);
    const supabase = createClient();
    await supabase
      .from('whatsapp_config')
      .update({
        bot_greeting: form.bot_greeting,
        bot_alias: form.bot_alias || null,
        auto_confirm: form.auto_confirm,
      })
      .eq('business_id', business.id);
    setSaving(false);
  }

  async function handleSaveReplies(replies: QuickReply[]) {
    setSavingReplies(true);
    const supabase = createClient();
    await supabase
      .from('whatsapp_config')
      .update({ quick_replies: replies })
      .eq('business_id', business.id);
    setQuickReplies(replies);
    setSavingReplies(false);
  }

  function handleAddReply() {
    setIsNewReply(true);
    setEditingReply({ trigger: '', label: '', response: '' });
  }

  function handleSaveReply() {
    if (!editingReply) return;
    let updated: QuickReply[];
    if (isNewReply) {
      updated = [...quickReplies, editingReply];
    } else {
      updated = quickReplies.map((r) =>
        r.trigger === editingReply.trigger ? editingReply : r
      );
    }
    handleSaveReplies(updated);
    setEditingReply(null);
    setIsNewReply(false);
  }

  function handleDeleteReply(trigger: string) {
    handleSaveReplies(quickReplies.filter((r) => r.trigger !== trigger));
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

      {/* Quick Replies Section */}
      <div className="mt-8">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-bold text-gray-900">Quick Replies</h2>
            <p className="mt-0.5 text-sm text-gray-500">
              Canned responses the bot sends when customers ask common questions
            </p>
          </div>
          <button
            onClick={handleAddReply}
            className="rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white hover:bg-brand-600"
          >
            + Add Reply
          </button>
        </div>

        {/* Edit/Add Reply Form */}
        {editingReply && (
          <div className="mt-4 rounded-xl border border-brand/20 bg-brand-50/30 p-5">
            <h3 className="text-sm font-semibold text-gray-900">
              {isNewReply ? 'New Quick Reply' : 'Edit Quick Reply'}
            </h3>
            <div className="mt-3 space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1 block text-sm font-medium text-gray-700">Trigger Word</label>
                  <input
                    type="text"
                    value={editingReply.trigger}
                    onChange={(e) => setEditingReply({ ...editingReply, trigger: e.target.value.toLowerCase().replace(/\s+/g, '_') })}
                    placeholder="e.g. hours, location, menu"
                    className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand"
                  />
                  <p className="mt-1 text-xs text-gray-400">Keyword the bot matches in messages</p>
                </div>
                <div>
                  <label className="mb-1 block text-sm font-medium text-gray-700">Button Label</label>
                  <input
                    type="text"
                    value={editingReply.label}
                    onChange={(e) => setEditingReply({ ...editingReply, label: e.target.value })}
                    placeholder="e.g. Business Hours, Our Location"
                    className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand"
                  />
                </div>
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">Response</label>
                <textarea
                  value={editingReply.response}
                  onChange={(e) => setEditingReply({ ...editingReply, response: e.target.value })}
                  rows={3}
                  placeholder="The message the bot sends back..."
                  className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand"
                />
              </div>
              <div className="flex gap-3">
                <button
                  onClick={handleSaveReply}
                  disabled={!editingReply.trigger.trim() || !editingReply.response.trim()}
                  className="rounded-lg bg-brand px-5 py-2 text-sm font-semibold text-white hover:bg-brand-600 disabled:opacity-50"
                >
                  {isNewReply ? 'Add' : 'Save'}
                </button>
                <button
                  onClick={() => { setEditingReply(null); setIsNewReply(false); }}
                  className="rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-50"
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Quick Replies List */}
        {quickReplies.length === 0 && !editingReply ? (
          <div className="mt-6 rounded-xl border border-dashed border-gray-200 p-8 text-center">
            <p className="text-sm text-gray-500">No quick replies yet. Add common questions like business hours, location, or pricing.</p>
          </div>
        ) : (
          <div className="mt-4 space-y-2">
            {quickReplies.map((reply) => (
              <div key={reply.trigger} className="flex items-start justify-between rounded-xl border border-gray-100 bg-white p-4">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <code className="rounded bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-700">{reply.trigger}</code>
                    <span className="text-sm font-medium text-gray-900">{reply.label}</span>
                  </div>
                  <p className="mt-1 text-sm text-gray-500 line-clamp-2">{reply.response}</p>
                </div>
                <div className="flex shrink-0 gap-1 pl-4">
                  <button
                    onClick={() => { setEditingReply(reply); setIsNewReply(false); }}
                    className="rounded-lg p-2 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
                  >
                    <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                    </svg>
                  </button>
                  <button
                    onClick={() => handleDeleteReply(reply.trigger)}
                    className="rounded-lg p-2 text-gray-400 hover:bg-red-50 hover:text-red-500"
                  >
                    <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                    </svg>
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
