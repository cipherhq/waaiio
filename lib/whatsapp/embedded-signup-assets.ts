import type { SignupAccount } from './embedded-signup-session';

/** Follow opaque cursors only; never forward credentials to a paging URL. */
export async function listSignupPhones(accountId: string, token: string): Promise<SignupAccount['phones']> {
  const phones: SignupAccount['phones'] = [];
  const seen = new Set<string>();
  let after = '';
  for (let page = 0; page < 100; page++) {
    const url = new URL(`https://graph.facebook.com/v22.0/${encodeURIComponent(accountId)}/phone_numbers`);
    url.search = new URLSearchParams({ fields: 'id,display_phone_number,verified_name,quality_rating', limit: '100', ...(after ? { after } : {}) }).toString();
    const response = await fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' });
    if (!response.ok) throw new Error('Unable to read shared WhatsApp numbers');
    const body = await response.json();
    if (!Array.isArray(body.data)) throw new Error('Invalid WhatsApp number response');
    phones.push(...body.data);
    if (!body.paging?.next) return phones;
    after = body.paging?.cursors?.after;
    if (!after || seen.has(after)) throw new Error('Invalid WhatsApp pagination');
    seen.add(after);
  }
  throw new Error('WhatsApp number discovery exceeded page limit');
}
