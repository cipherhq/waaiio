import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
// #1005 PR 3c: publishing the reusable party RSVP form. One Meta asset per account and form
// version, no automatic retries, unclear outcomes left for review, and its own switch.
import { publishPartyRsvpFlow, partyRsvpFlowPublicationStatus, type PartyRsvpFlowAssets } from '@/lib/parties/rsvp-flow-publisher';
import { partyRsvpFlowJson, partyRsvpFlowRevision } from '@/lib/parties/rsvp-flow';
import { createFlowAsset, getFlowStatus } from '@/lib/whatsapp-forms/meta-flow-asset';
import { partyRsvpFormsEnabled } from '@/lib/whatsapp-forms/release-gate';
import { MetaCloudService } from '@/lib/channels/meta-cloud';

const WABA = '555000';
type Row = Record<string, any>;

/** Minimal in-memory stand-in for the M540 publications table, with its unique (waba_id, revision). */
function fakeDb(opts: { failLookup?: boolean; raceInsert?: boolean } = {}) {
  const rows: Row[] = [];
  const db = {
    rows,
    from: (table: string) => {
      expect(table).toBe('party_rsvp_flow_publications');
      const filters: [string, string, unknown][] = [];
      let op: 'select' | 'insert' | 'update' = 'select'; let values: Row = {};
      const match = (r: Row) => filters.every(([k, how, v]) => how === 'eq' ? r[k] === v : r[k] !== v);
      const q: any = {
        select: () => q, eq: (k: string, v: unknown) => { filters.push([k, 'eq', v]); return q; },
        neq: (k: string, v: unknown) => { filters.push([k, 'neq', v]); return q; },
        insert: (v: Row) => { op = 'insert'; values = v; return q; },
        update: (v: Row) => { op = 'update'; values = v; return q; },
        maybeSingle: async () => opts.failLookup ? { data: null, error: { message: 'down' } } : { data: rows.find(match) ?? null, error: null },
        single: async () => {
          if (opts.raceInsert || rows.some(r => r.waba_id === values.waba_id && r.revision === values.revision))
            return { data: null, error: { code: '23505' } };
          const row = { id: `pub-${rows.length + 1}`, status: 'creating', meta_flow_id: null, ...values };
          rows.push(row); return { data: row, error: null };
        },
        then: (ok: (v: unknown) => unknown) => {
          const hit = rows.filter(match);
          if (op === 'update') hit.forEach(r => Object.assign(r, values));
          return Promise.resolve({ data: hit.map(r => ({ id: r.id })), error: null }).then(ok);
        },
      };
      return q;
    },
  };
  return db;
}

function fakeAssets(state: { status?: string; waba?: string } = {}) {
  let status = state.status ?? 'DRAFT';
  const assets = {
    create: vi.fn(async (name: string) => ({ flowId: '9001', name, status: 'DRAFT' })),
    upload: vi.fn(async (flowId: string) => ({ flowId, success: true })),
    publish: vi.fn(async (flowId: string) => { status = 'PUBLISHED'; return { flowId, success: true }; }),
    status: vi.fn(async (flowId: string) => ({ flowId, name: 'x', status, categories: ['OTHER'], wabaId: state.waba ?? WABA })),
  };
  return assets as typeof assets & PartyRsvpFlowAssets;
}

