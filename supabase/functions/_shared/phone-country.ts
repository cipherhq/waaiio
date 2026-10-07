/**
 * Phone-Country Resolver (#261) — canonical shared implementation
 *
 * Uses libphonenumber-js for authoritative E.164 → ISO 3166-1 alpha-2 resolution.
 * Works in both Deno (esm.sh) and Node (npm) runtimes via dynamic import.
 * Same canonical algorithm as lib/channels/phone-country.ts.
 */

type PhoneParser = (phone: string) => { country?: string; isValid(): boolean } | undefined;
let _parsePhoneNumber: PhoneParser | null = null;

async function ensureParser(): Promise<void> {
  if (_parsePhoneNumber) return;
  try {
    // Deno edge function runtime
    // @ts-ignore — esm.sh URL import
    const mod = await import('https://esm.sh/libphonenumber-js@1');
    _parsePhoneNumber = mod.parsePhoneNumber;
  } catch {
    try {
      // Node test/build runtime (npm package)
      const mod = await import('libphonenumber-js');
      _parsePhoneNumber = mod.parsePhoneNumber as unknown as PhoneParser;
    } catch {
      // Neither runtime has the library — return null for all lookups
      _parsePhoneNumber = () => undefined;
    }
  }
}

export async function resolveRecipientCountry(e164Phone: string): Promise<string | null> {
  if (!e164Phone || !e164Phone.startsWith('+')) return null;
  await ensureParser();
  try {
    const parsed = _parsePhoneNumber!(e164Phone);
    if (!parsed || !parsed.country) return null;
    if (!parsed.isValid()) return null;
    return parsed.country;
  } catch {
    return null;
  }
}
