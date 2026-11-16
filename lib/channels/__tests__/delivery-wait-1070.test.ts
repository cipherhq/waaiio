/**
 * #1070: bounded WhatsApp delivery waits. Real delivery-wait module and real Meta
 * webhook route; only the database (an in-memory whatsapp_delivery_waits table)
 * and the clock are faked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import {
  advanceDeliveryWait,
  awaitWhatsAppDelivery,
  DeliveryWaitBudget,
  trackMediaDeliveries,
} from '@/lib/channels/delivery-wait';
import type { MessageSender } from '@/lib/channels/message-sender';

type Row = { wamid: string; status: string };

/** Minimal PostgREST-shaped fake for whatsapp_delivery_waits. */
function fakeDb(opts: { failSelect?: boolean; throwAll?: boolean } = {}) {
  const rows = new Map<string, Row>();
  const log: string[] = [];
  const db = {
    rows,
    log,
    from(table: string) {
      if (opts.throwAll) throw new Error('db down');
      if (table !== 'whatsapp_delivery_waits') return {};
      return {
        upsert(row: Row, o: { onConflict: string; ignoreDuplicates: boolean }) {
          log.push(`upsert:${row.wamid}`);
          expect(o).toEqual({ onConflict: 'wamid', ignoreDuplicates: true });
          if (!rows.has(row.wamid)) rows.set(row.wamid, { ...row });
          return Promise.resolve({ error: null });
        },
        select() {
          return {
            in(_col: string, ids: string[]) {
              log.push('select');
              if (opts.failSelect) return Promise.resolve({ data: null, error: { message: 'boom' } });
              return Promise.resolve({ data: ids.filter(id => rows.has(id)).map(id => ({ ...rows.get(id)! })), error: null });
            },
          };
        },
        update(patch: { status: string }) {
          return {
            eq(_c: string, wamid: string) {
              return {
                in(_c2: string, from: string[]) {
                  const row = rows.get(wamid);
                  if (row && from.includes(row.status)) row.status = patch.status;
                  return Promise.resolve({ error: null });
                },
              };
            },
          };
        },
        delete() {
          return {
            in(_c: string, ids: string[]) {
              log.push(`delete:${ids.join(',')}`);
              ids.forEach(id => rows.delete(id));
              return Promise.resolve({ error: null });
            },
          };
        },
      };
    },
  };
  return db;
}

/** Fake clock: sleep() advances time and lets a scripted event fire. */
function clock(onTick?: (t: number) => void) {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms: number) => { t += ms; onTick?.(t); },
    get elapsed() { return t; },
  };
}

