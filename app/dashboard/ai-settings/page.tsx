'use client';

import { useState, useEffect, useCallback } from 'react';
import { useBusiness } from '@/components/dashboard/DashboardProvider';
import { createClient } from '@/lib/supabase/client';
import { PageHelp } from '@/components/dashboard/PageHelp';

interface AIConfig {
  id?: string;
  assistant_name: string;
  tone: string;
  ai_enabled: boolean;
  faq_enabled: boolean;
  knowledge_enabled: boolean;
  corrections_enabled: boolean;
  temporary_questions_enabled: boolean;
  auto_route_threshold: number;
  clarification_threshold: number;
  fallback_behavior: string;
}

const DEFAULTS: AIConfig = {
  assistant_name: 'Assistant',
  tone: 'friendly',
  ai_enabled: true,
  faq_enabled: true,
  knowledge_enabled: true,
  corrections_enabled: true,
  temporary_questions_enabled: true,
  auto_route_threshold: 0.85,
  clarification_threshold: 0.60,
  fallback_behavior: 'menu',
};

export default function AISettingsPage() {
  const business = useBusiness();
  const supabase = createClient();

  const [config, setConfig] = useState<AIConfig>(DEFAULTS);
  const [existingId, setExistingId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const loadConfig = useCallback(async () => {
    setLoading(true);
    const { data } = await supabase
      .from('ai_conversation_config')
      .select('*')
      .eq('business_id', business.id)
      .limit(1);

    if (data && data.length > 0) {
      const row = data[0];
      setExistingId(row.id);
      setConfig({
        assistant_name: row.assistant_name ?? DEFAULTS.assistant_name,
        tone: row.tone ?? DEFAULTS.tone,
        ai_enabled: row.ai_enabled ?? DEFAULTS.ai_enabled,
        faq_enabled: row.faq_enabled ?? DEFAULTS.faq_enabled,
        knowledge_enabled: row.knowledge_enabled ?? DEFAULTS.knowledge_enabled,
        corrections_enabled: row.corrections_enabled ?? DEFAULTS.corrections_enabled,
        temporary_questions_enabled: row.temporary_questions_enabled ?? DEFAULTS.temporary_questions_enabled,
        auto_route_threshold: Number(row.auto_route_threshold ?? DEFAULTS.auto_route_threshold),
        clarification_threshold: Number(row.clarification_threshold ?? DEFAULTS.clarification_threshold),
        fallback_behavior: row.fallback_behavior ?? DEFAULTS.fallback_behavior,
      });
    }
    setLoading(false);
  }, [business.id, supabase]);

  useEffect(() => {
    loadConfig();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [business.id]);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setSaved(false);

    const payload = {
      business_id: business.id,
      assistant_name: config.assistant_name,
      tone: config.tone,
      ai_enabled: config.ai_enabled,
      faq_enabled: config.faq_enabled,
      knowledge_enabled: config.knowledge_enabled,
      corrections_enabled: config.corrections_enabled,
      temporary_questions_enabled: config.temporary_questions_enabled,
      auto_route_threshold: config.auto_route_threshold,
      clarification_threshold: config.clarification_threshold,
      fallback_behavior: config.fallback_behavior,
      updated_at: new Date().toISOString(),
    };

    if (existingId) {
      await supabase.from('ai_conversation_config').update(payload).eq('id', existingId);
    } else {
      const { data } = await supabase.from('ai_conversation_config').insert(payload).select('id');
      if (data && data[0]) setExistingId(data[0].id);
    }

    setSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 3000);
  }

  function update<K extends keyof AIConfig>(key: K, value: AIConfig[K]) {
    setConfig(prev => ({ ...prev, [key]: value }));
  }

  const inputClass =
    'w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500';
  const labelClass = 'mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300';

  if (loading) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-6 sm:px-6">
        <div className="flex items-center justify-center py-16">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-brand-600 border-t-transparent" />
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-6 sm:px-6">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">AI Settings</h1>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          Configure how your AI assistant behaves when customers message you on WhatsApp
        </p>
        <PageHelp
          pageKey="ai-settings"
          title="AI Assistant Configuration"
          description="Control your AI assistant's personality, capabilities, and decision thresholds. The assistant name appears when AI responds to customers. Tone affects language style. Thresholds control how confidently the AI must be before auto-routing to a flow (higher = stricter) or asking for clarification (lower = more cautious). Fallback behavior determines what happens when the AI can't understand a message."
        />
      </div>

      <form onSubmit={handleSave} className="space-y-6">
        {/* Basic Settings */}
        <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-6">
          <h2 className="mb-4 text-lg font-semibold text-gray-900 dark:text-white">Basic Settings</h2>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className={labelClass}>Assistant Name</label>
              <input
                type="text"
                value={config.assistant_name}
                onChange={e => update('assistant_name', e.target.value)}
                placeholder="Assistant"
                className={inputClass}
              />
              <p className="mt-1 text-xs text-gray-400">Displayed to customers in AI responses</p>
            </div>
            <div>
              <label className={labelClass}>Tone</label>
              <select
                value={config.tone}
                onChange={e => update('tone', e.target.value)}
                className={inputClass}
              >
                <option value="friendly">Friendly</option>
                <option value="professional">Professional</option>
                <option value="casual">Casual</option>
              </select>
              <p className="mt-1 text-xs text-gray-400">Affects language style in AI responses</p>
            </div>
          </div>
        </div>

        {/* Toggles */}
        <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-6">
          <h2 className="mb-4 text-lg font-semibold text-gray-900 dark:text-white">Capabilities</h2>
          <div className="space-y-4">
            {([
              { key: 'ai_enabled' as const, label: 'AI Enabled', desc: 'Master toggle for the AI assistant. When off, all messages go to manual handling.' },
              { key: 'faq_enabled' as const, label: 'FAQ Answers', desc: 'Let AI answer frequently asked questions from your auto-replies.' },
              { key: 'knowledge_enabled' as const, label: 'Knowledge Responses', desc: 'Let AI use your business info (hours, location, services) to answer questions.' },
              { key: 'corrections_enabled' as const, label: 'Corrections', desc: 'Let AI correct its own mistakes when a customer points them out.' },
              { key: 'temporary_questions_enabled' as const, label: 'Temporary Questions', desc: 'Let AI answer one-off questions before returning to the current flow.' },
            ]).map(({ key, label, desc }) => (
              <label key={key} className="flex items-start gap-3 cursor-pointer">
                <div className="relative mt-0.5 flex-shrink-0">
                  <input
                    type="checkbox"
                    checked={config[key] as boolean}
                    onChange={e => update(key, e.target.checked)}
                    className="sr-only peer"
                  />
                  <div className="h-5 w-9 rounded-full bg-gray-300 dark:bg-gray-600 peer-checked:bg-brand-600 transition-colors" />
                  <div className="absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform peer-checked:translate-x-4" />
                </div>
                <div>
                  <p className="text-sm font-medium text-gray-900 dark:text-white">{label}</p>
                  <p className="text-xs text-gray-500 dark:text-gray-400">{desc}</p>
                </div>
              </label>
            ))}
          </div>
        </div>

        {/* Thresholds */}
        <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-6">
          <h2 className="mb-4 text-lg font-semibold text-gray-900 dark:text-white">Decision Thresholds</h2>
          <div className="space-y-6">
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className={labelClass}>Auto-route Threshold</label>
                <span className="text-sm font-mono font-medium text-brand-600 dark:text-brand-400">
                  {config.auto_route_threshold.toFixed(2)}
                </span>
              </div>
              <input
                type="range"
                min={0.60}
                max={1.00}
                step={0.05}
                value={config.auto_route_threshold}
                onChange={e => update('auto_route_threshold', parseFloat(e.target.value))}
                className="w-full accent-brand-600"
              />
              <div className="flex justify-between text-xs text-gray-400 mt-1">
                <span>0.60 (lenient)</span>
                <span>1.00 (strict)</span>
              </div>
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                Minimum confidence needed to automatically route a message to a flow
              </p>
            </div>

            <div>
              <div className="flex items-center justify-between mb-1">
                <label className={labelClass}>Clarification Threshold</label>
                <span className="text-sm font-mono font-medium text-brand-600 dark:text-brand-400">
                  {config.clarification_threshold.toFixed(2)}
                </span>
              </div>
              <input
                type="range"
                min={0.30}
                max={0.85}
                step={0.05}
                value={config.clarification_threshold}
                onChange={e => update('clarification_threshold', parseFloat(e.target.value))}
                className="w-full accent-brand-600"
              />
              <div className="flex justify-between text-xs text-gray-400 mt-1">
                <span>0.30 (cautious)</span>
                <span>0.85 (confident)</span>
              </div>
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                Below this confidence, AI will ask the customer to clarify their request
              </p>
            </div>
          </div>
        </div>

        {/* Fallback */}
        <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-6">
          <h2 className="mb-4 text-lg font-semibold text-gray-900 dark:text-white">Fallback Behavior</h2>
          <div>
            <label className={labelClass}>When AI cannot understand a message</label>
            <select
              value={config.fallback_behavior}
              onChange={e => update('fallback_behavior', e.target.value)}
              className={inputClass}
            >
              <option value="menu">Show main menu</option>
              <option value="human_handoff">Hand off to human agent</option>
              <option value="clarification">Ask for clarification</option>
            </select>
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              What the bot does when it cannot match the customer&apos;s intent
            </p>
          </div>
        </div>

        {/* Save */}
        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={saving}
            className="rounded-lg bg-brand-600 px-6 py-2.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50 transition-colors"
          >
            {saving ? 'Saving...' : 'Save Settings'}
          </button>
          {saved && (
            <span className="text-sm text-green-600 dark:text-green-400">Settings saved</span>
          )}
        </div>
      </form>
    </div>
  );
}
