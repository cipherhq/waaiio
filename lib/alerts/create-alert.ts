import type { SupabaseClient } from '@supabase/supabase-js';

interface AlertInput {
  businessId: string;
  type: string;
  severity: 'info' | 'warning' | 'critical';
  title: string;
  message: string;
  metadata?: Record<string, unknown>;
}

export async function createAlert(
  supabase: SupabaseClient,
  input: AlertInput,
): Promise<void> {
  await supabase.from('alerts').insert({
    business_id: input.businessId,
    type: input.type,
    severity: input.severity,
    title: input.title,
    message: input.message,
    metadata: input.metadata || {},
  });
}
