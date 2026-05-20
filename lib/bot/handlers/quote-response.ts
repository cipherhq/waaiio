import { logger } from '@/lib/logger';

/**
 * Handle a quote accept/reject button postback from WhatsApp.
 */
export async function handleQuoteResponse(
  sendText: (to: string, text: string) => Promise<void>,
  from: string,
  quoteId: string,
  action: 'accept' | 'reject',
): Promise<void> {
  try {
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL
      || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null);

    if (!baseUrl) {
      await sendText(from, 'Sorry, something went wrong. Please try again.');
      return;
    }

    const response = await fetch(`${baseUrl}/api/orders/quote-accept`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ quote_id: quoteId, action }),
    });

    const result = await response.json();

    if (!response.ok) {
      await sendText(from, result.error || 'Something went wrong. Please try again.');
      return;
    }

    if (action === 'reject') {
      await sendText(from, 'Price declined. Thank you for considering!');
    }
    // Accept case: payment link is sent by the API route itself
  } catch (err) {
    logger.error('[BOT] Quote response error:', err);
    await sendText(from, 'Sorry, something went wrong. Please try again.');
  }
}
