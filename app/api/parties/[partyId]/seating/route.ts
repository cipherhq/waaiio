import { NextRequest, NextResponse } from 'next/server';
import { createHash } from 'node:crypto';
import { authenticateRequest } from '@/lib/api-auth';
import { planSeating, type SeatingSnapshot } from '@/lib/parties/seating-planner';

export const dynamic = 'force-dynamic';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Context = { params: Promise<{ partyId: string }> };
const reply = (body: unknown, status = 200) =>
  NextResponse.json(body, { status, headers: { 'Cache-Control': 'private, no-store' } });
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const configOps = ['save_group', 'delete_group', 'membership', 'manual', 'pin'];

export async function GET(request: NextRequest, context: Context) {
  return handle(request, context, false);
}
export async function POST(request: NextRequest, context: Context) {
  return handle(request, context, true);
}
async function handle(request: NextRequest, context: Context, mutate: boolean) {
  const auth = await authenticateRequest(request);
  if (auth instanceof NextResponse) return auth;
  const { partyId } = await context.params;
  if (!uuid.test(partyId)) return reply({ error: 'Invalid party' }, 400);
  let input: Record<string, unknown> = { op: 'snapshot' };
  if (mutate) {
    try {
      const raw: unknown = await request.json();
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error();
      input = raw as Record<string, unknown>;
    } catch { return reply({ error: 'Invalid request' }, 400); }
  }
  const op = input.op;
  if (typeof op !== 'string' || !['snapshot', 'preview', 'commit', ...configOps].includes(op))
    return reply({ error: 'Unknown seating operation' }, 400);
  if (Object.keys(input).some(k => !['op', 'seed', 'fingerprint', 'planHash', 'acknowledgePartial', 'id', 'name', 'table_ids', 'invite_id', 'group_id', 'table_id', 'pinned'].includes(k)))
    return reply({ error: 'Unknown seating field' }, 400);
  for (const key of ['id', 'invite_id', 'group_id', 'table_id']) {
    if (input[key] !== undefined && input[key] !== null &&
      (typeof input[key] !== 'string' || !uuid.test(input[key] as string)))
      return reply({ error: 'Invalid identifier' }, 400);
  }
  if (op === 'save_group' && (typeof input.name !== 'string' || !input.name.trim() ||
    input.name.length > 100 || !Array.isArray(input.table_ids) || input.table_ids.length > 500 ||
    input.table_ids.some(x => typeof x !== 'string' || !uuid.test(x))))
    return reply({ error: 'Provide a group name and allowed tables' }, 400);
  if (op === 'delete_group' && !input.id ||
      ['membership', 'manual', 'pin'].includes(op) && !input.invite_id ||
      op === 'pin' && typeof input.pinned !== 'boolean')
    return reply({ error: 'Missing seating fields' }, 400);
  if (['preview', 'commit'].includes(op) &&
    (!Number.isSafeInteger(input.seed) || Number(input.seed) < 0 || Number(input.seed) > 4294967295))
    return reply({ error: 'Invalid shuffle seed' }, 400);

  const rpc = async (operation: string, payload: Record<string, unknown>) => {
    const result = await auth.service.rpc('party_seating_486', {
      p_party: partyId, p_actor: auth.user.id, p_operation: operation, p_payload: payload,
    });
    return result;
  };
  const respondError = (error: { code?: string }) => {
    if (error.code === '42501') return reply({ error: 'Party unavailable' }, 403);
    if (['40001', '23514', '23503', '23505', 'P0001'].includes(error.code || ''))
      return reply({ error: 'Seating changed or conflicts with saved assignments. Refresh and review again.' }, 409);
    if (error.code === '22023' || error.code === '22P02')
      return reply({ error: 'Invalid seating request' }, 400);
    return reply({ error: 'Unable to save seating. Please retry.' }, 500);
  };
  try {
    // Replay is checked before loading the now-changed snapshot, but only for an identical request.
    if (op === 'commit') {
      if (typeof input.fingerprint !== 'string' || typeof input.planHash !== 'string' ||
          !/^[0-9a-f]{64}$/.test(input.planHash) || typeof input.acknowledgePartial !== 'boolean')
        return reply({ error: 'Review a seating preview first' }, 400);
      const replay = await rpc('replay', input);
      if (replay.error) return respondError(replay.error);
      if (replay.data) return reply(replay.data);
    }
    const result = await rpc(configOps.includes(op) ? op : 'snapshot', input);
    if (result.error) return respondError(result.error);
    const snapshot = result.data as SeatingSnapshot;
    if (!['preview', 'commit'].includes(op)) return reply({ snapshot });
    const plan = planSeating(snapshot, Number(input.seed));
    const planHash = hash({ fingerprint: snapshot.fingerprint, seed: input.seed, plan });
    if (op === 'preview') return reply({ snapshot, plan, seed: input.seed, planHash });
    if (snapshot.fingerprint !== input.fingerprint || planHash !== input.planHash)
      return reply({ error: 'Seating changed. Create a new preview.' }, 409);
    if (plan.conflicts.length || plan.overflow.length && input.acknowledgePartial !== true)
      return reply({ error: 'Resolve conflicts or acknowledge the listed unassigned guests.' }, 409);
    const saved = await rpc('commit', { ...input, assignments: plan.assignments });
    if (saved.error) return respondError(saved.error);
    return reply(saved.data);
  } catch { return reply({ error: 'Unable to load seating. Please retry.' }, 500); }
}
