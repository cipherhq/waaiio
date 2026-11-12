/**
 * Shared fixtures for tests of the staging WhatsApp routing rule (Owner rule
 * 2026-11-10): the designated staging number, two competing shared numbers,
 * broken variants of the designated row, an environment switch, and a query
 * recorder that proves the exact production query chain.
 */
import { STAGING_APP_PROJECT_ID, STAGING_SUPABASE_URL } from '@/lib/staging-test-mode';
import { STAGING_SHARED_WHATSAPP_CHANNEL } from '@/lib/channels/staging-whatsapp-routing';
import type { MemoryDb } from './memory-db';

type Row = Record<string, unknown>;

export const DESIGNATED_ID = STAGING_SHARED_WHATSAPP_CHANNEL.id;

export const designated = (over: Row = {}): Row => ({
  id: DESIGNATED_ID, country_code: 'US', phone_number: '12404712139', phone_number_id: 'pnid-staging',
  channel_type: 'shared', business_id: null, is_active: true, connection_status: 'active',
  provider: 'meta_cloud', waba_id: 'waba-staging', meta_access_token: 'tok-staging',
  meta_token_expires_at: null, created_at: '2026-09-25T16:18:12Z', ...over,
});
/** Another active US shared number: staging must never choose it. Older than the designated row. */
export const otherUs = (): Row => designated({
  id: 'other-us', phone_number: '12025550100', phone_number_id: 'pnid-us2', waba_id: 'waba-us2',
  meta_access_token: 'tok-us2', created_at: '2026-01-01T00:00:00Z',
});
/** A country-local Nigerian shared number: staging must never choose it. Oldest row. */
export const localNg = (): Row => designated({
  id: 'local-ng', country_code: 'NG', phone_number: '2348000000000', phone_number_id: 'pnid-ng', waba_id: 'waba-ng',
  meta_access_token: 'tok-ng', created_at: '2025-06-01T00:00:00Z',
});
/** Competing numbers first, so a naive "first shared row" pick would choose one of them. */
export const allShared = (): Row[] => [localNg(), otherUs(), designated()];

/** The designated row in every state that must fail closed (plus "missing"). */
export const BROKEN_DESIGNATED: Array<[string, Row[]]> = [
  ['missing', [localNg(), otherUs()]],
  ['owned by a business', [localNg(), otherUs(), designated({ business_id: 'biz-x' })]],
  ['disconnected', [localNg(), otherUs(), designated({ connection_status: 'disconnected' })]],
  ['inactive', [localNg(), otherUs(), designated({ is_active: false })]],
  ['a different phone number', [localNg(), otherUs(), designated({ phone_number: '12025559999' })]],
  ['not shared', [localNg(), otherUs(), designated({ channel_type: 'dedicated' })]],
];

const ENV = ['WAAIIO_ENVIRONMENT', 'VERCEL_PROJECT_ID', 'NEXT_PUBLIC_SUPABASE_URL'] as const;
export function saveEnv(): () => void {
  const saved = Object.fromEntries(ENV.map(k => [k, process.env[k]]));
  return () => {
    for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  };
}
export function setStaging(on: boolean): void {
  if (on) {
    process.env.WAAIIO_ENVIRONMENT = 'staging';
    process.env.VERCEL_PROJECT_ID = STAGING_APP_PROJECT_ID;
    process.env.NEXT_PUBLIC_SUPABASE_URL = STAGING_SUPABASE_URL;
  } else {
    process.env.WAAIIO_ENVIRONMENT = 'production';
    process.env.VERCEL_PROJECT_ID = 'prj_PRODUCTION';
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://cxcmiqotkowhxinjbytg.supabase.co';
  }
}

export type Call = [string, ...unknown[]];
export interface Recorded { client: MemoryDb; log: Array<{ table: string; calls: Call[] }> }

/** Wraps a memory db so every builder call is logged per query, in order. */
export function record(db: MemoryDb): Recorded {
  const log: Recorded['log'] = [];
  const client: MemoryDb = {
    ...db,
    from(table: string) {
      const q = db.from(table);
      const entry = { table, calls: [] as Call[] };
      log.push(entry);
      const proxy: unknown = new Proxy(q, {
        get(target, prop) {
          const value = target[prop];
          if (typeof value !== 'function' || prop === 'then') return value;
          return (...args: unknown[]) => {
            entry.calls.push([String(prop), ...args]);
            const out = value.apply(target, args);
            return out === target ? proxy : out;
          };
        },
      });
      return proxy;
    },
  };
  return { client, log };
}

/** The call chains of every whatsapp_channels query, in order. */
export const channelChains = (r: Recorded): Call[][] =>
  r.log.filter(e => e.table === 'whatsapp_channels').map(e => e.calls);
