'use client';

import { useState, useEffect, useCallback } from 'react';
import { useBusiness, useCapabilities } from '@/components/dashboard/DashboardProvider';
import { createClient } from '@/lib/supabase/client';
import {
  getManifestForFlow,
  getManifestFlowTypes,
  type StepManifestEntry,
} from '@/lib/bot/flows/step-manifest';
import { CAPABILITIES, type CapabilityId } from '@/lib/capabilities/types';

// ── Types ──

type StepAction = 'default' | 'skip' | 'require' | 'custom';

interface BranchCondition {
  field: string;
  operator: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains';
  value: string;
  targetStepId: string;
}

interface StepOverride {
  id?: string;
  business_id: string;
  flow_type: string;
  step_id: string;
  action: StepAction;
  custom_prompt: string | null;
  custom_options: Record<string, unknown> | null;
  branch_conditions: BranchCondition[] | null;
}

// ── Constants ──

const capLabelMap: Record<string, string> = Object.fromEntries(
  CAPABILITIES.map(c => [c.id, c.label]),
);

const OPERATOR_LABELS: Record<string, string> = {
  eq: 'equals',
  neq: 'not equals',
  gt: 'greater than',
  gte: 'greater or equal',
  lt: 'less than',
  lte: 'less or equal',
  contains: 'contains',
};

const ACTION_BADGE_STYLES: Record<StepAction, string> = {
  default: 'bg-gray-100 text-gray-600',
  skip: 'bg-yellow-100 text-yellow-700',
  require: 'bg-green-100 text-green-700',
  custom: 'bg-purple-100 text-purple-700',
};

// ── Component ──

