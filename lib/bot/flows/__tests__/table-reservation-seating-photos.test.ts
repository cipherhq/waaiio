/**
 * Issue #892 — WhatsApp table booking shows a table's or section's photos.
 *
 * Owner decisions 2026-11-05: up to 3 optional photos per seat, shown after
 * the customer taps the seat (D1), stored in seating_resources.gallery_urls
 * (D2, M516). Sent once per seat per conversation, before the date list (or
 * before the time list when the date was already given).
 *
 * These tests run the real select_table skipIf and the shared scheduling
 * select_date / select_time prompts against a recording Supabase stub.
 */
import { describe, it, expect, vi } from 'vitest';
import { createMockContext, getStep } from './helpers';
import { tableReservationFlow } from '../table-reservation.flow';
import { schedulingFlow } from '../scheduling.flow';
import type { FlowContext, PromptMessage } from '../types';

const BIZ = 'biz-1';
const P1 = 'https://cdn.example/biz-1/seating/vip-1.jpg';
const P2 = 'https://cdn.example/biz-1/seating/vip-2.jpg';
const P3 = 'https://cdn.example/biz-1/seating/vip-3.jpg';

type TableResult = { data: unknown; error?: unknown } | { throws: Error };
type Cfg = TableResult | ((eqs: Array<[string, unknown]>, cols: string) => TableResult);

/** Recording Supabase stub: every query on a table resolves to its configured result. */
function makeSupabase(tables: Record<string, Cfg>) {
  const calls: Array<{ table: string; cols: string; eqs: Array<[string, unknown]> }> = [];
  const from = vi.fn((table: string) => {
    const rec = { table, cols: '', eqs: [] as Array<[string, unknown]> };
    calls.push(rec);
    const resolveResult = () => {
      const cfg = tables[table];
      const r = typeof cfg === 'function' ? cfg(rec.eqs, rec.cols) : cfg;
      if (!r) return Promise.resolve({ data: [], error: null });
      if ('throws' in r) return Promise.reject(r.throws);
      return Promise.resolve({ data: r.data, error: r.error ?? null });
    };
    const b: Record<string, unknown> = {};
    for (const m of ['in', 'is', 'order', 'limit', 'neq', 'not', 'gte', 'lte', 'gt', 'lt', 'or', 'filter', 'contains', 'range']) b[m] = vi.fn(() => b);
    b.select = vi.fn((cols: string) => { rec.cols = cols; return b; });
    b.eq = vi.fn((col: string, val: unknown) => { rec.eqs.push([col, val]); return b; });
    b.single = vi.fn(resolveResult);
    b.maybeSingle = vi.fn(resolveResult);
    b.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => resolveResult().then(res, rej);
    return b;
  });
  return { client: { from, rpc: vi.fn().mockResolvedValue({ data: null, error: null }) } as unknown, calls };
}

const seatRow = (id: string, name: string) => ({
  id, name, resource_type: 'vip_area', capacity: 6, min_party_size: 2, section: 'Rooftop', deposit_amount: 0,
  reservation_duration_minutes: 90, description: null, available_days: null, available_from: null, available_to: null,
});

/** seating_resources: gallery lookups (select 'gallery_urls') get `gallery`; other reads get `rows`. */
function seating(gallery: (id: unknown) => TableResult, rows: unknown[] = []): Cfg {
  return (eqs, cols) => cols.trim() === 'gallery_urls'
    ? gallery(eqs.find(([c]) => c === 'id')?.[1])
    : { data: rows };
}
const galleryOf = (urls: unknown[]): TableResult => ({ data: { gallery_urls: urls } });

function makeCtx(sessionData: Record<string, unknown>, supabase: unknown): FlowContext {
  const base = createMockContext();
  return createMockContext({
    supabase: supabase as FlowContext['supabase'],
    session: { ...base.session, current_step: '', session_data: sessionData },
    business: {
      ...base.business!, id: BIZ, name: 'Lagos Lounge', flow_type: 'table_reservation' as never, country_code: 'NG',
      operating_hours: {}, metadata: {},
    } as FlowContext['business'],
  });
}

