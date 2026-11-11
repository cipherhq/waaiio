import { createHash } from 'crypto';
import { compileNativeFormFlow, type WaaiioFormDefinition } from './native-flow';

export type NativeFormConfig = WaaiioFormDefinition & { settings?: Record<string, unknown> | null };

/** JSONB round trips reorder keys. Arrays retain their authored order. */
export function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
}

export function publicationConfig(form: NativeFormConfig) {
  return { title: form.title, description: form.description ?? null, fields: form.fields, settings: form.settings ?? {} };
}

export function compilePublication(form: NativeFormConfig) {
  const config = publicationConfig(form);
  const flowJson = compileNativeFormFlow(config);
  const revision = createHash('sha256').update(stableJson(config)).digest('hex');
  return { config, flowJson, revision };
}

export interface NativePublication {
  id: string;
  form_id: string;
  business_id: string;
  channel_id: string;
  phone_number_id: string;
  waba_id: string;
  meta_flow_id: string | null;
  revision: string;
  config: ReturnType<typeof publicationConfig>;
  flow_json: Record<string, unknown>;
  status: 'creating' | 'draft' | 'published' | 'needs_review';
}
