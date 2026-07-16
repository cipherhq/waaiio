/**
 * One-time script to encrypt existing plaintext meta_access_tokens
 * in whatsapp_channels.
 *
 * Usage: npx tsx scripts/backfill-encrypt-tokens.ts
 *
 * Requires:
 *   - SUPABASE_SERVICE_ROLE_KEY env var
 *   - NEXT_PUBLIC_SUPABASE_URL env var
 *   - TOKEN_ENCRYPTION_KEY env var
 */

import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const encryptionKey = process.env.TOKEN_ENCRYPTION_KEY;

if (!supabaseUrl || !serviceKey) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}
if (!encryptionKey || encryptionKey.length !== 64) {
  console.error('Missing or invalid TOKEN_ENCRYPTION_KEY (must be 64 hex chars)');
  process.exit(1);
}

// Inline encryption to avoid import path issues in standalone script
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

const KEY = Buffer.from(encryptionKey, 'hex');

function encryptToken(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', KEY, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

function isAlreadyEncrypted(value: string): boolean {
  // Encrypted format: iv(24hex):authTag(32hex):ciphertext(hex)
  const parts = value.split(':');
  if (parts.length < 3) return false;
  const [iv, tag] = parts;
  return iv.length === 24 && tag.length === 32 && /^[0-9a-f]+$/.test(iv) && /^[0-9a-f]+$/.test(tag);
}

async function main() {
  const supabase = createClient(supabaseUrl!, serviceKey!);

  // Fetch all channels with meta_access_token
  const { data: channels, error } = await supabase
    .from('whatsapp_channels')
    .select('id, meta_access_token, business_id')
    .not('meta_access_token', 'is', null)
    .eq('provider', 'meta_cloud');

  if (error) {
    console.error('Failed to fetch channels:', error.message);
    process.exit(1);
  }

  if (!channels || channels.length === 0) {
    console.log('No channels with meta_access_token found.');
    return;
  }

  console.log(`Found ${channels.length} channels with tokens.`);

  let encrypted = 0;
  let skipped = 0;
  let errors = 0;

  for (const channel of channels) {
    const token = channel.meta_access_token;
    if (!token) { skipped++; continue; }

    // Skip if already encrypted
    if (isAlreadyEncrypted(token)) {
      console.log(`  [SKIP] Channel ${channel.id} — already encrypted`);
      skipped++;
      continue;
    }

    try {
      const encryptedToken = encryptToken(token);

      const { error: updateError } = await supabase
        .from('whatsapp_channels')
        .update({ meta_access_token: encryptedToken })
        .eq('id', channel.id);

      if (updateError) {
        console.error(`  [ERROR] Channel ${channel.id}:`, updateError.message);
        errors++;
      } else {
        console.log(`  [OK] Channel ${channel.id} (business: ${channel.business_id}) — encrypted`);
        encrypted++;
      }
    } catch (err) {
      console.error(`  [ERROR] Channel ${channel.id}:`, err);
      errors++;
    }
  }

  console.log(`\nDone. Encrypted: ${encrypted}, Skipped: ${skipped}, Errors: ${errors}`);
}

main();