describe('#1070 awaitWhatsAppDelivery', () => {
  it('returns as soon as the message is delivered, then deletes its row', async () => {
    const db = fakeDb();
    const c = clock(t => { if (t >= 800) db.rows.get('wamid.A')!.status = 'delivered'; });
    const result = await awaitWhatsAppDelivery(db as never, ['wamid.A'], { sleep: c.sleep, now: c.now });
    expect(result).toBe('settled');
    expect(c.elapsed).toBe(800);
    expect(db.log[0]).toBe('upsert:wamid.A');
    expect(db.log.at(-1)).toBe('delete:wamid.A');
    expect(db.rows.size).toBe(0);
  });

  it('treats failed (and read) as settled', async () => {
    const db = fakeDb();
    db.rows.set('wamid.F', { wamid: 'wamid.F', status: 'failed' });
    db.rows.set('wamid.R', { wamid: 'wamid.R', status: 'read' });
    const c = clock();
    expect(await awaitWhatsAppDelivery(db as never, ['wamid.F', 'wamid.R'], { sleep: c.sleep, now: c.now })).toBe('settled');
    expect(c.elapsed).toBe(0);
  });

  it('waits for every message of a group', async () => {
    const db = fakeDb();
    const c = clock(t => {
      if (t >= 400) db.rows.get('wamid.1')!.status = 'delivered';
      if (t >= 1200) db.rows.get('wamid.2')!.status = 'read';
    });
    expect(await awaitWhatsAppDelivery(db as never, ['wamid.1', 'wamid.2', 'wamid.1'], { sleep: c.sleep, now: c.now })).toBe('settled');
    expect(c.elapsed).toBe(1200);
  });

  it('times out without throwing and still deletes the row', async () => {
    const db = fakeDb();
    const c = clock();
    const result = await awaitWhatsAppDelivery(db as never, ['wamid.T'], { timeoutMs: 2000, sleep: c.sleep, now: c.now });
    expect(result).toBe('timeout');
    expect(c.elapsed).toBe(2000);
    expect(db.rows.size).toBe(0);
  });

  it('respects the shared total budget across waits', async () => {
    const db = fakeDb();
    const c = clock();
    const budget = new DeliveryWaitBudget(5000);
    expect(await awaitWhatsAppDelivery(db as never, ['wamid.1'], { timeoutMs: 3000, budget, sleep: c.sleep, now: c.now })).toBe('timeout');
    expect(budget.remainingMs()).toBe(2000);
    expect(await awaitWhatsAppDelivery(db as never, ['wamid.2'], { timeoutMs: 3000, budget, sleep: c.sleep, now: c.now })).toBe('timeout');
    expect(c.elapsed).toBe(5000);
    expect(budget.remainingMs()).toBe(0);
    // Budget exhausted: no wait at all.
    expect(await awaitWhatsAppDelivery(db as never, ['wamid.3'], { timeoutMs: 3000, budget, sleep: c.sleep, now: c.now })).toBe('skipped');
    expect(c.elapsed).toBe(5000);
  });

  it('does not wait when nothing can be observed (no wamid, no db, read error, db throws)', async () => {
    const c = clock();
    expect(await awaitWhatsAppDelivery(fakeDb() as never, [undefined, ''], { sleep: c.sleep, now: c.now })).toBe('skipped');
    expect(await awaitWhatsAppDelivery(null, ['wamid.X'], { sleep: c.sleep, now: c.now })).toBe('skipped');
    expect(await awaitWhatsAppDelivery(fakeDb({ failSelect: true }) as never, ['wamid.X'], { sleep: c.sleep, now: c.now })).toBe('skipped');
    expect(await awaitWhatsAppDelivery(fakeDb({ throwAll: true }) as never, ['wamid.X'], { sleep: c.sleep, now: c.now })).toBe('skipped');
    expect(c.elapsed).toBe(0);
  });
});

describe('#1070 advanceDeliveryWait', () => {
  it('advances only existing rows, only forward, and failed always wins', async () => {
    const db = fakeDb();
    db.rows.set('wamid.A', { wamid: 'wamid.A', status: 'sent' });
    await advanceDeliveryWait(db as never, 'wamid.UNKNOWN', 'delivered');
    expect(db.rows.has('wamid.UNKNOWN')).toBe(false);

    await advanceDeliveryWait(db as never, 'wamid.A', 'read');
    expect(db.rows.get('wamid.A')!.status).toBe('read');
    await advanceDeliveryWait(db as never, 'wamid.A', 'delivered'); // late, out of order
    expect(db.rows.get('wamid.A')!.status).toBe('read');
    await advanceDeliveryWait(db as never, 'wamid.A', 'sent');
    expect(db.rows.get('wamid.A')!.status).toBe('read');
    await advanceDeliveryWait(db as never, 'wamid.A', 'failed');
    expect(db.rows.get('wamid.A')!.status).toBe('failed');
    await advanceDeliveryWait(db as never, 'wamid.A', 'read');
    expect(db.rows.get('wamid.A')!.status).toBe('failed');
  });

  it('never throws on database errors', async () => {
    await expect(advanceDeliveryWait(fakeDb({ throwAll: true }) as never, 'wamid.A', 'delivered')).resolves.toBeUndefined();
  });
});

