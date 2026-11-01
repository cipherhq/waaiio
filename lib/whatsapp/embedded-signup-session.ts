import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { Redis } from '@upstash/redis';

export interface SignupAccount {
  waba_id: string;
  waba_name: string;
  phones: Array<{ id: string; display_phone_number: string; verified_name: string; quality_rating: string }>;
}
interface SignupSession {
  accessToken: string;
  tokenExpiresAt: string | null;
  accounts: SignupAccount[];
  expiresAt: number;
}
const TTL_SECONDS = 600;
function config() {
  const key = process.env.TOKEN_ENCRYPTION_KEY || '';
  const appId = process.env.NEXT_PUBLIC_META_APP_ID || process.env.META_APP_ID;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!/^[a-f\d]{64}$/i.test(key) || !appId || !url || !token) {
    throw new Error('Embedded signup session storage is not configured');
  }
  return { key: Buffer.from(key, 'hex'), appId, redis: new Redis({ url, token }) };
}
export function assertSignupSessionConfigured() { config(); }
function sessionKey(appId: string, userId: string, businessId: string, id: string) {
  return `wa-signup:${appId}:${userId}:${businessId}:${id}`;
}
export async function createSignupSession(userId: string, businessId: string, data: Omit<SignupSession, 'expiresAt'>) {
  const { key, appId, redis } = config();
  const id = randomBytes(32).toString('hex');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const storageKey = sessionKey(appId, userId, businessId, id);
  cipher.setAAD(Buffer.from(storageKey));
  const encrypted = Buffer.concat([cipher.update(JSON.stringify({ ...data, expiresAt: Date.now() + TTL_SECONDS * 1000 }), 'utf8'), cipher.final()]);
  const value = Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
  await redis.set(storageKey, value, { ex: TTL_SECONDS });
  return id;
}
export async function consumeSignupSession(userId: string, businessId: string, id: string): Promise<SignupSession | null> {
  if (!/^[a-f\d]{64}$/i.test(id)) return null;
  const { key, appId, redis } = config();
  const storageKey = sessionKey(appId, userId, businessId, id);
  // Atomic consume: parallel callbacks and replays cannot activate twice.
  const value = await redis.getdel<string>(storageKey);
  if (!value) return null;
  const bytes = Buffer.from(value, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
  decipher.setAAD(Buffer.from(storageKey));
  decipher.setAuthTag(bytes.subarray(12, 28));
  const session: SignupSession = JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8'));
  if (session.expiresAt <= Date.now() || (session.tokenExpiresAt && Date.parse(session.tokenExpiresAt) <= Date.now())) return null;
  return session;
}
