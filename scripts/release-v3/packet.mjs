// Release packet (RELEASE_GATE_V2.md §9.4): one generated document the Owner
// approves by its sha256. It holds no secrets and no raw deployment IDs
// (deployment IDs appear only as salted sha256 values), so it can be uploaded
// as a workflow artifact of this public repository.
import { fail, sha256, canonicalJson, exactKeys, HASH, SHA, OWNER, POLICY, SCHEMA_VERSION } from './common.mjs';

export const PACKET_TTL_MS = 24 * 60 * 60 * 1000;
export const packetBytes = packet => Buffer.from(canonicalJson(packet), 'utf8');
export const packetDigest = packet => sha256(packetBytes(packet));

const PACKET_KEYS = ['schema_version', 'policy', 'created_at', 'expires_at', 'prepare', 'target', 'baseline', 'admin_pin', 'lane',
  'changes', 'pull_requests', 'migrations', 'database', 'staging', 'permanent_checks', 'lock_sha256', 'deploy_order'];

export function buildPacket(fields, now = Date.now()) {
  const packet = { schema_version: SCHEMA_VERSION, policy: POLICY, created_at: new Date(now).toISOString(),
    expires_at: new Date(now + PACKET_TTL_MS).toISOString(), ...fields, deploy_order: ['merchant', 'admin'] };
  validatePacketShape(packet);
  return packet;
}

export function validatePacketShape(packet) {
  if (!exactKeys(packet, PACKET_KEYS) || packet.schema_version !== SCHEMA_VERSION || packet.policy !== POLICY
    || !SHA.test(packet.target?.sha || '') || !SHA.test(packet.target?.tree || '')
    || !['standard', 'full'].includes(packet.lane?.lane) || !HASH.test(packet.lock_sha256 || '')
    || !HASH.test(packet.admin_pin?.descriptor_sha256 || '')
    || ['merchant', 'admin'].some(k => !SHA.test(packet.baseline?.[k]?.sha || '') || !HASH.test(packet.baseline?.[k]?.deployment_sha256 || ''))
    || !HASH.test(packet.database?.production?.catalog?.sha256 || '') || !HASH.test(packet.database?.production?.ledger?.sha256 || '')
    || packet.permanent_checks?.m430_absent !== true || packet.permanent_checks?.hold_flags_absent !== true
    || JSON.stringify(packet.deploy_order) !== '["merchant","admin"]') fail('Release packet is incomplete');
  return packet;
}

// Parses and validates the downloaded packet against the approved digest.
export function acceptPacket(bytes, approvedSha256, now = Date.now()) {
  if (!HASH.test(approvedSha256 || '')) fail('Approved packet sha256 required');
  if (sha256(bytes) !== approvedSha256) fail('Packet bytes differ from the approved sha256');
  let packet; try { packet = JSON.parse(Buffer.from(bytes).toString('utf8')); } catch { fail('Packet is not valid JSON'); }
  if (!packetBytes(packet).equals(Buffer.from(bytes))) fail('Packet is not in canonical form');
  validatePacketShape(packet);
  const created = Date.parse(packet.created_at), expires = Date.parse(packet.expires_at);
  if (!Number.isFinite(created) || expires !== created + PACKET_TTL_MS || created > now + 60_000) fail('Packet time is invalid');
  if (now > expires) fail('Packet expired (24 hours); prepare a new packet and get a new approval');
  return packet;
}

// Recorded approvals. GitHub cannot tell the Owner from Claude here (both use
// the cipherhq account), so these are records, not enforcement: the Owner's
// chat approval is recorded verbatim on GitHub by the orchestrating session,
// bound to the packet sha256, and the gate requires that record to exist.
export const APPROVAL_LINE = /^Release-Approval: v1 packet=([a-f0-9]{64}) decision=APPROVED$/m;
export const STAGING_ACCEPTANCE_LINE = /^Release-Staging-Acceptance: v1 packet=([a-f0-9]{64}) decision=ACCEPTED$/m;
export const REVIEW_LINE = /^Release-Review-Record: v1 verdict=APPROVED head=([a-f0-9]{40}) reviewer=([A-Za-z0-9_-]{4,64})$/gm;

export function parseCommentUrl(url) {
  const match = /^https:\/\/github\.com\/cipherhq\/waaiio\/(?:issues|pull)\/[0-9]+#issuecomment-([0-9]+)$/.exec(url || '');
  if (!match) fail('A GitHub comment URL in cipherhq/waaiio is required');
  return match[1];
}
export function verifyRecordComment(comment, line, packetSha256, label) {
  const match = line.exec(comment?.body || '');
  if (comment?.user?.login !== OWNER || !match || match[1] !== packetSha256) fail(`${label} record for this packet not found`);
  return { comment_id: comment.id, created_at: comment.created_at };
}

// Each PR included in the release needs its required number of distinct
// review records on its exact merged head (two for full lane, one otherwise).
// lock.reviewed_prs lists PRs merged before review records existed, with the
// head their prose review approved.
export function countReviews(comments, headSha) {
  const reviewers = new Set();
  for (const comment of comments) {
    if (comment?.user?.login !== OWNER) continue;
    for (const match of String(comment.body || '').matchAll(REVIEW_LINE)) if (match[1] === headSha) reviewers.add(match[2]);
  }
  return [...reviewers].sort();
}
export function verifyPullRequestReviews(pr, comments, reviewedPrs = {}) {
  if (reviewedPrs[String(pr.number)] !== undefined) {
    if (reviewedPrs[String(pr.number)] !== pr.head_sha) fail(`PR ${pr.number}: lock review record is for a different head`);
    return { ...pr, recorded_reviews: 'lock' };
  }
  const reviewers = countReviews(comments, pr.head_sha);
  if (reviewers.length < pr.required_reviews) fail(`PR ${pr.number} has ${reviewers.length} of ${pr.required_reviews} required review records on head ${pr.head_sha}`);
  return { ...pr, recorded_reviews: reviewers.length, reviewers };
}

// The approval may be used once. Every deploy run is named after its packet;
// any other run (any status) with the same packet consumes it.
export function verifySingleUse(runs, packetSha256, runId, attempt) {
  if (attempt !== 1) fail('A packet approval cannot be reused by re-running a deploy');
  if (!Array.isArray(runs?.workflow_runs) || runs.total_count !== runs.workflow_runs.length) fail('Deploy run history incomplete');
  const others = runs.workflow_runs.filter(r => String(r.id) !== String(runId) && String(r.display_title || '').includes(packetSha256));
  if (others.length) fail('This packet approval was already used by another deploy run');
  return true;
}