export default function FlowEditorPage() {
  const business = useBusiness();
  const { capabilities } = useCapabilities();
  const supabase = createClient();

  const [overrides, setOverrides] = useState<Map<string, StepOverride>>(new Map());
  const [expandedFlows, setExpandedFlows] = useState<Set<string>>(new Set(['scheduling']));
  const [saving, setSaving] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Key for override map: flowType::stepId
  const overrideKey = (flowType: string, stepId: string) => `${flowType}::${stepId}`;

  // ── Load existing overrides ──

  const loadOverrides = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from('bot_step_overrides')
      .select('*')
      .eq('business_id', business.id);

    if (!error && data) {
      const map = new Map<string, StepOverride>();
      for (const row of data) {
        map.set(overrideKey(row.flow_type, row.step_id), row as StepOverride);
      }
      setOverrides(map);
    }
    setLoading(false);
  }, [business.id, supabase]);

  useEffect(() => {
    loadOverrides();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [business.id]);

  // ── Helpers ──

  function getOverride(flowType: string, stepId: string): StepOverride | undefined {
    return overrides.get(overrideKey(flowType, stepId));
  }

  function getAction(flowType: string, stepId: string): StepAction {
    return getOverride(flowType, stepId)?.action || 'default';
  }

  function toggleFlow(flowType: string) {
    setExpandedFlows((prev) => {
      const next = new Set(prev);
      if (next.has(flowType)) {
        next.delete(flowType);
      } else {
        next.add(flowType);
      }
      return next;
    });
  }

  // ── Action change ──

  function handleActionChange(entry: StepManifestEntry, newAction: StepAction) {
    const key = overrideKey(entry.flowType, entry.stepId);
    const existing = overrides.get(key);

    if (newAction === 'default') {
      // Remove override
      const next = new Map(overrides);
      next.delete(key);
      setOverrides(next);
      return;
    }

    const updated: StepOverride = {
      ...existing,
      business_id: business.id,
      flow_type: entry.flowType,
      step_id: entry.stepId,
      action: newAction,
      custom_prompt: existing?.custom_prompt || null,
      custom_options: existing?.custom_options || null,
      branch_conditions: existing?.branch_conditions || null,
    };

    const next = new Map(overrides);
    next.set(key, updated);
    setOverrides(next);
  }

  // ── Custom prompt change ──

  function handleCustomPromptChange(flowType: string, stepId: string, prompt: string) {
    const key = overrideKey(flowType, stepId);
    const existing = overrides.get(key);
    if (!existing) return;

    const next = new Map(overrides);
    next.set(key, { ...existing, custom_prompt: prompt });
    setOverrides(next);
  }

  // ── Branch conditions ──

  function getBranchConditions(flowType: string, stepId: string): BranchCondition[] {
    return getOverride(flowType, stepId)?.branch_conditions || [];
  }

  function updateBranchConditions(flowType: string, stepId: string, conditions: BranchCondition[]) {
    const key = overrideKey(flowType, stepId);
    const existing = overrides.get(key);
    if (!existing) return;

    const next = new Map(overrides);
    next.set(key, { ...existing, branch_conditions: conditions.length > 0 ? conditions : null });
    setOverrides(next);
  }

  function addBranchCondition(flowType: string, stepId: string) {
    const conditions = getBranchConditions(flowType, stepId);
    const stepsInFlow = getManifestForFlow(flowType);
    const firstTarget = stepsInFlow.find((s) => s.stepId !== stepId)?.stepId || '';
    updateBranchConditions(flowType, stepId, [
      ...conditions,
      { field: '', operator: 'eq', value: '', targetStepId: firstTarget },
    ]);
  }

  function removeBranchCondition(flowType: string, stepId: string, index: number) {
    const conditions = getBranchConditions(flowType, stepId);
    updateBranchConditions(
      flowType,
      stepId,
      conditions.filter((_, i) => i !== index),
    );
  }

  function updateConditionField(
    flowType: string,
    stepId: string,
    index: number,
    field: keyof BranchCondition,
    value: string,
  ) {
    const conditions = [...getBranchConditions(flowType, stepId)];
    conditions[index] = { ...conditions[index], [field]: value };
    updateBranchConditions(flowType, stepId, conditions);
  }

  // ── Save override ──

  async function handleSave(flowType: string, stepId: string) {
    const key = overrideKey(flowType, stepId);
    const override = overrides.get(key);
    const saveKey = key;
    setSaving(saveKey);

    if (!override) {
      // Delete the override (reset to default)
      await supabase
        .from('bot_step_overrides')
        .delete()
        .eq('business_id', business.id)
        .eq('flow_type', flowType)
        .eq('step_id', stepId);
    } else {
      // Upsert
      const payload = {
        business_id: business.id,
        flow_type: override.flow_type,
        step_id: override.step_id,
        action: override.action,
        custom_prompt: override.custom_prompt,
        custom_options: override.custom_options,
        branch_conditions: override.branch_conditions,
      };

      await supabase
        .from('bot_step_overrides')
        .upsert(payload, { onConflict: 'business_id,flow_type,step_id' });
    }

    setSaving(null);
    setSaved(saveKey);
    setTimeout(() => setSaved(null), 2000);
    await loadOverrides();
  }

  // ── Delete override (reset to default) ──

  async function handleReset(flowType: string, stepId: string) {
    const key = overrideKey(flowType, stepId);
    setSaving(key);

    await supabase
      .from('bot_step_overrides')
      .delete()
      .eq('business_id', business.id)
      .eq('flow_type', flowType)
      .eq('step_id', stepId);

    const next = new Map(overrides);
    next.delete(key);
    setOverrides(next);

    setSaving(null);
    setSaved(key);
    setTimeout(() => setSaved(null), 2000);
  }

  // ── Render ──

  const flowTypes = getManifestFlowTypes().filter(ft => capabilities.includes(ft as CapabilityId));

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-gray-200 border-t-brand" />
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Bot Flows</h1>
          <p className="mt-1 text-sm text-gray-500">
            Configure how each step in your bot conversation flows behaves. Skip optional steps,
            require them, or provide custom prompts.
          </p>
        </div>
      </div>

      <div className="mt-6 max-w-3xl space-y-4">
        {flowTypes.length === 0 && (
          <div className="rounded-xl border border-gray-100 bg-white p-10 text-center">
            <p className="text-sm text-gray-500">
              No bot flows available. Enable capabilities in{' '}
              <a href="/dashboard/settings" className="font-medium text-brand hover:underline">
                Settings
              </a>{' '}
              to configure their conversation flows.
            </p>
          </div>
        )}
        {flowTypes.map((flowType) => {
          const steps = getManifestForFlow(flowType);
          const isExpanded = expandedFlows.has(flowType);
          const overrideCount = steps.filter(
            (s) => getAction(s.flowType, s.stepId) !== 'default',
          ).length;

          return (
            <div
              key={flowType}
              className="rounded-xl border border-gray-100 bg-white"
            >
              {/* Accordion header */}
              <button
                type="button"
                onClick={() => toggleFlow(flowType)}
                className="flex w-full items-center justify-between p-6 text-left"
              >
                <div className="flex items-center gap-3">
                  <h2 className="text-lg font-semibold text-gray-900">
                    {capLabelMap[flowType] || flowType}
                  </h2>
                  <span className="inline-flex rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-600">
                    {steps.length} steps
                  </span>
                  {overrideCount > 0 && (
                    <span className="inline-flex rounded-full bg-brand-100 px-2 py-0.5 text-xs font-medium text-brand-700">
                      {overrideCount} customized
                    </span>
                  )}
                </div>
                <svg
                  className={`h-5 w-5 text-gray-400 transition-transform ${
                    isExpanded ? 'rotate-180' : ''
                  }`}
                  fill="none"
                  viewBox="0 0 24 24"
                  strokeWidth={2}
                  stroke="currentColor"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
                </svg>
              </button>

              {/* Accordion body */}
              {isExpanded && (
                <div className="border-t border-gray-100 px-6 pb-6">
                  <div className="divide-y divide-gray-50">
                    {steps.map((entry) => {
                      const action = getAction(entry.flowType, entry.stepId);
                      const key = overrideKey(entry.flowType, entry.stepId);
                      const override = getOverride(entry.flowType, entry.stepId);
                      const isSaving = saving === key;
                      const isSaved = saved === key;
                      const conditions = getBranchConditions(entry.flowType, entry.stepId);
                      const stepsInFlow = getManifestForFlow(entry.flowType);

                      return (
                        <div key={entry.stepId} className="py-4 first:pt-4">
                          {/* Step row */}
                          <div className="flex items-start justify-between gap-4">
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2">
                                <h3 className="text-sm font-semibold text-gray-900">
                                  {entry.label}
                                </h3>
                                {entry.isOptional && (
                                  <span className="inline-flex rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-500">
                                    Optional
                                  </span>
                                )}
                                <span
                                  className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${ACTION_BADGE_STYLES[action]}`}
                                >
                                  {action}
                                </span>
                              </div>
                              <p className="mt-0.5 text-xs text-gray-500">
                                {entry.description}
                              </p>
                              <p className="mt-0.5 text-[10px] text-gray-400">
                                Prompt type: {entry.promptType}
                              </p>
                            </div>

                            <div className="flex items-center gap-2">
                              {/* Action dropdown */}
                              <select
                                value={action}
                                onChange={(e) =>
                                  handleActionChange(entry, e.target.value as StepAction)
                                }
                                className="rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand"
                              >
                                <option value="default">Default</option>
                                <option value="skip">Skip</option>
                                <option value="require">Require</option>
                                <option value="custom">Custom</option>
                              </select>

                              {/* Save button */}
                              <button
                                onClick={() => handleSave(entry.flowType, entry.stepId)}
                                disabled={isSaving}
                                className="rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white hover:bg-brand-600 disabled:opacity-50"
                              >
                                {isSaving ? 'Saving...' : isSaved ? 'Saved!' : 'Save'}
                              </button>

                              {/* Reset button (only if override exists) */}
                              {override && (
                                <button
                                  onClick={() => handleReset(entry.flowType, entry.stepId)}
                                  disabled={isSaving}
                                  className="rounded-lg border border-gray-200 px-3 py-2 text-sm font-medium text-gray-600 hover:bg-gray-50 disabled:opacity-50"
                                >
                                  Reset
                                </button>
                              )}
                            </div>
                          </div>

                          {/* Custom prompt textarea */}
                          {action === 'custom' && (
                            <div className="mt-3">
                              <label className="mb-1 block text-xs font-medium text-gray-600">
                                Custom Prompt
                              </label>
                              <textarea
                                value={override?.custom_prompt || ''}
                                onChange={(e) =>
                                  handleCustomPromptChange(
                                    entry.flowType,
                                    entry.stepId,
                                    e.target.value,
                                  )
                                }
                                placeholder="Enter custom prompt text for this step..."
                                rows={3}
                                className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand"
                              />
                            </div>
                          )}

                          {/* Branch condition builder (Phase 3C) */}
                          {action === 'custom' && (
                            <div className="mt-4">
                              <div className="flex items-center justify-between">
                                <label className="block text-xs font-medium text-gray-600">
                                  Branch Conditions
                                </label>
                                <button
                                  type="button"
                                  onClick={() =>
                                    addBranchCondition(entry.flowType, entry.stepId)
                                  }
                                  className="text-xs font-semibold text-brand hover:text-brand-600"
                                >
                                  + Add Condition
                                </button>
                              </div>

                              {conditions.length === 0 && (
                                <p className="mt-1 text-xs text-gray-400">
                                  No branch conditions. Add one to route users to different steps
                                  based on their input.
                                </p>
                              )}

                              {conditions.map((cond, idx) => (
                                <div
                                  key={idx}
                                  className="mt-2 flex flex-wrap items-end gap-2 rounded-lg border border-gray-100 bg-gray-50 p-3"
                                >
                                  {/* Field */}
                                  <div className="flex-1 min-w-[120px]">
                                    <label className="mb-1 block text-[10px] font-medium text-gray-500">
                                      Field
                                    </label>
                                    <input
                                      type="text"
                                      value={cond.field}
                                      onChange={(e) =>
                                        updateConditionField(
                                          entry.flowType,
                                          entry.stepId,
                                          idx,
                                          'field',
                                          e.target.value,
                                        )
                                      }
                                      placeholder="e.g. session_data.service"
                                      className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand"
                                    />
                                  </div>

                                  {/* Operator */}
                                  <div className="w-[140px]">
                                    <label className="mb-1 block text-[10px] font-medium text-gray-500">
                                      Operator
                                    </label>
                                    <select
                                      value={cond.operator}
                                      onChange={(e) =>
                                        updateConditionField(
                                          entry.flowType,
                                          entry.stepId,
                                          idx,
                                          'operator',
                                          e.target.value,
                                        )
                                      }
                                      className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand"
                                    >
                                      {Object.entries(OPERATOR_LABELS).map(([op, label]) => (
                                        <option key={op} value={op}>
                                          {label}
                                        </option>
                                      ))}
                                    </select>
                                  </div>

                                  {/* Value */}
                                  <div className="flex-1 min-w-[120px]">
                                    <label className="mb-1 block text-[10px] font-medium text-gray-500">
                                      Value
                                    </label>
                                    <input
                                      type="text"
                                      value={cond.value}
                                      onChange={(e) =>
                                        updateConditionField(
                                          entry.flowType,
                                          entry.stepId,
                                          idx,
                                          'value',
                                          e.target.value,
                                        )
                                      }
                                      placeholder="e.g. haircut"
                                      className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand"
                                    />
                                  </div>

                                  {/* Target step */}
                                  <div className="w-[180px]">
                                    <label className="mb-1 block text-[10px] font-medium text-gray-500">
                                      Go to Step
                                    </label>
                                    <select
                                      value={cond.targetStepId}
                                      onChange={(e) =>
                                        updateConditionField(
                                          entry.flowType,
                                          entry.stepId,
                                          idx,
                                          'targetStepId',
                                          e.target.value,
                                        )
                                      }
                                      className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand"
                                    >
                                      {stepsInFlow
                                        .filter((s) => s.stepId !== entry.stepId)
                                        .map((s) => (
                                          <option key={s.stepId} value={s.stepId}>
                                            {s.label}
                                          </option>
                                        ))}
                                    </select>
                                  </div>

                                  {/* Remove button */}
                                  <button
                                    type="button"
                                    onClick={() =>
                                      removeBranchCondition(entry.flowType, entry.stepId, idx)
                                    }
                                    className="flex h-[38px] w-[38px] items-center justify-center rounded-lg border border-gray-200 text-gray-400 hover:border-red-200 hover:text-red-500"
                                  >
                                    <svg
                                      className="h-4 w-4"
                                      fill="none"
                                      viewBox="0 0 24 24"
                                      strokeWidth={2}
                                      stroke="currentColor"
                                    >
                                      <path
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                        d="M6 18L18 6M6 6l12 12"
                                      />
                                    </svg>
                                  </button>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <p className="mt-6 max-w-3xl text-xs text-gray-400">
        Changes are saved per-step. Use "Reset" to revert a step to its default behavior.
        Branch conditions (Phase 3C) allow routing users to different steps based on their input values.
      </p>
    </div>
  );
}