beforeEach(() => { vi.stubEnv('WHATSAPP_PARTY_RSVP_FORMS_ENABLED', 'true'); vi.stubEnv('WHATSAPP_NATIVE_FORMS_ENABLED', ''); });
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('publishPartyRsvpFlow', () => {
  it('does nothing while the RSVP form switch is off', async () => {
    vi.stubEnv('WHATSAPP_PARTY_RSVP_FORMS_ENABLED', '');
    const db = fakeDb(); const assets = fakeAssets();
    expect(await publishPartyRsvpFlow(db as never, WABA, assets)).toEqual({ status: 'not_enabled' });
    expect(db.rows).toHaveLength(0); expect(assets.create).not.toHaveBeenCalled();
  });

  it('creates one asset, uploads the static Flow, publishes and verifies the account', async () => {
    const db = fakeDb(); const assets = fakeAssets();
    const out = await publishPartyRsvpFlow(db as never, WABA, assets);
    expect(out).toEqual({ status: 'published', publicationId: 'pub-1', metaFlowId: '9001', alreadyPublished: false });
    expect(assets.create).toHaveBeenCalledTimes(1);
    expect(assets.create.mock.calls[0][0]).toBe(`Waaiio party RSVP ${partyRsvpFlowRevision().slice(0, 12)}`);
    expect(assets.upload).toHaveBeenCalledWith('9001', partyRsvpFlowJson());
    expect(db.rows[0]).toMatchObject({ waba_id: WABA, revision: partyRsvpFlowRevision(), status: 'published', meta_flow_id: '9001' });
    expect(db.rows[0].published_at).toBeTruthy();
    // A second call reuses it without touching Meta.
    const again = fakeAssets();
    expect(await publishPartyRsvpFlow(db as never, WABA, again)).toMatchObject({ status: 'published', alreadyPublished: true });
    expect(again.create).not.toHaveBeenCalled(); expect(again.status).not.toHaveBeenCalled();
  });

  it('a rejected layout is left for review with Meta\'s validation messages, and never retried on its own', async () => {
    const db = fakeDb(); const assets = fakeAssets();
    assets.upload.mockResolvedValueOnce({ flowId: '9001', success: false,
      validationErrors: [{ error: 'INVALID_PROPERTY', error_type: 'INVALID_PROPERTY_VALUE', message: 'required must be boolean' }] } as never);
    const out = await publishPartyRsvpFlow(db as never, WABA, assets);
    expect(out).toMatchObject({ status: 'needs_review', validationErrors: [{ type: 'INVALID_PROPERTY_VALUE', message: 'required must be boolean' }] });
    expect(assets.publish).not.toHaveBeenCalled();
    expect(db.rows[0]).toMatchObject({ status: 'needs_review', meta_flow_id: '9001' });
    const again = fakeAssets();
    expect(await publishPartyRsvpFlow(db as never, WABA, again)).toMatchObject({ status: 'needs_review' });
    expect(again.create).not.toHaveBeenCalled(); expect(again.upload).not.toHaveBeenCalled();
  });

  it('an unclear create is never resumed, so a second asset is never made', async () => {
    const db = fakeDb(); const assets = fakeAssets();
    assets.create.mockRejectedValueOnce(new Error('timeout'));
    expect(await publishPartyRsvpFlow(db as never, WABA, assets)).toMatchObject({ status: 'needs_review', reason: expect.stringContaining('Check Meta') });
    expect(db.rows[0]).toMatchObject({ status: 'needs_review', meta_flow_id: null });
    const again = fakeAssets();
    expect(await publishPartyRsvpFlow(db as never, WABA, again, { resume: true })).toMatchObject({ status: 'needs_review' });
    expect(again.create).not.toHaveBeenCalled();
  });

  it('resume finishes the same asset after a failed publish, or just records it when Meta already published', async () => {
    const db = fakeDb(); const assets = fakeAssets();
    assets.publish.mockRejectedValueOnce(new Error('502'));
    expect(await publishPartyRsvpFlow(db as never, WABA, assets)).toMatchObject({ status: 'needs_review' });
    const resumed = fakeAssets();
    expect(await publishPartyRsvpFlow(db as never, WABA, resumed, { resume: true }))
      .toEqual({ status: 'published', publicationId: 'pub-1', metaFlowId: '9001', alreadyPublished: false });
    expect(resumed.create).not.toHaveBeenCalled(); expect(resumed.upload).toHaveBeenCalledWith('9001', partyRsvpFlowJson());

    const db2 = fakeDb(); const first = fakeAssets();
    first.status.mockRejectedValueOnce(new Error('timeout'));
    await publishPartyRsvpFlow(db2 as never, WABA, first);
    const live = fakeAssets({ status: 'PUBLISHED' });
    expect(await publishPartyRsvpFlow(db2 as never, WABA, live, { resume: true })).toMatchObject({ status: 'published' });
    expect(live.upload).not.toHaveBeenCalled(); expect(live.publish).not.toHaveBeenCalled();
  });

  it('an asset on another account, or in a blocked state, is never recorded as published', async () => {
    const db = fakeDb();
    expect(await publishPartyRsvpFlow(db as never, WABA, fakeAssets({ waba: '999' }))).toMatchObject({ status: 'needs_review' });
    expect(db.rows[0].status).toBe('needs_review');
    const db2 = fakeDb(); const blocked = fakeAssets({ status: 'BLOCKED' });
    expect(await publishPartyRsvpFlow(db2 as never, WABA, blocked)).toMatchObject({ status: 'needs_review' });
    expect(blocked.upload).not.toHaveBeenCalled();
  });

  it('an attempt in progress or interrupted (creating/draft) is never resumed; resume of a lost claim is refused', async () => {
    for (const status of ['creating', 'draft']) {
      const db = fakeDb(); const assets = fakeAssets();
      db.rows.push({ id: 'pub-x', waba_id: WABA, revision: partyRsvpFlowRevision(), status, meta_flow_id: status === 'draft' ? '9001' : null });
      expect(await publishPartyRsvpFlow(db as never, WABA, assets, { resume: true }))
        .toMatchObject({ status: 'needs_review', reason: expect.stringContaining('in progress or was interrupted') });
      expect(assets.status).not.toHaveBeenCalled(); expect(db.rows[0].status).toBe(status);
    }
    // Claim lost to another admin: the row is no longer needs_review when the conditional update runs.
    const db = fakeDb();
    db.rows.push({ id: 'pub-y', waba_id: WABA, revision: partyRsvpFlowRevision(), status: 'needs_review', meta_flow_id: '9001' });
    const realFrom = db.from;
    db.from = (t: string) => { const q = realFrom(t); const update = q.update; q.update = (v: Row) => { db.rows[0].status = 'draft'; return update(v); }; return q; };
    expect(await publishPartyRsvpFlow(db as never, WABA, fakeAssets(), { resume: true })).toMatchObject({ status: 'unavailable', reason: expect.stringContaining('resume') });
  });

  it('logs the asset ID when Meta created it but the binding could not be saved; never resumable', async () => {
    const { logger } = await import('@/lib/logger');
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never);
    const db = fakeDb(); const assets = fakeAssets();
    const realFrom = db.from;
    db.from = (t: string) => { const q = realFrom(t); q.update = () => ({ eq: () => ({ eq: () => ({ select: async () => ({ data: [], error: null }) }), neq: async () => ({}) }) }); return q; };
    expect(await publishPartyRsvpFlow(db as never, WABA, assets)).toMatchObject({ status: 'needs_review' });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('not saved'), { publicationId: 'pub-1', metaFlowId: '9001' });
    expect(assets.upload).not.toHaveBeenCalled();
  });

  it('THROTTLED or DEPRECATED assets, a thrown upload, or a final save of zero rows are never recorded as published', async () => {
    for (const status of ['THROTTLED', 'DEPRECATED']) {
      const db = fakeDb(); const assets = fakeAssets({ status });
      expect(await publishPartyRsvpFlow(db as never, WABA, assets)).toMatchObject({ status: 'needs_review' });
      expect(assets.upload).not.toHaveBeenCalled(); expect(db.rows[0].status).toBe('needs_review');
    }
    const db = fakeDb(); const assets = fakeAssets();
    assets.upload.mockRejectedValueOnce(new Error('500'));
    expect(await publishPartyRsvpFlow(db as never, WABA, assets)).toMatchObject({ status: 'needs_review' });
    expect(assets.publish).not.toHaveBeenCalled();
    const db2 = fakeDb(); const live = fakeAssets();
    // Someone else moved the row out of 'draft' while Meta published: the final save matches no row.
    live.publish.mockImplementationOnce(async (flowId: string) => { db2.rows[0].status = 'needs_review'; return { flowId, success: true }; });
    expect(await publishPartyRsvpFlow(db2 as never, WABA, live)).toMatchObject({ status: 'needs_review' });
    expect(db2.rows[0].status).toBe('needs_review');
  });

  it('fails closed on a lookup error, a concurrent attempt, or a bad account id', async () => {
    const assets = fakeAssets();
    expect(await publishPartyRsvpFlow(fakeDb({ failLookup: true }) as never, WABA, assets)).toMatchObject({ status: 'unavailable' });
    expect(await publishPartyRsvpFlow(fakeDb({ raceInsert: true }) as never, WABA, assets)).toMatchObject({ status: 'unavailable' });
    expect(await publishPartyRsvpFlow(fakeDb() as never, 'abc', assets)).toMatchObject({ status: 'unavailable' });
    const broken = fakeDb(); const realFrom = broken.from;
    broken.from = (t: string) => { const q = realFrom(t); q.single = async () => ({ data: null, error: { code: '42501' } }); return q; };
    expect(await publishPartyRsvpFlow(broken as never, WABA, assets)).toMatchObject({ status: 'unavailable', reason: expect.stringContaining('reserved') });
    expect(assets.create).not.toHaveBeenCalled();
  });

  it('status is read-only and reports the switch and current version', async () => {
    const db = fakeDb();
    expect(await partyRsvpFlowPublicationStatus(db as never, WABA)).toEqual({ enabled: true, revision: partyRsvpFlowRevision(), publication: null });
  });
});

