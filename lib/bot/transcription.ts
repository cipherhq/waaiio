import Anthropic from '@anthropic-ai/sdk';
import { logger } from '@/lib/logger';

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!client) client = new Anthropic();
  return client;
}

// In-memory cache: cacheKey → transcription
const cache = new Map<string, { text: string; expiry: number }>();
const CACHE_TTL = 60 * 60 * 1000; // 1 hour

/**
 * Transcribe an audio buffer using Claude.
 * Returns the transcribed text, or null if transcription fails.
 *
 * Uses Claude's native audio input support — no separate Whisper API needed.
 * Requires ANTHROPIC_API_KEY (already set for intent detection).
 */
export async function transcribeAudio(
  audioBuffer: Buffer,
  mimeType: string = 'audio/ogg',
  cacheKey?: string,
): Promise<string | null> {
  if (!process.env.ANTHROPIC_API_KEY) {
    return null;
  }

  // Check cache
  if (cacheKey) {
    const cached = cache.get(cacheKey);
    if (cached && cached.expiry > Date.now()) {
      return cached.text;
    }
  }

  try {
    const anthropic = getClient();

    // Map MIME types to Claude's supported audio media types
    const mediaType = mimeType.includes('ogg') ? 'audio/ogg'
      : mimeType.includes('webm') ? 'audio/webm'
      : mimeType.includes('mp4') ? 'audio/mp4'
      : mimeType.includes('mpeg') ? 'audio/mpeg'
      : mimeType.includes('wav') ? 'audio/wav'
      : 'audio/ogg';

    const base64Audio = audioBuffer.toString('base64');

    // Audio content block is supported by the API but not yet in SDK types
    const audioBlock = {
      type: 'audio' as const,
      source: {
        type: 'base64' as const,
        media_type: mediaType,
        data: base64Audio,
      },
    };

    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      messages: [
        {
          role: 'user',
          content: [
            audioBlock as unknown as Anthropic.TextBlockParam,
            {
              type: 'text',
              text: 'Transcribe this audio message exactly as spoken. Return ONLY the transcription, no commentary or labels. If the audio is empty or unintelligible, return an empty string.',
            },
          ],
        },
      ],
    });

    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map(block => block.text)
      .join('')
      .trim();

    if (!text) return null;

    // Cache result
    if (cacheKey) {
      cache.set(cacheKey, { text, expiry: Date.now() + CACHE_TTL });

      // Prune cache if too large
      if (cache.size > 200) {
        const now = Date.now();
        for (const [key, val] of cache) {
          if (val.expiry < now) cache.delete(key);
        }
      }
    }

    logger.info(`[AI-COST] claude-transcription: audio_bytes=${audioBuffer.length} text_length=${text.length}`);
    return text;
  } catch (error) {
    logger.error('[TRANSCRIPTION] Claude audio error:', (error as Error).message);
    return null;
  }
}
