import OpenAI from 'openai';
import { logger } from '@/lib/logger';

let client: OpenAI | null = null;
function getClient(): OpenAI {
  if (!client) client = new OpenAI();
  return client;
}

// In-memory cache: audioUrl hash → transcription
const cache = new Map<string, { text: string; expiry: number }>();
const CACHE_TTL = 60 * 60 * 1000; // 1 hour

/**
 * Transcribe an audio buffer using OpenAI Whisper.
 * Returns the transcribed text, or null if transcription fails.
 *
 * Cost: ~$0.006/minute of audio (~$0.0015 per avg 15s voice message)
 */
export async function transcribeAudio(
  audioBuffer: Buffer,
  mimeType: string = 'audio/ogg',
  cacheKey?: string,
): Promise<string | null> {
  // Check API key
  if (!process.env.OPENAI_API_KEY) {
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
    const openai = getClient();

    // Determine file extension from MIME type
    const ext = mimeType.includes('ogg') ? 'ogg'
      : mimeType.includes('webm') ? 'webm'
      : mimeType.includes('mp4') ? 'mp4'
      : mimeType.includes('mpeg') ? 'mp3'
      : 'ogg';

    // Create a File-like object for the API (convert Buffer to Uint8Array for compatibility)
    const file = new File([new Uint8Array(audioBuffer)], `voice.${ext}`, { type: mimeType });

    const response = await openai.audio.transcriptions.create({
      model: 'whisper-1',
      file,
      response_format: 'text',
    });

    const text = (typeof response === 'string' ? response : (response as unknown as { text?: string }).text || '').trim();

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

    logger.info(`[AI-COST] whisper: audio_bytes=${audioBuffer.length} text_length=${text.length}`);
    return text;
  } catch (error) {
    logger.error('[TRANSCRIPTION] Whisper error:', (error as Error).message);
    return null;
  }
}
