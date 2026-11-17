// Custom Flow orphaned-upload sweep (#1085, Reviewer A's condition on PR #1088).
// Run daily by /api/cron/custom-flow-upload-sweep.
import type { SupabaseClient } from '@supabase/supabase-js';
import { logger } from '@/lib/logger';
import { reportFailure } from '@/lib/observability/report-failure';
import { CUSTOM_FLOW_UPLOADS_BUCKET, UPLOAD_EXTENSION } from '@/lib/bot/custom-flow/answers';
import { isUuid } from '@/lib/bot/custom-flow/data';

const JOB = 'custom-flow-upload-sweep';
/** Files younger than this are never touched, so an upload whose answer is still being saved is safe. */
export const GRACE_MS = 24 * 60 * 60 * 1000;
const PAGE = 1000;
// One session's answers are a handful; a full page means the lookup may be cut short, so nothing is deleted.
const LOOKUP_LIMIT = 1000;
const REMOVE_CHUNK = 100;
/** The engine's file name: <node id>-<random uuid>.<ext> (node ids per definition.ts). */
const UPLOAD_NAME = new RegExp(`^[A-Za-z0-9_-]{1,80}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.(${Object.values(UPLOAD_EXTENSION).join('|')})$`);
/** Per-run caps; the time budget keeps the run inside the route's 60 s limit. Tests lower them. */
export const SWEEP_LIMITS = { maxDeletes: 2000, maxListCalls: 5000, timeBudgetMs: 45_000 };

type Entry = { name: string; id: string | null; created_at?: string | null };
export interface SweepCounts { businesses: number; checked: number; deleted: number; kept_referenced: number; kept_recent: number; skipped: number; failed: number }
export type SweepResult = SweepCounts & { complete: boolean; root_failed?: true };

class Budget {
  lists = 0;
  constructor(private readonly started: number) {}
  get exhausted() { return this.lists >= SWEEP_LIMITS.maxListCalls || Date.now() - this.started > SWEEP_LIMITS.timeBudgetMs; }
}

/**
 * A customer's photo or PDF can be left in the private bucket with no answer
 * pointing at it (the server stopped between upload and save, an overtaken
 * photo's own delete failed, or a Storage delete failed). This deletes such
 * files: only objects shaped exactly like the engine's uploads
 * (<business>/<flow>/<session>/<node>-<uuid>.<ext>), only when no answer row of that
 * business references the exact path, and only when Storage says they are
 * over 24 hours old. Only the engine writes file_path, always with a path it
 * uploaded seconds earlier, so a file this old cannot become referenced
 * between the lookup and the delete. Anything uncertain is kept. Logs carry
 * counts only, never paths.
 */
export async function sweepOrphanedUploads(service: SupabaseClient): Promise<SweepResult> {
  const now = Date.now();
  const budget = new Budget(now);
  const counts: SweepCounts = { businesses: 0, checked: 0, deleted: 0, kept_referenced: 0, kept_recent: 0, skipped: 0, failed: 0 };

  const root = await listAll(service, '', budget);
  if (!root) {
    counts.failed++;
    reportFailure(new Error('root list failed'), { area: 'cron', op: 'list_root', job: JOB });
    return { ...counts, complete: false, root_failed: true };
  }
  const businesses = root.entries.filter(e => e.id === null && isUuid(e.name)).map(e => e.name);
  counts.skipped += root.entries.length - businesses.length;
  // Start somewhere different each run, so a run that hits its caps does not always favour the same businesses.
  const start = businesses.length ? Math.floor(Math.random() * businesses.length) : 0;
  let complete = root.complete;
  for (let i = 0; i < businesses.length; i++) {
    if (budget.exhausted || counts.deleted >= SWEEP_LIMITS.maxDeletes) { complete = false; break; }
    const businessId = businesses[(start + i) % businesses.length];
    counts.businesses++;
    if (!(await sweepBusiness(service, businessId, now, budget, counts))) complete = false;
  }
  logger.info('[CUSTOM-FLOW-SWEEP] done', { ...counts, complete });
  return { ...counts, complete };
}

