import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const KEY = process.env.TOKEN_ENCRYPTION_KEY || '';

function getKey(): Buffer {
  if (!KEY) {
    // In development, return tokens unencrypted
    throw new Error('TOKEN_ENCRYPTION_KEY not configured');
  }
  // Key must be 32 bytes for AES-256
  return Buffer.from(KEY, 'hex');
}

/**
 * Encrypt a plaintext token for storage.
 * Returns format: iv:authTag:ciphertext (all hex-encoded)
 */
export function encryptToken(plaintext: string): string {
  try {
    const key = getKey();
    const iv = randomBytes(12);
    const cipher = createCipheriv(ALGORITHM, key, iv);
    let encrypted = cipher.update(plaintext, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const authTag = cipher.getAuthTag().toString('hex');
    return `${iv.toString('hex')}:${authTag}:${encrypted}`;
  } catch {
    // If encryption key not configured, return plaintext (development mode)
    return plaintext;
  }
}

/**
 * Decrypt a stored token.
 * Accepts format: iv:authTag:ciphertext (hex-encoded)
 * Also accepts plaintext (for backwards compatibility with unencrypted tokens)
 */
export function decryptToken(stored: string): string {
  // Check if it's encrypted (contains two colons separating hex values)
  if (!stored.includes(':') || stored.split(':').length !== 3) {
    return stored; // Plaintext — return as-is
  }

  try {
    const key = getKey();
    const [ivHex, authTagHex, ciphertext] = stored.split(':');
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(ciphertext, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch {
    // If decryption fails, assume it's plaintext (migration period)
    return stored;
  }
}
