import { createHmac } from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';

export type WebhookEventType =
  | 'booking.created'
  | 'booking.confirmed'
  | 'booking.cancelled'
  | 'booking.completed'
  | 'payment.received'
  | 'payment.failed'
  | 'order.created'
  | 'order.completed'
  | 'customer.checkin'
  | 'customer.created'
  | 'feedback.received'
  | 'loyalty.points_earned';

interface WebhookEndpoint {
  id: string;
  url: string;
  secret: string | null;
  events: string[];
  is_active: boolean;
}

export async function dispatchWebhook(
  supabase: SupabaseClient,
  businessId: string,
  eventType: WebhookEventType,
  payload: Record<string, unknown>,
): Promise<void> {
  const { data: endpoints } = await supabase
    .from('webhook_endpoints')
    .select('id, url, secret, events, is_active')
    .eq('business_id', businessId)
    .eq('is_active', true);

  if (!endpoints || endpoints.length === 0) return;

  const matching = endpoints.filter(
    (ep: WebhookEndpoint) => ep.events.includes(eventType) || ep.events.includes('*'),
  );

  for (const endpoint of matching) {
    const body = JSON.stringify({
      event: eventType,
      timestamp: new Date().toISOString(),
      data: payload,
    });

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (endpoint.secret) {
      headers['X-Webhook-Signature'] = createHmac('sha256', endpoint.secret)
        .update(body)
        .digest('hex');
    }

    let success = false;
    let responseStatus = 0;
    let responseBody = '';

    try {
      const res = await fetch(endpoint.url, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(10000),
      });
      responseStatus = res.status;
      responseBody = await res.text().catch(() => '');
      success = res.ok;
    } catch (err) {
      responseBody = err instanceof Error ? err.message : 'Unknown error';
    }

    // Log delivery
    await supabase.from('webhook_deliveries').insert({
      endpoint_id: endpoint.id,
      event_type: eventType,
      payload: { event: eventType, data: payload },
      response_status: responseStatus || null,
      response_body: responseBody.slice(0, 2000),
      success,
    });

    // Update endpoint stats
    await supabase
      .from('webhook_endpoints')
      .update({
        last_triggered_at: new Date().toISOString(),
        failure_count: success ? 0 : (endpoint as WebhookEndpoint & { failure_count: number }).failure_count + 1,
      })
      .eq('id', endpoint.id);
  }
}
