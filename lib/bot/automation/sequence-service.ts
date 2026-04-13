import type { SupabaseClient } from '@supabase/supabase-js';
import { logger } from '@/lib/logger';

interface SequenceStep {
  id: string;
  step_order: number;
  delay_minutes: number;
  message_type: 'text' | 'image' | 'template';
  message_content: string;
  image_url: string | null;
  condition: Record<string, unknown> | null;
}

interface Enrollment {
  id: string;
  sequence_id: string;
  business_id: string;
  customer_phone: string;
  current_step: number;
  next_send_at: string;
  status: 'active' | 'completed' | 'cancelled';
  context: Record<string, unknown>;
}

/**
 * Enroll a customer into a sequence.
 * If already enrolled in the same sequence and active, skip.
 */
export async function enrollInSequence(
  supabase: SupabaseClient,
  businessId: string,
  sequenceId: string,
  customerPhone: string,
  context: Record<string, unknown> = {},
): Promise<void> {
  // Check for existing active enrollment
  const { data: existing } = await supabase
    .from('bot_sequence_enrollments')
    .select('id')
    .eq('sequence_id', sequenceId)
    .eq('customer_phone', customerPhone)
    .eq('status', 'active')
    .maybeSingle();

  if (existing) return; // Already enrolled

  // Get the first step to calculate initial delay
  const { data: steps } = await supabase
    .from('bot_sequence_steps')
    .select('delay_minutes')
    .eq('sequence_id', sequenceId)
    .order('step_order', { ascending: true })
    .limit(1);

  const firstDelay = steps?.[0]?.delay_minutes || 0;
  const nextSendAt = new Date(Date.now() + firstDelay * 60 * 1000).toISOString();

  await supabase.from('bot_sequence_enrollments').insert({
    sequence_id: sequenceId,
    business_id: businessId,
    customer_phone: customerPhone,
    current_step: 0,
    next_send_at: nextSendAt,
    status: 'active',
    context,
  });

  logger.debug('[SEQUENCE] Enrolled', customerPhone, 'in sequence', sequenceId);
}

/**
 * Process a single enrollment: send the current step's message and advance.
 * Called by the CRON edge function.
 */
export async function processEnrollmentStep(
  supabase: SupabaseClient,
  enrollment: Enrollment,
  sendMessage: (phone: string, text: string) => Promise<void>,
  sendImage?: (phone: string, imageUrl: string, caption: string) => Promise<void>,
): Promise<void> {
  // Get all steps for this sequence
  const { data: steps } = await supabase
    .from('bot_sequence_steps')
    .select('*')
    .eq('sequence_id', enrollment.sequence_id)
    .order('step_order', { ascending: true });

  if (!steps || steps.length === 0) {
    // No steps — mark as completed
    await supabase
      .from('bot_sequence_enrollments')
      .update({ status: 'completed' })
      .eq('id', enrollment.id);
    return;
  }

  const currentStep = steps[enrollment.current_step] as SequenceStep | undefined;
  if (!currentStep) {
    // Past the last step — mark completed
    await supabase
      .from('bot_sequence_enrollments')
      .update({ status: 'completed' })
      .eq('id', enrollment.id);
    return;
  }

  // Evaluate condition if present
  if (currentStep.condition) {
    const conditionMet = evaluateCondition(currentStep.condition, enrollment.context);
    if (!conditionMet) {
      // Skip this step, advance to next
      await advanceEnrollment(supabase, enrollment, steps, enrollment.current_step + 1);
      return;
    }
  }

  // Fill template variables in message content
  const message = fillVariables(currentStep.message_content, enrollment.context);
  const phone = enrollment.customer_phone.replace(/^\+/, '');

  // Send message
  try {
    if (currentStep.message_type === 'image' && currentStep.image_url && sendImage) {
      await sendImage(phone, currentStep.image_url, message);
    } else {
      await sendMessage(phone, message);
    }
  } catch (err) {
    logger.error('[SEQUENCE] Failed to send message:', err);
    // Don't advance — will retry next cycle
    return;
  }

  // Advance to next step
  await advanceEnrollment(supabase, enrollment, steps, enrollment.current_step + 1);
}

async function advanceEnrollment(
  supabase: SupabaseClient,
  enrollment: Enrollment,
  steps: SequenceStep[],
  nextStepIndex: number,
): Promise<void> {
  if (nextStepIndex >= steps.length) {
    // Sequence complete
    await supabase
      .from('bot_sequence_enrollments')
      .update({ status: 'completed', current_step: nextStepIndex })
      .eq('id', enrollment.id);
    return;
  }

  const nextStep = steps[nextStepIndex];
  const nextSendAt = new Date(Date.now() + nextStep.delay_minutes * 60 * 1000).toISOString();

  await supabase
    .from('bot_sequence_enrollments')
    .update({
      current_step: nextStepIndex,
      next_send_at: nextSendAt,
    })
    .eq('id', enrollment.id);
}

function evaluateCondition(
  condition: Record<string, unknown>,
  context: Record<string, unknown>,
): boolean {
  const field = condition.field as string;
  const op = condition.op as string;
  const value = condition.value;
  const actual = context[field];

  if (actual === undefined || actual === null) return false;

  switch (op) {
    case 'eq': return String(actual) === String(value);
    case 'neq': return String(actual) !== String(value);
    case 'gt': return Number(actual) > Number(value);
    case 'gte': return Number(actual) >= Number(value);
    case 'lt': return Number(actual) < Number(value);
    case 'lte': return Number(actual) <= Number(value);
    case 'contains': return String(actual).toLowerCase().includes(String(value).toLowerCase());
    default: return true;
  }
}

function fillVariables(template: string, vars: Record<string, unknown>): string {
  let result = template;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replace(new RegExp(`\\{${key}\\}`, 'g'), String(value ?? ''));
  }
  return result;
}

/**
 * Find and enroll customers into matching sequences for a trigger event.
 * Called from post-completion and other event hooks.
 */
export async function triggerSequences(
  supabase: SupabaseClient,
  businessId: string,
  triggerEvent: string,
  customerPhone: string,
  context: Record<string, unknown> = {},
): Promise<void> {
  const { data: sequences } = await supabase
    .from('bot_sequences')
    .select('id')
    .eq('business_id', businessId)
    .eq('trigger_event', triggerEvent)
    .eq('is_active', true);

  if (!sequences || sequences.length === 0) return;

  for (const seq of sequences) {
    try {
      await enrollInSequence(supabase, businessId, seq.id, customerPhone, context);
    } catch (err) {
      logger.error('[SEQUENCE] Enrollment error:', err);
    }
  }
}
