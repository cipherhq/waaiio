import Anthropic from '@anthropic-ai/sdk';
import { logger } from '@/lib/logger';

export interface ReceiptOCRResult {
  amount: number | null;
  reference: string | null;
  senderName: string | null;
  bankName: string | null;
  date: string | null;
  confidence: number; // 0-1
  rawText: string;
}

const EMPTY_RESULT: ReceiptOCRResult = {
  amount: null,
  reference: null,
  senderName: null,
  bankName: null,
  date: null,
  confidence: 0,
  rawText: '',
};

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!client) client = new Anthropic();
  return client;
}

/**
 * Extract payment details from a receipt/transfer screenshot using Claude Vision.
 * Uses Haiku for speed + cost (~$0.01 per image).
 */
export async function analyzeReceipt(
  imageUrl: string,
  expectedAmount: number,
  expectedReference: string,
  currency: string = 'NGN',
): Promise<ReceiptOCRResult> {
  if (!process.env.ANTHROPIC_API_KEY) {
    logger.warn('[RECEIPT_OCR] ANTHROPIC_API_KEY not set, skipping OCR');
    return EMPTY_RESULT;
  }

  try {
    // Fetch the image and convert to base64
    const imageResponse = await fetch(imageUrl);
    if (!imageResponse.ok) {
      logger.error('[RECEIPT_OCR] Failed to fetch image:', imageResponse.status);
      return EMPTY_RESULT;
    }

    const imageBuffer = await imageResponse.arrayBuffer();
    const base64Image = Buffer.from(imageBuffer).toString('base64');

    // Detect media type from content-type header
    const contentType = imageResponse.headers.get('content-type') || 'image/jpeg';
    const mediaType = contentType.startsWith('image/')
      ? contentType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'
      : 'image/jpeg';

    const anthropic = getClient();

    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 512,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: mediaType,
                data: base64Image,
              },
            },
            {
              type: 'text',
              text: `Extract payment/transfer details from this receipt or bank transfer screenshot. Return ONLY valid JSON, no other text:

{"amount": <number or null>, "reference": "<narration/reference/remark text or null>", "sender_name": "<sender name or null>", "bank_name": "<bank name or null>", "date": "<date string or null>", "confidence": <0.0-1.0>}

Rules:
- amount: The transfer/payment amount as a number (no currency symbols). For Nigerian Naira, look for NGN/₦ amounts.
- reference: The transfer narration, remark, reference, or description field. Look for codes like "WA-XXXX" in the narration/remark.
- sender_name: The name of the person who sent the money.
- bank_name: The bank that processed the transfer.
- date: The transaction date if visible.
- confidence: How confident you are that this is a valid payment receipt (0.0-1.0). Set to 0 if this doesn't look like a receipt.

Expected amount: ${currency} ${expectedAmount.toLocaleString()}
Expected reference: ${expectedReference}`,
            },
          ],
        },
      ],
    });

    const text = response.content[0]?.type === 'text' ? response.content[0].text : '';

    // Parse JSON from response
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      logger.warn('[RECEIPT_OCR] No JSON in response:', text);
      return { ...EMPTY_RESULT, rawText: text };
    }

    const parsed = JSON.parse(jsonMatch[0]);

    return {
      amount: typeof parsed.amount === 'number' ? parsed.amount : null,
      reference: typeof parsed.reference === 'string' ? parsed.reference : null,
      senderName: typeof parsed.sender_name === 'string' ? parsed.sender_name : null,
      bankName: typeof parsed.bank_name === 'string' ? parsed.bank_name : null,
      date: typeof parsed.date === 'string' ? parsed.date : null,
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0,
      rawText: text,
    };
  } catch (err) {
    logger.error('[RECEIPT_OCR] Error:', err);
    return EMPTY_RESULT;
  }
}

/**
 * Check if OCR result matches the expected payment.
 * Returns true if amount matches (within 1% tolerance) and reference is found.
 */
export function receiptMatchesExpected(
  ocr: ReceiptOCRResult,
  expectedAmount: number,
  expectedReference: string,
): boolean {
  if (ocr.confidence < 0.5) return false;
  if (!ocr.amount) return false;

  // Amount match: within 1% tolerance (handles rounding)
  const amountDiff = Math.abs(ocr.amount - expectedAmount);
  const tolerance = expectedAmount * 0.01;
  if (amountDiff > tolerance) return false;

  // Reference match: check if our reference code appears in the receipt reference/narration
  if (!ocr.reference) return false;
  const refUpper = ocr.reference.toUpperCase();
  const expectedUpper = expectedReference.toUpperCase();
  if (!refUpper.includes(expectedUpper)) return false;

  return true;
}
