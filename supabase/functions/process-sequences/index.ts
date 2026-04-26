/**
 * Supabase Edge Function: process-sequences
 *
 * Triggered every 5 minutes via CRON to process bot sequence enrollments.
 * Sends the next message in a sequence when the delay has elapsed.
 *
 * CRON schedule (add to supabase/config.toml):
 *   [functions.process-sequences]
 *   schedule = "*/5 * * * *"
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const isDev = Deno.env.get('ENVIRONMENT') !== 'production';
const log = {
  debug: (...args: unknown[]) => { if (isDev) console.log(...args); },
  error: (...args: unknown[]) => console.error(...args),
};

const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const whatsappToken = Deno.env.get('WHATSAPP_TOKEN') || '';
const whatsappPhoneId = Deno.env.get('WHATSAPP_PHONE_NUMBER_ID') || '';

async function sendWhatsApp(to: string, text: string): Promise<boolean> {
  if (!whatsappToken || !whatsappPhoneId) {
    log.debug(`[mock] WhatsApp to ${to}: ${text.slice(0, 100)}...`);
    return true;
  }

  try {
    const phone = to.replace('+', '');
    const response = await fetch(
      `https://graph.facebook.com/v22.0/${whatsappPhoneId}/messages`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${whatsappToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to: phone,
          type: 'text',
          text: { body: text },
        }),
      },
    );
    return response.ok;
  } catch (err) {
    log.error(`Failed to send WhatsApp to ${to}:`, err);
    return false;
  }
}

function fillVariables(template: string, vars: Record<string, unknown>): string {
  let result = template;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replace(new RegExp(`\\{${key}\\}`, 'g'), String(value ?? ''));
  }
  return result;
}

Deno.serve(async () => {
  const supabase = createClient(supabaseUrl, supabaseKey);
  const now = new Date().toISOString();

  log.debug('[SEQUENCES] Processing enrollments at', now);

  // Fetch all pending enrollments that are due
  const { data: enrollments, error: fetchErr } = await supabase
    .from('bot_sequence_enrollments')
    .select('*')
    .eq('status', 'active')
    .lte('next_send_at', now)
    .limit(50); // Process max 50 per run to avoid timeout

  if (fetchErr) {
    log.error('[SEQUENCES] Failed to fetch enrollments:', fetchErr);
    return new Response(JSON.stringify({ error: fetchErr.message }), { status: 500 });
  }

  if (!enrollments || enrollments.length === 0) {
    log.debug('[SEQUENCES] No pending enrollments');
    return new Response(JSON.stringify({ processed: 0 }), { status: 200 });
  }

  let processed = 0;
  let errors = 0;

  for (const enrollment of enrollments) {
    try {
      // Get steps for this sequence
      const { data: steps } = await supabase
        .from('bot_sequence_steps')
        .select('*')
        .eq('sequence_id', enrollment.sequence_id)
        .order('step_order', { ascending: true });

      if (!steps || steps.length === 0) {
        await supabase
          .from('bot_sequence_enrollments')
          .update({ status: 'completed' })
          .eq('id', enrollment.id);
        processed++;
        continue;
      }

      const currentStep = steps[enrollment.current_step];
      if (!currentStep) {
        // Past the last step — mark completed
        await supabase
          .from('bot_sequence_enrollments')
          .update({ status: 'completed' })
          .eq('id', enrollment.id);
        processed++;
        continue;
      }

      // Evaluate step condition if present
      if (currentStep.condition) {
        const context = enrollment.context || {};
        const field = currentStep.condition.field as string;
        const op = currentStep.condition.op as string;
        const condValue = currentStep.condition.value;
        const actual = context[field];

        let conditionMet = true;
        if (actual !== undefined && actual !== null) {
          switch (op) {
            case 'eq': conditionMet = String(actual) === String(condValue); break;
            case 'neq': conditionMet = String(actual) !== String(condValue); break;
            case 'gt': conditionMet = Number(actual) > Number(condValue); break;
            case 'gte': conditionMet = Number(actual) >= Number(condValue); break;
            case 'lt': conditionMet = Number(actual) < Number(condValue); break;
            case 'lte': conditionMet = Number(actual) <= Number(condValue); break;
            default: conditionMet = true;
          }
        } else {
          conditionMet = false;
        }

        if (!conditionMet) {
          // Skip step, advance
          const nextIdx = enrollment.current_step + 1;
          if (nextIdx >= steps.length) {
            await supabase
              .from('bot_sequence_enrollments')
              .update({ status: 'completed', current_step: nextIdx })
              .eq('id', enrollment.id);
          } else {
            const nextDelay = steps[nextIdx].delay_minutes || 0;
            await supabase
              .from('bot_sequence_enrollments')
              .update({
                current_step: nextIdx,
                next_send_at: new Date(Date.now() + nextDelay * 60 * 1000).toISOString(),
              })
              .eq('id', enrollment.id);
          }
          processed++;
          continue;
        }
      }

      // Fill template variables
      const message = fillVariables(currentStep.message_content, enrollment.context || {});
      const phone = enrollment.customer_phone.replace(/^\+/, '');

      // Send message
      const sent = await sendWhatsApp(phone, message);
      if (!sent) {
        errors++;
        log.error('[SEQUENCES] Failed to send to', phone);
        continue; // Will retry next cycle
      }

      // Advance to next step
      const nextIdx = enrollment.current_step + 1;
      if (nextIdx >= steps.length) {
        await supabase
          .from('bot_sequence_enrollments')
          .update({ status: 'completed', current_step: nextIdx })
          .eq('id', enrollment.id);
      } else {
        const nextDelay = steps[nextIdx].delay_minutes || 0;
        await supabase
          .from('bot_sequence_enrollments')
          .update({
            current_step: nextIdx,
            next_send_at: new Date(Date.now() + nextDelay * 60 * 1000).toISOString(),
          })
          .eq('id', enrollment.id);
      }

      processed++;
    } catch (err) {
      log.error('[SEQUENCES] Error processing enrollment:', enrollment.id, err);
      errors++;
    }
  }

  log.debug(`[SEQUENCES] Done. Processed: ${processed}, Errors: ${errors}`);
  return new Response(JSON.stringify({ processed, errors }), { status: 200 });
});