describe('#1070 trackMediaDeliveries', () => {
  it('registers image/document WAMIDs at once and leaves other sends untouched', async () => {
    const db = fakeDb();
    const sends: string[] = [];
    const inner = {
      sendText: async () => { sends.push('text'); return { messageId: 'wamid.text' }; },
      sendImage: async () => { sends.push('image'); return { messageId: 'wamid.img' }; },
      sendDocument: async () => { sends.push('doc'); return { messageId: 'wamid.doc' }; },
    } as unknown as MessageSender;
    const tracked = trackMediaDeliveries(inner, db as never);
    await tracked.sender.sendText({ to: '1', text: 'x' });
    await tracked.sender.sendDocument({ to: '1', documentUrl: 'u', filename: 'f' });
    await tracked.sender.sendImage({ to: '1', imageUrl: 'u' });
    expect(sends).toEqual(['text', 'doc', 'image']);
    expect([...db.rows.keys()]).toEqual(['wamid.doc', 'wamid.img']);
    expect(tracked.take()).toEqual(['wamid.doc', 'wamid.img']);
    expect(tracked.take()).toEqual([]);
  });
});

// ── Webhook route: real handler, in-memory delivery-wait table ──

describe('#1070 Meta status webhook advances delivery waits', { timeout: 60_000 }, () => {
  let db: ReturnType<typeof fakeDb>;

  function statusBody(statuses: Array<{ id: string; status: string }>) {
    return {
      object: 'whatsapp_business_account',
      entry: [{ id: 'waba', changes: [{ field: 'messages', value: {
        messaging_product: 'whatsapp',
        metadata: { phone_number_id: 'pnid', display_phone_number: '1' },
        statuses: statuses.map(s => ({ ...s, timestamp: '1753383000' })),
      } }] }],
    };
  }
  async function post(statuses: Array<{ id: string; status: string }>) {
    const { POST } = await import('@/app/api/webhook/meta-cloud/route');
    return POST(new NextRequest('https://www.waaiio.com/api/webhook/meta-cloud', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-hub-signature-256': 'sha256=test' },
      body: JSON.stringify(statusBody(statuses)),
    }));
  }

  beforeEach(() => {
    vi.resetModules();
    db = fakeDb();
    process.env.META_APP_SECRET = 'test-secret';
    vi.doMock('crypto', async () => {
      const actual = await vi.importActual<typeof import('crypto')>('crypto');
      return { ...actual, createHmac: () => ({ update: () => ({ digest: () => 'test' }) }), timingSafeEqual: () => true };
    });
    // Every other status consumer sees "no matching row"; the wait table is the fake.
    const nothing: any = new Proxy(() => nothing, {
      get: (_t, p) => (p === 'then' ? (r: (v: unknown) => void) => r({ data: null, error: null }) : nothing),
      apply: () => nothing,
    });
    vi.doMock('@/lib/supabase/service', () => ({
      createServiceClient: () => ({
        from: (table: string) => (table === 'whatsapp_delivery_waits' ? db.from(table) : nothing),
        rpc: () => Promise.resolve({ data: null, error: null }),
      }),
    }));
  });

  afterEach(() => {
    vi.doUnmock('crypto');
    vi.doUnmock('@/lib/supabase/service');
    delete process.env.META_APP_SECRET;
  });

  it('moves known WAMIDs forward, ignores unknown ones, failed wins', async () => {
    db.rows.set('wamid.K', { wamid: 'wamid.K', status: 'sent' });
    db.rows.set('wamid.F', { wamid: 'wamid.F', status: 'read' });
    const res = await post([
      { id: 'wamid.K', status: 'delivered' },
      { id: 'wamid.U', status: 'delivered' },
      { id: 'wamid.F', status: 'failed' },
    ]);
    expect(res.status).toBe(200);
    expect(db.rows.get('wamid.K')!.status).toBe('delivered');
    expect(db.rows.get('wamid.F')!.status).toBe('failed');
    expect(db.rows.has('wamid.U')).toBe(false);

    await post([{ id: 'wamid.K', status: 'sent' }]);
    expect(db.rows.get('wamid.K')!.status).toBe('delivered');
  });

  it('a delivery-wait database failure does not fail the webhook', async () => {
    db = fakeDb({ throwAll: true });
    const res = await post([{ id: 'wamid.K', status: 'delivered' }]);
    expect(res.status).toBe(200);
  });
});