const tappedSeat = (id = 'seat-vip', name = 'VIP Area') => ({
  seating_resource_id: id,
  seating_resource_name: name,
  _is_table_reservation: true,
  _service_max_capacity: 1,
  _service_duration: 90,
});

const imagesOf = (msgs: PromptMessage[]) =>
  msgs.filter((m): m is Extract<PromptMessage, { type: 'image' }> => m.type === 'image');
const urls = (msgs: PromptMessage[]) => imagesOf(msgs).map(m => m.imageUrl);
const seatLookups = (calls: Array<{ table: string; cols: string }>) =>
  calls.filter(c => c.table === 'seating_resources' && c.cols.trim() === 'gallery_urls');

const selectDate = getStep(schedulingFlow, 'select_date');
const selectTime = getStep(schedulingFlow, 'select_time');

describe('#892 table booking shows the tapped seat\'s photos', () => {
  it('B4 after a tap, select_date sends the seat\'s photos first (caption = seat name), then the date question', async () => {
    const { client } = makeSupabase({ seating_resources: seating(() => galleryOf([P1, P2])) });
    const ctx = makeCtx(tappedSeat(), client);

    const msgs = await selectDate.prompt(ctx);

    expect(urls(msgs)).toEqual([P1, P2]);
    expect(msgs[0].type).toBe('image');
    expect(imagesOf(msgs)[0].caption).toBe('VIP Area');
    expect(imagesOf(msgs)[1].caption).toBeUndefined();
    expect(msgs[msgs.length - 1].type).not.toBe('image');
    expect(ctx.session.session_data._seating_gallery_sent_ids).toEqual(['seat-vip']);
  });

  it('B5 single-seat auto-select (select_table skipIf) then select_date shows that seat\'s photos', async () => {
    const { client } = makeSupabase({
      seating_resources: seating(() => galleryOf([P1]), [seatRow('seat-only', 'Garden Booth')]),
    });
    const ctx = makeCtx({}, client);

    const skipped = await getStep(tableReservationFlow, 'select_table').skipIf!(ctx);
    expect(skipped).toBe(true);
    const msgs = await selectDate.prompt(ctx);

    expect(urls(msgs)).toEqual([P1]);
    expect(imagesOf(msgs)[0].caption).toBe('Garden Booth');
  });

  it('B6 back to the same seat (date shown again, then time) does not resend the photos', async () => {
    const { client, calls } = makeSupabase({ seating_resources: seating(() => galleryOf([P1, P2])) });
    const data: Record<string, unknown> = tappedSeat();
    const ctx = makeCtx(data, client);

    expect(urls(await selectDate.prompt(ctx))).toEqual([P1, P2]);
    expect(urls(await selectDate.prompt(ctx))).toEqual([]);
    data.date = '2099-01-06';
    expect(urls(await selectTime.prompt(ctx))).toEqual([]);
    expect(seatLookups(calls)).toHaveLength(1);
  });

  it('B7 a different seat in the same conversation shows its own photos', async () => {
    const OTHER = 'https://cdn.example/biz-1/seating/patio.jpg';
    const { client } = makeSupabase({
      seating_resources: seating(id => galleryOf(id === 'seat-patio' ? [OTHER] : [P1])),
    });
    const data: Record<string, unknown> = tappedSeat();
    const ctx = makeCtx(data, client);

    expect(urls(await selectDate.prompt(ctx))).toEqual([P1]);
    Object.assign(data, { seating_resource_id: 'seat-patio', seating_resource_name: 'Patio' });
    const msgs = await selectDate.prompt(ctx);
    expect(urls(msgs)).toEqual([OTHER]);
    expect(imagesOf(msgs)[0].caption).toBe('Patio');
    expect(data._seating_gallery_sent_ids).toEqual(['seat-vip', 'seat-patio']);
  });

  it('B8 a seat with no photos: no image messages', async () => {
    const { client } = makeSupabase({ seating_resources: seating(() => galleryOf([])) });
    const ctx = makeCtx(tappedSeat(), client);

    const msgs = await selectDate.prompt(ctx);

    expect(urls(msgs)).toEqual([]);
    expect(msgs.length).toBeGreaterThan(0);
  });

  it('at most 3 photos; empty values and duplicates are skipped', async () => {
    const P4 = 'https://cdn.example/biz-1/seating/vip-4.jpg';
    const { client } = makeSupabase({ seating_resources: seating(() => galleryOf([P1, '', P1, null, P2, P3, P4])) });
    const ctx = makeCtx(tappedSeat(), client);

    expect(urls(await selectDate.prompt(ctx))).toEqual([P1, P2, P3]);
  });

  it('B9 lookup error or throw: the date step still works and the seat is not marked', async () => {
    for (const failure of [
      { data: null, error: { code: '42703', message: 'column seating_resources.gallery_urls does not exist' } } as TableResult,
      { throws: new Error('network down') } as TableResult,
    ]) {
      const { client } = makeSupabase({ seating_resources: seating(() => failure) });
      const ctx = makeCtx(tappedSeat(), client);

      const msgs = await selectDate.prompt(ctx);

      expect(urls(msgs)).toEqual([]);
      expect(msgs.length).toBeGreaterThan(0);
      expect(ctx.session.session_data._seating_gallery_sent_ids).toBeUndefined();
    }
  });

  it('B10 the photo lookup is scoped to the seat and the business', async () => {
    const { client, calls } = makeSupabase({ seating_resources: seating(() => galleryOf([P1])) });
    await selectDate.prompt(makeCtx(tappedSeat(), client));

    expect(seatLookups(calls)[0]).toBeDefined();
    const lookup = calls.find(c => c.table === 'seating_resources' && c.cols.trim() === 'gallery_urls')!;
    expect(lookup.eqs).toEqual(expect.arrayContaining([['id', 'seat-vip'], ['business_id', BIZ]]));
  });

  it('date already given (select_date skipped): select_time sends the photos before the time list', async () => {
    const { client } = makeSupabase({ seating_resources: seating(() => galleryOf([P1])) });
    const ctx = makeCtx({ ...tappedSeat(), date: '2099-01-06' }, client);

    const msgs = await selectTime.prompt(ctx);

    expect(urls(msgs)).toEqual([P1]);
    expect(msgs[0].type).toBe('image');
    expect(msgs[msgs.length - 1].type).not.toBe('image');
  });

  it('D3 date and time already given (both skipped): the party-size question shows the photos first', async () => {
    const { client } = makeSupabase({ seating_resources: seating(() => galleryOf([P1, P2])) });
    const ctx = makeCtx({ ...tappedSeat(), date: '2099-01-06', time: '20:00', _seating_min_party: 2, _seating_capacity: 6 }, client);

    const msgs = await getStep(schedulingFlow, 'select_quantity').prompt(ctx);

    expect(urls(msgs)).toEqual([P1, P2]);
    expect(imagesOf(msgs)[0].caption).toBe('VIP Area');
    expect(msgs[msgs.length - 1].type).toBe('buttons');
  });

  it('D3 photos already shown at the date step are not repeated at party size', async () => {
    const { client, calls } = makeSupabase({ seating_resources: seating(() => galleryOf([P1])) });
    const ctx = makeCtx({ ...tappedSeat(), _seating_min_party: 2, _seating_capacity: 6 }, client);

    expect(urls(await selectDate.prompt(ctx))).toEqual([P1]);
    const msgs = await getStep(schedulingFlow, 'select_quantity').prompt(ctx);
    expect(urls(msgs)).toEqual([]);
    expect(msgs.map(m => m.type)).toEqual(['buttons']);
    expect(seatLookups(calls)).toHaveLength(1);
  });

  it('B11 services are unchanged: a service booking gets the service gallery and no seating lookup', async () => {
    const SVC = 'https://cdn.example/biz-1/services/cut.jpg';
    const { client, calls } = makeSupabase({
      services: { data: { gallery_urls: [SVC] } },
      seating_resources: seating(() => galleryOf([P1])),
    });
    const ctx = makeCtx({ service_id: 'svc-1', _service_duration: 30, _service_max_capacity: 1 }, client);

    const msgs = await selectDate.prompt(ctx);

    expect(urls(msgs)).toEqual([SVC]);
    expect(seatLookups(calls)).toHaveLength(0);
  });
});