/** Sweeps one business folder. Returns false when it stopped early (budget or delete cap). */
async function sweepBusiness(service: SupabaseClient, businessId: string, now: number, budget: Budget, counts: SweepCounts): Promise<boolean> {
  const flows = await listFolders(service, businessId, budget, counts);
  if (!flows) { failed(counts, businessId, 'list_business'); return true; }
  for (const flowId of flows.folders) {
    const sessions = await listFolders(service, `${businessId}/${flowId}`, budget, counts);
    if (!sessions) { failed(counts, businessId, 'list_flow'); continue; }
    for (const sessionId of sessions.folders) {
      if (budget.exhausted || counts.deleted >= SWEEP_LIMITS.maxDeletes) return false;
      const folder = `${businessId}/${flowId}/${sessionId}`;
      const listed = await listAll(service, folder, budget);
      if (!listed) { failed(counts, businessId, 'list_session'); continue; }
      const old: string[] = [];
      for (const entry of listed.entries) {
        // Deeper folders and names the engine never writes are not its uploads.
        if (entry.id === null || !UPLOAD_NAME.test(entry.name)) { counts.skipped++; continue; }
        counts.checked++;
        const created = Date.parse(entry.created_at ?? '');
        if (!Number.isFinite(created) || now - created < GRACE_MS) { counts.kept_recent++; continue; }
        old.push(`${folder}/${entry.name}`);
      }
      if (old.length) await deleteUnreferenced(service, businessId, folder, old, counts);
      if (!listed.complete) return false;
    }
    if (!sessions.complete) return false;
  }
  return flows.complete;
}

/**
 * Deletes the paths in one session folder that no answer references. The
 * folder is made of UUIDs only, so the LIKE prefix has no wildcards in it.
 * If the lookup fails or may be incomplete, nothing in the folder is deleted.
 */
async function deleteUnreferenced(service: SupabaseClient, businessId: string, folder: string, paths: string[], counts: SweepCounts): Promise<void> {
  const { data, error } = await service.from('custom_flow_answers').select('file_path')
    .eq('business_id', businessId).like('file_path', `${folder}/%`).limit(LOOKUP_LIMIT);
  if (error || !data || data.length >= LOOKUP_LIMIT) { failed(counts, businessId, 'lookup', error); return; }
  const referenced = new Set(data.map(row => row.file_path as string));
  const orphans = paths.filter(path => !referenced.has(path));
  counts.kept_referenced += paths.length - orphans.length;
  for (let i = 0; i < orphans.length; i += REMOVE_CHUNK) {
    const { data: removed, error: removeError } = await service.storage.from(CUSTOM_FLOW_UPLOADS_BUCKET).remove(orphans.slice(i, i + REMOVE_CHUNK));
    if (removeError) { failed(counts, businessId, 'remove', removeError); continue; }
    counts.deleted += removed?.length ?? 0;
  }
}

/** UUID-named subfolders of a folder; anything else there is counted as skipped. */
async function listFolders(service: SupabaseClient, prefix: string, budget: Budget, counts: SweepCounts) {
  const listed = await listAll(service, prefix, budget);
  if (!listed) return null;
  const folders = listed.entries.filter(e => e.id === null && isUuid(e.name)).map(e => e.name);
  counts.skipped += listed.entries.length - folders.length;
  return { folders, complete: listed.complete };
}

/** Every entry directly in one folder, page by page, within the run's budget. */
async function listAll(service: SupabaseClient, prefix: string, budget: Budget): Promise<{ entries: Entry[]; complete: boolean } | null> {
  const entries: Entry[] = [];
  for (let offset = 0; ; offset += PAGE) {
    if (budget.exhausted) return { entries, complete: false };
    budget.lists++;
    const { data, error } = await service.storage.from(CUSTOM_FLOW_UPLOADS_BUCKET)
      .list(prefix, { limit: PAGE, offset, sortBy: { column: 'name', order: 'asc' } });
    if (error || !data) return null;
    entries.push(...(data as Entry[]));
    if (data.length < PAGE) return { entries, complete: true };
  }
}

function failed(counts: SweepCounts, businessId: string, op: string, error?: unknown): void {
  counts.failed++;
  reportFailure(error ?? new Error(`${op} failed`), { area: 'cron', op, job: JOB, businessId, level: 'warning' });
}