describe('provider calls use the right switch', () => {
  it('RSVP form calls run only with the RSVP switch; merchant native-form calls are unchanged', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ id: '9001' })));
    vi.stubGlobal('fetch', fetch);
    await expect(createFlowAsset('t'.repeat(20), WABA, 'n', ['OTHER'])).rejects.toMatchObject({ statusCode: 403 });
    expect(await createFlowAsset('t'.repeat(20), WABA, 'n', ['OTHER'], partyRsvpFormsEnabled)).toMatchObject({ flowId: '9001' });
    vi.stubEnv('WHATSAPP_PARTY_RSVP_FORMS_ENABLED', '');
    await expect(getFlowStatus('t'.repeat(20), '9001', partyRsvpFormsEnabled)).rejects.toMatchObject({ statusCode: 403 });
    expect(fetch).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it('the Meta service binds RSVP assets to its own account and the RSVP switch', async () => {
    const svc = new MetaCloudService({ accessToken: 't'.repeat(20), phoneNumberId: '1', wabaId: WABA });
    expect(() => svc.partyRsvpFlowAssets('999')).toThrow('account mismatch');
    const fetch = vi.fn(async () => new Response(JSON.stringify({ id: '9002' })));
    vi.stubGlobal('fetch', fetch);
    expect(await svc.partyRsvpFlowAssets(WABA).create('n')).toMatchObject({ flowId: '9002' });
    expect(JSON.parse((fetch.mock.calls[0] as any)[1].body)).toEqual({ name: 'n', categories: ['OTHER'] });
    await expect(svc.nativeFlowAssets(WABA).create('n')).rejects.toMatchObject({ statusCode: 403 });
    vi.unstubAllGlobals();
  });
});
