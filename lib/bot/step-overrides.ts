import type { SupabaseClient } from '@supabase/supabase-js';

export interface StepOverride {
  action: 'default' | 'skip' | 'require' | 'custom';
  customPrompt: string | null;
  customOptions: unknown | null;
  branchConditions: BranchCondition[] | null;
}

export interface BranchCondition {
  condition: {
    field: string;
    op: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains' | 'not_contains';
    value: string | number;
  };
  next_step: string;
}

type OverrideMap = Map<string, StepOverride>;

const CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const cache = new Map<string, { data: OverrideMap; ts: number }>();

/**
 * Load step overrides for a business + flow type.
 * Cached for 5 minutes.
 */
export async function loadOverrides(
  supabase: SupabaseClient,
  businessId: string,
  flowType: string,
): Promise<OverrideMap> {
  const cacheKey = `${businessId}:${flowType}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.data;

  const { data } = await supabase
    .from('bot_step_overrides')
    .select('step_id, action, custom_prompt, custom_options, branch_conditions')
    .eq('business_id', businessId)
    .eq('flow_type', flowType);

  const map: OverrideMap = new Map();
  if (data) {
    for (const row of data) {
      map.set(row.step_id, {
        action: row.action as StepOverride['action'],
        customPrompt: row.custom_prompt || null,
        customOptions: row.custom_options || null,
        branchConditions: (row.branch_conditions as BranchCondition[]) || null,
      });
    }
  }

  cache.set(cacheKey, { data: map, ts: Date.now() });

  // Prune cache if too large
  if (cache.size > 500) {
    const cutoff = Date.now() - CACHE_TTL;
    for (const [k, v] of cache) {
      if (v.ts < cutoff) cache.delete(k);
    }
  }

  return map;
}

/**
 * Evaluate branch conditions against session data.
 * Returns the next_step if any condition matches, null otherwise.
 */
export function evaluateBranchConditions(
  conditions: BranchCondition[],
  sessionData: Record<string, unknown>,
): string | null {
  for (const branch of conditions) {
    const { field, op, value } = branch.condition;
    const actual = sessionData[field];
    if (actual === undefined || actual === null) continue;

    let matches = false;
    switch (op) {
      case 'eq':
        matches = String(actual) === String(value);
        break;
      case 'neq':
        matches = String(actual) !== String(value);
        break;
      case 'gt':
        matches = Number(actual) > Number(value);
        break;
      case 'gte':
        matches = Number(actual) >= Number(value);
        break;
      case 'lt':
        matches = Number(actual) < Number(value);
        break;
      case 'lte':
        matches = Number(actual) <= Number(value);
        break;
      case 'contains':
        matches = String(actual).toLowerCase().includes(String(value).toLowerCase());
        break;
      case 'not_contains':
        matches = !String(actual).toLowerCase().includes(String(value).toLowerCase());
        break;
    }

    if (matches) return branch.next_step;
  }
  return null;
}
