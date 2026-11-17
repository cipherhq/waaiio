// ─────────────────────────────────────────────────────────────────────
// Waaiio Custom Flow — data-driven runtime (Issue #1013, Phase 1)
//
// Runs Message / Menu / Lookup nodes from a published definition, Handoff
// nodes (#1086) that pass the customer to an existing capability flow, and
// Ask nodes (#1085) that save the customer's answer privately for the business.
// No customer logic lives in this file: every word the customer sees
// comes from the definition or its data tables. When the tables do not
// have an answer, the engine says so (no_match / fallback) — it never
// invents one.
//
// Entry: tryHandleCustomFlow() is called from BotService.handleMessage
// after STOP only, and before the "my X" handlers, keyword matching and
// the code-flow executor. It does NOT run after the restart/PIN interceptors
// (those live below the branch in handleMessage), so the engine yields to
// them explicitly: PIN steps never reach the engine (isPinStep), restart
// words and business codes are passed back to the normal bot, and only
// plain text and the engine's own cf:/cf-resume: postbacks are handled.
// It returns { handled: false } when no custom session is active and
// the message is not an entry keyword, leaving existing routing untouched.
// ─────────────────────────────────────────────────────────────────────

import type { SupabaseClient } from '@supabase/supabase-js';
import type { MessageSender } from '@/lib/channels/message-sender';
import { logger } from '@/lib/logger';
import { reportFailure } from '@/lib/observability/report-failure';
import { requireCurrentCapability } from '@/lib/bot/flows/shared/capability-guard';
import { parseDefinition, validateDefinition } from './definition';
import { businessData } from './sources';
import { loadAnswerRows } from './table-data';
import { hasValue, variablesIn } from './data';
import { checkHandoffRecord, type CapabilityHandoff } from './handoff';
import { HANDOFF_UNAVAILABLE_TEXT } from './handoff-copy';
import {
  CUSTOM_FLOW_UPLOADS_BUCKET, DEFAULT_RETRY, ESCAPE_HINT, MAX_UPLOAD_BYTES, REASON_TEXT, SAVE_FAILED_TEXT, TYPE_A_DATE_TEXT,
  type RetryReason,
  UPLOAD_EXTENSION, YES_NO_LABELS, askPostback, isAllowedUploadMime, readAnswer, sniffUploadMime,
} from './answers';
import { formatFullDate, upcomingDateOptions } from './dates';
import {
  loadActiveSession,
  createSession,
  updateSessionCas,
  closeSession,
  isSessionExpired,
  CUSTOM_FLOW_SESSION_TTL_HOURS,
} from './session';
import type {
  CustomFlowAskNode,
  CustomFlowDefinition,
  CustomFlowHandleResult,
  CustomFlowNode,
  CustomFlowSessionRow,
  CustomFlowTableRow,
} from './types';

/** Button/list postback for a menu choice: cf:<node id>:<option index>. */
export const MENU_POSTBACK_PREFIX = 'cf:';
const RESUME_CONTINUE_POSTBACK = 'cf-resume:continue';
const RESUME_RESTART_POSTBACK = 'cf-resume:restart';

const GLOBAL_MENU_WORDS = new Set(['menu', 'main menu', 'start over', 'back']);
const GLOBAL_HELP_WORDS = new Set(['help']);
const GLOBAL_EXIT_WORDS = new Set(['cancel', 'exit', 'quit', 'goodbye', 'bye']);
const GLOBAL_HUMAN_WORDS = new Set(['human', 'agent', 'talk to a human', 'talk to someone', 'support']);

export const DEFAULT_CLOSE_TEXT =
  'Thanks for chatting with us! Send Hi anytime to start again.';
export const DEFAULT_HUMAN_TEXT =
  'Thanks — a person from the team will reply here shortly.';

const LOG_INPUT_MAX = 2000;
const LOG_OUTPUT_MAX = 4000;

/** Platform restart words: these belong to the existing bot, not to a flow. */
const RESTART_WORDS = /^(start|restart)$/i;
/** A published flow changed under an active session: tell, then restart. */
const FLOW_UPDATED_TEXT = 'This flow has been updated — starting from the beginning.';
/** Backstop for message -> message chains (validateDefinition rejects cycles at publish time). */
const MAX_MESSAGE_HOPS = 10;
/** Substring/whole-word lookup needs at least this many characters (exact row codes excepted). */
const MIN_LOOKUP_QUERY_LENGTH = 2;

interface EngineDeps {
  supabase: SupabaseClient;
  sender: MessageSender;
  /**
   * Starts the existing capability flow for a handoff step (BotService, or the
   * builder preview). Without it a handoff step is treated as unavailable.
   */
  handOff?: CapabilityHandoff;
}

interface LoadedFlow {
  id: string;
  name: string;
  greeting: string;
  fallbackMessage: string;
  entryKeyword: string | null;
  publishedVersion: number;
  definition: CustomFlowDefinition;
  businessVars?: Record<string, unknown>;
}

export class CustomFlowEngine {
  constructor(private readonly deps: EngineDeps) {}

  // ── Entry point (called from BotService) ──────────────────────────

  async handleMessage(args: {
    businessId: string;
    from: string;
    text: string;
    /** Exact business-code detector (injected by BotService). When omitted, no code check runs. */
    isBusinessCode?: (text: string) => Promise<boolean>;
  }): Promise<CustomFlowHandleResult> {
    const { businessId, from } = args;
    const text = (args.text || '').trim();
    const { supabase } = this.deps;

    // Bind the tenant before any send (S-1 hard-stop guard).
    this.deps.sender.bindBusiness?.(businessId);

    const session = await loadActiveSession(supabase, businessId, from);

    if (session) {
      // Entitlement first: a lapsed business stops answering, and the
      // message falls through to the normal bot (no trap — the session
      // simply stays expired until it lapses or the business re-enables).
      if (!(await this.isEntitled(businessId))) return { handled: false };
      // A resume answer belongs to the engine even when the word itself
      // ("restart") is a platform restart word — the engine asked the question.
      if (this.isResumePending(session)) {
        return this.handleWithSession(session, text);
      }
      // Restart words and business codes belong to the existing bot.
      // Close the session first: otherwise the customer is left in a
      // custom session whose menu they can no longer see, and their next
      // typed replies are swallowed by the engine (#1016 reviewer B P1).
      if (RESTART_WORDS.test(text)) {
        await closeSession(supabase, session.id, session.business_id);
        return { handled: false };
      }
      if (args.isBusinessCode && (await args.isBusinessCode(text))) {
        await closeSession(supabase, session.id, session.business_id);
        return { handled: false };
      }
      return this.handleWithSession(session, text);
    }

    // No active session: only an entry keyword can start a flow. The
    // whole message must be the keyword (reviewer B, non-blocking):
    // first-word matching let "AFROFEST hello" start a flow by accident.
    const keyword = text.toUpperCase();
    if (!keyword) return { handled: false };
    const flow = await this.loadPublishedFlowByKeyword(businessId, keyword);
    if (!flow) return { handled: false };
    // A business code that is also an entry keyword belongs to the platform.
    if (args.isBusinessCode && (await args.isBusinessCode(text))) return { handled: false };
    if (!(await this.isEntitled(businessId))) return { handled: false };

    const started = await this.startFlow(flow, businessId, from);
    return { handled: started };
  }

  /** A displayed business-menu choice can start a flow without an entry keyword. */
  async startById(businessId: string, from: string, flowId: string): Promise<boolean> {
    this.deps.sender.bindBusiness?.(businessId);
    // A stale menu button must never replace or become input to an active flow.
    if (await loadActiveSession(this.deps.supabase, businessId, from)) return false;
    if (!(await this.isEntitled(businessId))) return false;
    const flow = await this.loadPublishedFlowById(businessId, flowId);
    if (!flow) return false;
    // createSession's active-session unique index is the final concurrent-start gate.
    return this.startFlow(flow, businessId, from);
  }

  /**
   * Entitlement gate (P1 fix, PR #1016 review). Reuses the bot's canonical
   * capability guard — the same helper the code flows use — so tier,
   * overrides, business status and the 14-day Pro/Premium trial are treated
   * exactly as the existing rules treat them. Fails closed: any denial or
   * DB error means the flow does not run and the message falls through to
   * the normal bot. No session is passed, so no capability-recovery runs.
   */
  private async isEntitled(businessId: string): Promise<boolean> {
    try {
      const result = await requireCurrentCapability(this.deps.supabase, {
        businessId,
        capability: 'custom_flow',
        action: 'create_new',
      });
      if (!result.allowed) {
        logger.warn(`[CUSTOM-FLOW] custom_flow not entitled (${result.reason}) business=${businessId}`);
      }
      return result.allowed;
    } catch (err) {
      logger.error('[CUSTOM-FLOW] Entitlement check failed:', err);
      reportFailure(err, { area: 'custom_flow', op: 'entitlement_check', businessId, capability: 'custom_flow' });
      return false;
    }
  }

  // ── Session handling ──────────────────────────────────────────────

  private async handleWithSession(
    session: CustomFlowSessionRow,
    text: string,
  ): Promise<CustomFlowHandleResult> {
    const { supabase } = this.deps;

    if (isSessionExpired(session)) {
      return this.handleExpiredSession(session, text);
    }

    const flow = await this.loadPublishedFlowById(session.business_id, session.flow_id);
    if (!flow) {
      // Flow unpublished or deleted mid-conversation: close and fall back
      // to normal routing instead of stranding the customer.
      await closeSession(supabase, session.id, session.business_id);
      return { handled: false };
    }

    // Answers to a question live only in custom_flow_answers, which the owner
    // can delete and retention removes after 12 months (#1085); the step log
    // keeps a marker, never the answer itself.
    const atQuestion = flow.definition.nodes.find((n) => n.id === session.current_node_id)?.type === 'ask';
    await this.log(session, null, 'in', atQuestion ? '[answer]' : text, null);

    // Resume prompt answers are consumed here, before node input.
    if (this.isResumePending(session)) {
      return this.handleResumeAnswer(session, flow, text);
    }

    // Version capture (P2 fix, PR #1016 review): flow_version was written
    // at start but never read, so a republish could strand the customer on
    // a node that no longer exists. If the current step still exists in the
    // published definition, adopt the new version and continue; if it is
    // gone, tell the customer and restart instead of closing silently.
    let current = session;
    if (session.flow_version !== flow.publishedVersion) {
      const nodeExists = flow.definition.nodes.some((n) => n.id === session.current_node_id);
      if (!nodeExists) {
        return this.restartWithNotice(session, flow);
      }
      const updated = await updateSessionCas(supabase, session, { flow_version: flow.publishedVersion });
      if (updated) {
        current = { ...session, flow_version: flow.publishedVersion, version: session.version + 1 };
      }
      // If the CAS lost the race, keep the stale session: the next message re-checks.
    }

    const node = flow.definition.nodes.find((n) => n.id === current.current_node_id);
    if (!node) {
      return this.restartWithNotice(current, flow);
    }

    return this.handleNodeInput(current, flow, node, text);
  }

  /** The flow changed under the customer: say so, close, start fresh. */
  private async restartWithNotice(session: CustomFlowSessionRow, flow: LoadedFlow): Promise<CustomFlowHandleResult> {
    await this.sendText(session, FLOW_UPDATED_TEXT);
    await closeSession(this.deps.supabase, session.id, session.business_id);
    await this.startFlow(flow, session.business_id, session.whatsapp_number);
    return { handled: true };
  }

  private async handleExpiredSession(
    session: CustomFlowSessionRow,
    text: string,
  ): Promise<CustomFlowHandleResult> {
    const { supabase } = this.deps;
    const flow = await this.loadPublishedFlowById(session.business_id, session.flow_id);
    if (!flow) {
      await closeSession(supabase, session.id, session.business_id);
      return { handled: false };
    }

    // Offer "continue or start again?" once; the answer arrives next message.
    if (!this.isResumePending(session)) {
      const updated = await updateSessionCas(supabase, session, {
        fields: { ...session.fields, _resume_pending: true },
      });
      if (!updated) return { handled: true }; // stale writer won; stay quiet
      await this.sendText(session, 'Welcome back! Would you like to continue where you left off, or start again?', [
        { id: RESUME_CONTINUE_POSTBACK, title: 'Continue' },
        { id: RESUME_RESTART_POSTBACK, title: 'Start again' },
      ]);
      return { handled: true };
    }

    return this.handleResumeAnswer(session, flow, text);
  }

  private isResumePending(session: CustomFlowSessionRow): boolean {
    return session.fields._resume_pending === true;
  }

  private async handleResumeAnswer(
    session: CustomFlowSessionRow,
    flow: LoadedFlow,
    text: string,
  ): Promise<CustomFlowHandleResult> {
    const { supabase } = this.deps;
    const normalized = text.trim().toLowerCase();
    const isContinue = text === RESUME_CONTINUE_POSTBACK || normalized === 'continue' || normalized === 'yes';
    const isRestart = text === RESUME_RESTART_POSTBACK || normalized === 'start again' || normalized === 'restart';

    if (isContinue) {
      const fields = { ...session.fields };
      delete fields._resume_pending;
      const expiresAt = new Date(Date.now() + CUSTOM_FLOW_SESSION_TTL_HOURS * 60 * 60 * 1000).toISOString();
      const nextVersion = session.version + 1;
      const updated = await updateSessionCas(supabase, session, { fields, expires_at: expiresAt });
      if (!updated) return { handled: true };
      const fresh: CustomFlowSessionRow = { ...session, fields, expires_at: expiresAt, version: nextVersion };
      const node = flow.definition.nodes.find((n) => n.id === fresh.current_node_id);
      if (!node) {
        // The flow was republished and this step is gone: tell and restart.
        return this.restartWithNotice(fresh, flow);
      }
      await this.renderNode(fresh, flow, node);
      return { handled: true };
    }

    if (isRestart) {
      await closeSession(supabase, session.id, session.business_id);
      await this.startFlow(flow, session.business_id, session.whatsapp_number);
      return { handled: true };
    }

    // Anything else — including cancel — is not an answer to the resume
    // prompt. The prompt was offered once: close the session and pass this
    // same message to the normal bot, so the customer can never get stuck.
    await closeSession(supabase, session.id, session.business_id);
    return { handled: false };
  }

  // ── Starting a flow ───────────────────────────────────────────────

  private async startFlow(flow: LoadedFlow, businessId: string, from: string): Promise<boolean> {
    const { supabase } = this.deps;
    const startNodeId = flow.definition.start_node ?? flow.definition.nodes[0]?.id;
    if (!startNodeId) return false;

    const session = await createSession(supabase, {
      businessId,
      whatsappNumber: from,
      flowId: flow.id,
      flowVersion: flow.publishedVersion,
      startNodeId,
    });
    if (!session) return false;

    const startNode = flow.definition.nodes.find((n) => n.id === startNodeId);
    if (!startNode) {
      await closeSession(supabase, session.id, session.business_id);
      return false;
    }

    // Greeting first, then the start node. When the start node is a menu
    // whose text IS the greeting, send it once as the menu (buttons
    // included) instead of twice as plain text + menu.
    const startIsMenuWithGreetingText =
      startNode.type === 'menu' && this.renderText(startNode.text, flow) === this.renderText(flow.greeting, flow);
    if (!startIsMenuWithGreetingText) {
      await this.sendText(session, this.renderText(flow.greeting, flow));
    }
    await this.renderNode(session, flow, startNode);
    return true;
  }

  // ── Node input ────────────────────────────────────────────────────

  private async handleNodeInput(
    session: CustomFlowSessionRow,
    flow: LoadedFlow,
    node: CustomFlowNode,
    text: string,
  ): Promise<CustomFlowHandleResult> {
    const normalized = text.trim().toLowerCase();

    // Global words work from any node.
    if (GLOBAL_MENU_WORDS.has(normalized)) {
      await this.goToNode(session, flow, flow.definition.start_node ?? flow.definition.nodes[0].id);
      return { handled: true };
    }
    if (GLOBAL_HELP_WORDS.has(normalized)) {
      await this.sendText(session, this.renderText(flow.fallbackMessage, flow));
      await this.goToNode(session, flow, flow.definition.start_node ?? flow.definition.nodes[0].id);
      return { handled: true };
    }
    if (GLOBAL_EXIT_WORDS.has(normalized)) {
      await this.sendText(session, DEFAULT_CLOSE_TEXT);
      await closeSession(this.deps.supabase, session.id, session.business_id);
      return { handled: true };
    }
    if (GLOBAL_HUMAN_WORDS.has(normalized)) {
      await this.sendText(session, DEFAULT_HUMAN_TEXT);
      const handoffSaved = await updateSessionCas(this.deps.supabase, session, {
        fields: { ...session.fields, _handoff_requested: true },
      });
      if (!handoffSaved) {
        logger.warn('[CUSTOM-FLOW] Human handoff flag lost the CAS race; the customer was still told a person will reply.');
      }
      return { handled: true };
    }

    switch (node.type) {
      case 'menu':
        return this.handleMenuInput(session, flow, node, text);
      case 'lookup':
        return this.handleLookupInput(session, flow, node, text);
      case 'ask':
        return this.handleAskInput(session, flow, node, text);
      case 'message':
      case 'handoff':
        // Message and handoff nodes never wait for input; reaching one with
        // input means the step stalled. Re-render it and move on.
        await this.renderNode(session, flow, node);
        return { handled: true };
      default:
        await this.sendText(session, this.renderText(flow.fallbackMessage, flow));
        return { handled: true };
    }
  }

  private async handleMenuInput(
    session: CustomFlowSessionRow,
    flow: LoadedFlow,
    node: Extract<CustomFlowNode, { type: 'menu' }>,
    text: string,
  ): Promise<CustomFlowHandleResult> {
    // Button / list postback: cf:<node id>:<option index>.
    const postback = text.match(/^cf:(.+):(\d+)$/);
    if (postback) {
      const index = Number(postback[2]);
      const option = node.options[index];
      if (option && postback[1] === node.id) {
        await this.goToNode(session, flow, option.next);
        return { handled: true };
      }
    }

    // Typed reply: option number (1-based) or option label.
    const trimmed = text.trim();
    const asNumber = Number(trimmed);
    if (Number.isInteger(asNumber) && asNumber >= 1 && asNumber <= node.options.length) {
      await this.goToNode(session, flow, node.options[asNumber - 1].next);
      return { handled: true };
    }
    const byLabel = node.options.find((o) => o.label.trim().toLowerCase() === trimmed.toLowerCase());
    if (byLabel) {
      await this.goToNode(session, flow, byLabel.next);
      return { handled: true };
    }

    // No match: say so and re-show the menu. Never guess the choice.
    await this.sendText(session, this.renderText(flow.fallbackMessage, flow));
    await this.renderNode(session, flow, node);
    return { handled: true };
  }

  private async handleLookupInput(
    session: CustomFlowSessionRow,
    flow: LoadedFlow,
    node: Extract<CustomFlowNode, { type: 'lookup' }>,
    text: string,
  ): Promise<CustomFlowHandleResult> {
    const query = text.trim();
    let rows: CustomFlowTableRow[];
    try { rows = await loadAnswerRows(this.deps.supabase, session.business_id, flow.id, node.table, node.reply, flow.businessVars); }
    catch { await this.sendText(session, this.renderText(node.no_match, flow, { query })); return { handled: true }; }

    // A disambiguation is pending for this node: the reply picks a candidate.
    const pending = this.pendingLookupCandidates(session, node.id);
    if (pending.length > 0) {
      const picked = this.pickLookupCandidate(pending, query);
      if (picked) {
        const row = rows.find((r) => r.row_code.toLowerCase() === picked.row_code.toLowerCase());
        if (row) {
          await this.clearLookupCandidates(session);
          const reply = this.renderText(node.reply, flow, rowVars(row.data));
          await this.sendText(session, reply);
          const nextId = node.next ?? flow.definition.start_node ?? flow.definition.nodes[0].id;
          await this.goToNode(session, flow, nextId);
          return { handled: true };
        }
      }
      // Not a pick: fall through to a fresh search (candidates cleared).
      await this.clearLookupCandidates(session);
    }

    const matches = this.findRows(rows, node.search_fields, query);

    if (matches.length === 0) {
      await this.sendText(session, this.renderText(node.no_match, flow, { query }));
      // Stay on the lookup node so the customer can try another search.
      return { handled: true };
    }

    if (matches.length === 1) {
      const reply = this.renderText(node.reply, flow, rowVars(matches[0].data));
      await this.sendText(session, reply);
      const nextId = node.next ?? flow.definition.start_node ?? flow.definition.nodes[0].id;
      await this.goToNode(session, flow, nextId);
      return { handled: true };
    }

    // Several rows match: ask the customer to pick one instead of guessing
    // the first row by table position.
    const candidates = matches.map((row) => ({
      row_code: row.row_code,
      label: this.lookupCandidateLabel(row, node.search_fields),
    }));
    const list = candidates.map((c, i) => `${i + 1}. ${c.label}`).join('\n');
    const saved = await updateSessionCas(this.deps.supabase, session, {
      fields: { ...session.fields, _lookup_candidates: candidates, _lookup_node: node.id },
    });
    if (!saved) return { handled: true }; // stale writer won; stay quiet
    await this.sendText(session, `I found a few matches:\n${list}\nReply with the number or code.`);
    return { handled: true };
  }

  /** Candidates awaiting a pick for this lookup node, if any. */
  private pendingLookupCandidates(
    session: CustomFlowSessionRow,
    nodeId: string,
  ): Array<{ row_code: string; label: string }> {
    if (session.fields._lookup_node !== nodeId) return [];
    const raw = session.fields._lookup_candidates;
    if (!Array.isArray(raw)) return [];
    return raw.filter(
      (c): c is { row_code: string; label: string } =>
        !!c && typeof (c as { row_code?: unknown }).row_code === 'string',
    );
  }

  /** A reply picks a candidate by its number (1-based) or its row code. */
  private pickLookupCandidate(
    candidates: Array<{ row_code: string; label: string }>,
    text: string,
  ): { row_code: string; label: string } | null {
    const trimmed = text.trim();
    const asNumber = Number(trimmed);
    if (Number.isInteger(asNumber) && asNumber >= 1 && asNumber <= candidates.length) {
      return candidates[asNumber - 1];
    }
    const byCode = candidates.find((c) => c.row_code.toLowerCase() === trimmed.toLowerCase());
    return byCode ?? null;
  }

  private async clearLookupCandidates(session: CustomFlowSessionRow): Promise<void> {
    const fields = { ...session.fields };
    delete fields._lookup_candidates;
    delete fields._lookup_node;
    await updateSessionCas(this.deps.supabase, session, { fields });
  }

  /** Short label for a disambiguation entry: code plus the first search field. */
  private lookupCandidateLabel(row: CustomFlowTableRow, searchFields: string[]): string {
    const first = searchFields.map((f) => row.data[f]).find((v) => v !== undefined && v !== null && String(v).trim() !== '');
    return first === undefined ? row.row_code : `${row.row_code} — ${String(first)}`;
  }

  // ── Questions (#1085) ─────────────────────────────────────────────

  /** Language, country and timezone for friendly dates; country read once per engine. */
  private businessCountry: Promise<string> | null = null;
  private async dateContext(session: CustomFlowSessionRow, flow: LoadedFlow) {
    this.businessCountry ??= Promise.resolve(this.deps.supabase.from('businesses').select('country_code').eq('id', session.business_id).maybeSingle())
      .then(({ data }) => (typeof data?.country_code === 'string' && data.country_code) || 'GB', () => 'GB');
    return { timezone: flow.definition.timezone || 'UTC', language: flow.definition.language || 'en', country: await this.businessCountry };
  }

  private async renderAsk(session: CustomFlowSessionRow, flow: LoadedFlow, node: CustomFlowAskNode): Promise<void> {
    const to = session.whatsapp_number;
    const body = this.renderText(node.question, flow, session.fields);
    if (node.answer_type === 'yes_no') {
      await this.deps.sender.sendButtons({ to, body, buttons: YES_NO_LABELS.map((title, index) => ({ id: askPostback(node.id, index), title })) });
    } else if (node.answer_type === 'choice') {
      const options = node.options ?? [];
      if (options.length <= 3) {
        await this.deps.sender.sendButtons({ to, body, buttons: options.map((option, index) => ({ id: askPostback(node.id, index), title: option.slice(0, 20) })) });
      } else {
        await this.deps.sender.sendList({ to, title: flow.name, body, buttonLabel: 'Choose',
          items: options.map((option, index) => ({ title: option.slice(0, 24), postbackText: askPostback(node.id, index) })) });
      }
    } else if (node.answer_type === 'date') {
      const rows = upcomingDateOptions(await this.dateContext(session, flow));
      await this.deps.sender.sendList({ to, title: flow.name, body, buttonLabel: 'Choose a date',
        items: rows.map(row => ({ title: row.title, postbackText: askPostback(node.id, row.id) })) });
    } else {
      await this.deps.sender.sendText({ to, text: body });
    }
    await this.log(session, node.id, 'out', null, body);
  }

  private async handleAskInput(
    session: CustomFlowSessionRow,
    flow: LoadedFlow,
    node: CustomFlowAskNode,
    text: string,
  ): Promise<CustomFlowHandleResult> {
    const result = readAnswer(node, text, await this.dateContext(session, flow));
    if (result.kind === 'another_date') {
      await this.sendText(session, TYPE_A_DATE_TEXT);
      return { handled: true };
    }
    if (result.kind === 'invalid') {
      await this.askAgain(session, flow, node, result.reason);
      return { handled: true };
    }
    await this.acceptAnswer(session, flow, node, { value_text: result.value_text, value_date: result.value_date });
    return { handled: true };
  }

  /** A wrong answer: say so (with the way out after two misses) and ask again. Nothing is saved. */
  private async askAgain(session: CustomFlowSessionRow, flow: LoadedFlow, node: CustomFlowAskNode, reason?: RetryReason): Promise<void> {
    const failures = (session.fields._ask_node === node.id && typeof session.fields._ask_failures === 'number' ? session.fields._ask_failures : 0) + 1;
    const saved = await updateSessionCas(this.deps.supabase, session, { fields: { ...session.fields, _ask_node: node.id, _ask_failures: failures } });
    if (!saved) return; // stale writer won; stay quiet
    const fresh = { ...session, version: session.version + 1, fields: { ...session.fields, _ask_node: node.id, _ask_failures: failures } };
    // A known reason (date passed, file not received) is said plainly; otherwise the merchant's retry message.
    const retry = reason ? REASON_TEXT[reason] : this.renderText(node.retry_message?.trim() || DEFAULT_RETRY[node.answer_type], flow, session.fields);
    await this.sendText(fresh, failures >= 2 ? `${retry}\n\n${ESCAPE_HINT}` : retry);
    // Tap-to-answer questions are shown again so the customer can tap.
    if (node.answer_type === 'yes_no' || node.answer_type === 'choice' || node.answer_type === 'date') await this.renderAsk(fresh, flow, node);
  }

  /**
   * Save a valid answer for this business, then move on. Returns false when
   * it could not be saved (the customer is told and stays on the question).
   * Re-answering in the same run replaces the earlier answer; a replaced
   * upload is removed so no file outlives its answer.
   */
  private async acceptAnswer(
    session: CustomFlowSessionRow,
    flow: LoadedFlow,
    node: CustomFlowAskNode,
    value: { value_text: string | null; value_date: string | null; file_path?: string; file_mime?: string; file_size?: number; claimedAt?: Date },
  ): Promise<boolean> {
    const { supabase } = this.deps;
    // Any earlier answer to this question in this run, of any type: a republish
    // may have turned a Photo or PDF question into another kind.
    const { data: previous } = await supabase.from('custom_flow_answers').select('file_path')
      .eq('business_id', session.business_id).eq('response_id', session.id).eq('node_id', node.id).maybeSingle();
    const previousFile = (previous?.file_path as string | null | undefined) ?? null;
    const { error } = await supabase.from('custom_flow_answers').upsert({
      business_id: session.business_id,
      flow_id: session.flow_id,
      flow_version: session.flow_version,
      response_id: session.id,
      session_id: session.id,
      customer_number: session.whatsapp_number,
      node_id: node.id,
      // A question made only of an empty {{value}} falls back to its own words.
      question: (this.renderText(node.question, flow, session.fields).trim() || node.question.trim()).slice(0, 1000),
      answer_type: node.answer_type,
      value_text: value.value_text,
      value_date: value.value_date,
      file_path: value.file_path ?? null,
      file_mime: value.file_mime ?? null,
      file_size: value.file_size ?? null,
      created_at: new Date().toISOString(),
    }, { onConflict: 'response_id,node_id' });
    if (error) {
      logger.error('[CUSTOM-FLOW] Answer save failed:', error.message);
      await this.sendText(session, SAVE_FAILED_TEXT);
      return false;
    }
    await this.log(session, node.id, 'in', node.answer_type === 'file' ? '[file]' : null, null);
    if (node.answer_type === 'file' || previousFile) await this.removeStaleUploads(session, node, previousFile, value.file_path ?? null, value.claimedAt);

    if (value.value_date) {
      await this.sendText(session, `✅ ${formatFullDate(value.value_date, await this.dateContext(session, flow))}`);
    }
    let current = session;
    if (session.fields._ask_node !== undefined || session.fields._ask_failures !== undefined) {
      const fields = { ...session.fields };
      delete fields._ask_node;
      delete fields._ask_failures;
      if (!(await updateSessionCas(supabase, session, { fields }))) return true; // stale writer won
      current = { ...session, fields, version: session.version + 1 };
    }
    if (node.next) {
      await this.goToNode(current, flow, node.next);
    } else {
      await this.sendText(current, DEFAULT_CLOSE_TEXT);
      await closeSession(supabase, current.id, current.business_id);
    }
    return true;
  }

  /**
   * A photo or document arrived (#1085). Handled only when this customer's
   * active custom-flow step is a Photo or PDF question; otherwise false, and
   * the caller keeps its existing reply. Type and size are checked before the
   * file is downloaded, then the real type is read from its bytes. The file is
   * stored privately under the business's own folder before the answer is saved.
   */
  async handleFileMessage(args: {
    businessId: string;
    from: string;
    media: { id: string; mimeType?: string };
    download: (mediaId: string, maxBytes: number) => Promise<{ ok: true; buffer: Buffer } | { ok: false; reason: string }>;
  }): Promise<boolean> {
    const { supabase } = this.deps;
    const found = await loadActiveSession(supabase, args.businessId, args.from);
    if (!found || this.isResumePending(found)) return false;
    if (!(await this.isEntitled(args.businessId))) return false;
    // Bind the shared sender only once this business will reply (S-1 guard).
    if (isSessionExpired(found)) {
      // A file after the chat timed out gets the usual "continue or start again?" question.
      this.deps.sender.bindBusiness?.(args.businessId);
      return (await this.handleExpiredSession(found, '')).handled;
    }
    const flow = await this.loadPublishedFlowById(found.business_id, found.flow_id);
    const node = flow?.definition.nodes.find(n => n.id === found.current_node_id);
    if (!flow || node?.type !== 'ask' || node.answer_type !== 'file') return false;
    this.deps.sender.bindBusiness?.(args.businessId);
    // Claim the step first (adopting a republished version, as text input does):
    // of two files sent at once only one is stored, so no replaced file is left behind.
    const adopt = found.flow_version !== flow.publishedVersion ? { flow_version: flow.publishedVersion } : {};
    if (!(await updateSessionCas(supabase, found, adopt))) return true;
    const claimedAt = new Date();
    let session = { ...found, ...adopt, version: found.version + 1 };
    // From here the message is ours: an error is logged, never answered with a second, contradictory reply.
    try {
      await this.log(session, node.id, 'in', '[file received]', null);
      if (!isAllowedUploadMime(args.media.mimeType)) { await this.askAgain(session, flow, node); return true; }
      const media = await args.download(args.media.id, MAX_UPLOAD_BYTES);
      if (!media.ok) { await this.askAgain(session, flow, node, media.reason === 'too_large' ? undefined : 'file_unavailable'); return true; }
      const mime = sniffUploadMime(media.buffer);
      if (!mime || media.buffer.length > MAX_UPLOAD_BYTES) { await this.askAgain(session, flow, node); return true; }

      const path = `${uploadFolder(session)}/${node.id}-${crypto.randomUUID()}.${UPLOAD_EXTENSION[mime]}`;
      const { error } = await supabase.storage.from(CUSTOM_FLOW_UPLOADS_BUCKET).upload(path, media.buffer, { contentType: mime, upsert: false });
      if (error) {
        logger.error('[CUSTOM-FLOW] Upload failed:', error.message);
        await this.sendText(session, SAVE_FAILED_TEXT);
        return true;
      }
      // Save gate: a later photo for this step may have claimed it while this one
      // downloaded. Only the current claim saves; a superseded one removes its own
      // upload and stays quiet, so no saved answer can point at a deleted file.
      if (!(await updateSessionCas(supabase, session, {}))) {
        const { error: dropError } = await supabase.storage.from(CUSTOM_FLOW_UPLOADS_BUCKET).remove([path]);
        if (dropError) logger.error('[CUSTOM-FLOW] Superseded upload could not be removed:', dropError.message);
        return true;
      }
      session = { ...session, version: session.version + 1 };
      const saved = await this.acceptAnswer(session, flow, node, { value_text: null, value_date: null, file_path: path, file_mime: mime, file_size: media.buffer.length, claimedAt });
      if (!saved) {
        const { error: removeError } = await supabase.storage.from(CUSTOM_FLOW_UPLOADS_BUCKET).remove([path]);
        if (removeError) logger.error('[CUSTOM-FLOW] Unsaved upload could not be removed:', removeError.message);
      }
    } catch (err) {
      logger.error('[CUSTOM-FLOW] File answer failed after it was accepted for handling:', err);
    }
    return true;
  }

  /**
   * After an answer is saved, remove the replaced file and leftovers of
   * earlier attempts at this question in this run (#1085). Only objects
   * uploaded well before this answer's claim are leftovers: a photo being
   * handled at the same moment is never touched, and the saved file never is.
   * Failures are logged; the next answer to this question tries again.
   */
  private async removeStaleUploads(session: CustomFlowSessionRow, node: CustomFlowAskNode, previousFile: string | null, keep: string | null, claimedAt?: Date): Promise<void> {
    const bucket = this.deps.supabase.storage.from(CUSTOM_FLOW_UPLOADS_BUCKET);
    const folder = uploadFolder(session);
    const stale = new Set<string>();
    if (previousFile && previousFile !== keep) stale.add(previousFile);
    if (node.answer_type === 'file') try {
      const { data } = await bucket.list(folder, { search: `${node.id}-` });
      for (const object of data ?? []) {
        const path = `${folder}/${object.name}`;
        const created = Date.parse((object as { created_at?: string }).created_at ?? '');
        // One minute of margin for clock differences between this server and Storage.
        const leftover = !!claimedAt && Number.isFinite(created) && created < claimedAt.getTime() - 60_000;
        if (object.name.startsWith(`${node.id}-`) && path !== keep && leftover) stale.add(path);
      }
    } catch (err) {
      logger.error('[CUSTOM-FLOW] Upload folder could not be listed:', err);
    }
    if (!stale.size) return;
    const { error } = await bucket.remove([...stale]);
    if (error) logger.error('[CUSTOM-FLOW] Replaced upload could not be removed:', error.message);
  }

  // ── Rendering ─────────────────────────────────────────────────────

  /** Render a node and advance the session to wherever it leads. `depth` counts message -> message hops in this chain (menu/lookup input starts a fresh chain at 0). */
  private async renderNode(
    session: CustomFlowSessionRow,
    flow: LoadedFlow,
    node: CustomFlowNode,
    depth = 0,
  ): Promise<void> {
    switch (node.type) {
      case 'message': {
        const text = this.renderText(node.text, flow, session.fields);
        if (node.image) {
          await this.sendImage(session, node.image, text);
        } else {
          await this.sendText(session, text);
        }
        if (node.next) {
          await this.goToNode(session, flow, node.next, depth + 1);
        } else {
          await closeSession(this.deps.supabase, session.id, session.business_id);
        }
        return;
      }
      case 'menu': {
        await this.renderMenu(session, flow, node);
        return;
      }
      case 'lookup': {
        // A lookup node waits for the customer's search text. Render its
        // prompt when the definition has one; otherwise stay silent — the
        // menu option that led here already said what to do.
        if (node.prompt) {
          await this.sendText(session, this.renderText(node.prompt, flow, session.fields));
        }
        return;
      }
      case 'handoff': {
        await this.renderHandoff(session, flow, node, depth);
        return;
      }
      case 'ask': {
        await this.renderAsk(session, flow, node);
        return;
      }
      default:
        return;
    }
  }

  /**
   * Hand the customer to an existing capability flow (#1086). The capability
   * and the chosen record are re-checked here, for this business, before the
   * custom session is closed. When either is unusable the customer is told in
   * plain English and returned to the flow's first step (when it waits for a
   * reply), so a handoff never strands them or opens another business's data.
   */
  private async renderHandoff(
    session: CustomFlowSessionRow,
    flow: LoadedFlow,
    node: Extract<CustomFlowNode, { type: 'handoff' }>,
    depth: number,
  ): Promise<void> {
    const { supabase } = this.deps;
    let record: { name: string | null } | null = null;
    try {
      const guard = await requireCurrentCapability(supabase, {
        businessId: session.business_id,
        capability: node.capability,
        action: 'create_new',
      });
      if (guard.allowed) record = await checkHandoffRecord(supabase, session.business_id, node);
      else logger.warn(`[CUSTOM-FLOW] handoff ${node.capability} not entitled (${guard.reason}) business=${session.business_id}`);
    } catch (err) {
      logger.error('[CUSTOM-FLOW] Handoff check failed:', err);
      reportFailure(err, {
        area: 'custom_flow', op: 'handoff_check', businessId: session.business_id,
        flowId: session.flow_id, sessionId: session.id, capability: node.capability,
      });
    }

    if (record && this.deps.handOff) {
      await this.log(session, node.id, 'out', null, `Continues in ${node.capability}`);
      const result = await this.deps.handOff({
        capability: node.capability,
        recordId: node.record_id ?? null,
        recordName: record.name,
        closeCustomSession: () => closeSession(supabase, session.id, session.business_id),
      });
      // 'stale': another message won the session race and owns the reply.
      if (result !== 'unavailable') return;
    }

    await this.sendText(session, HANDOFF_UNAVAILABLE_TEXT[node.capability]);
    const startId = flow.definition.start_node ?? flow.definition.nodes[0]?.id;
    const start = flow.definition.nodes.find((n) => n.id === startId);
    // Only a start step that waits for a reply is a safe place to return to:
    // a message chain could lead straight back to this handoff.
    if (start && start.id !== node.id && (start.type === 'menu' || start.type === 'lookup')) {
      await this.goToNode(session, flow, start.id, depth + 1);
      return;
    }
    await this.sendText(session, DEFAULT_CLOSE_TEXT);
    await closeSession(supabase, session.id, session.business_id);
  }

  private async renderMenu(
    session: CustomFlowSessionRow,
    flow: LoadedFlow,
    node: Extract<CustomFlowNode, { type: 'menu' }>,
  ): Promise<void> {
    const body = this.renderText(node.text, flow, session.fields);
    if (node.options.length <= 3) {
      await this.deps.sender.sendButtons({
        to: session.whatsapp_number,
        body,
        buttons: node.options.map((option, index) => ({
          id: `cf:${node.id}:${index}`,
          title: option.label.slice(0, 20),
        })),
      });
      await this.log(session, node.id, 'out', null, body);
      return;
    }
    await this.deps.sender.sendList({
      to: session.whatsapp_number,
      title: flow.name,
      body,
      buttonLabel: 'Choose',
      items: node.options.map((option, index) => ({
        title: option.label.slice(0, 24),
        postbackText: `cf:${node.id}:${index}`,
      })),
    });
    await this.log(session, node.id, 'out', null, body);
  }

  /** Move the session to a node and render it. `depth` is the message -> message hop count; past the limit the chain is treated as a loop and the session is closed. */
  private async goToNode(
    session: CustomFlowSessionRow,
    flow: LoadedFlow,
    nodeId: string,
    depth = 0,
  ): Promise<void> {
    if (depth >= MAX_MESSAGE_HOPS) {
      logger.warn(`[CUSTOM-FLOW] Message chain exceeded ${MAX_MESSAGE_HOPS} hops; closing session ${session.id}.`);
      await closeSession(this.deps.supabase, session.id, session.business_id);
      return;
    }
    const node = flow.definition.nodes.find((n) => n.id === nodeId);
    if (!node) {
      // Broken link in the definition: fall back to the start node.
      const startId = flow.definition.start_node ?? flow.definition.nodes[0]?.id;
      if (!startId || startId === nodeId) {
        await closeSession(this.deps.supabase, session.id, session.business_id);
        return;
      }
      await this.goToNode(session, flow, startId, depth);
      return;
    }
    const nextVersion = session.version + 1;
    const updated = await updateSessionCas(this.deps.supabase, session, { current_node_id: node.id });
    if (!updated) return; // stale writer won; stay quiet
    const fresh: CustomFlowSessionRow = {
      ...session,
      current_node_id: node.id,
      version: nextVersion,
    };
    await this.renderNode(fresh, flow, node, depth);
  }

  // ── Lookup ────────────────────────────────────────────────────────

  /**
   * All matching rows: exact row_code first, then whole-word matches across
   * search fields, then substring matches. A one-letter query matches
   * nothing (except an exact one-letter row code) — a single letter used to
   * match the first row by table position.
   */
  private findRows(
    rows: CustomFlowTableRow[],
    searchFields: string[],
    query: string,
  ): CustomFlowTableRow[] {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const byCode = rows.find((row) => row.row_code.toLowerCase() === q);
    if (byCode) return [byCode];
    if (q.length < MIN_LOOKUP_QUERY_LENGTH) return [];
    const wholeWord = rows.filter((row) =>
      searchFields.some((field) => {
        const value = row.data[field];
        if (value === undefined || value === null) return false;
        return String(value).toLowerCase().split(/[^a-z0-9]+/).includes(q);
      }),
    );
    if (wholeWord.length > 0) return wholeWord;
    return rows.filter((row) =>
      searchFields.some((field) => {
        const value = row.data[field];
        if (value === undefined || value === null) return false;
        return String(value).toLowerCase().includes(q);
      }),
    );
  }

  // ── Flow loading (tenant-scoped, published only) ──────────────────

  private async loadPublishedFlowById(businessId: string, flowId: string): Promise<LoadedFlow | null> {
    const { data, error } = await this.deps.supabase
      .from('custom_flows')
      .select('id, name, greeting, fallback_message, entry_keyword, published_version, published_definition')
      .eq('business_id', businessId)
      .eq('id', flowId)
      .eq('status', 'published')
      .maybeSingle();
    if (error || !data) return null;
    return this.toLoadedFlow(data, businessId);
  }

  private async loadPublishedFlowByKeyword(businessId: string, keyword: string): Promise<LoadedFlow | null> {
    const { data, error } = await this.deps.supabase
      .from('custom_flows')
      .select('id, name, greeting, fallback_message, entry_keyword, published_version, published_definition')
      .eq('business_id', businessId)
      .eq('status', 'published')
      .eq('entry_keyword', keyword)
      .maybeSingle();
    if (error || !data) return null;
    return this.toLoadedFlow(data, businessId);
  }

  private async toLoadedFlow(row: Record<string, unknown>, businessId: string): Promise<LoadedFlow | null> {
    const definition = parseDefinition(row.published_definition);
    if (!definition) return null;
    // Fail closed: a published definition that no longer validates is
    // treated as unavailable (logged by the caller path), never guessed at.
    if (validateDefinition(definition).length > 0) return null;
    let businessVars: Record<string, unknown> | undefined;
    if (definition.business_bindings?.length) {
      try { businessVars = (await businessData(this.deps.supabase, businessId, definition.business_bindings)).vars; }
      catch { businessVars = {}; }
    }
    return {
      id: String(row.id),
      name: String(row.name ?? ''),
      greeting: String(row.greeting ?? ''),
      fallbackMessage: String(row.fallback_message ?? ''),
      entryKeyword: (row.entry_keyword as string | null) ?? null,
      publishedVersion: Number(row.published_version ?? 1),
      definition,
      businessVars,
    };
  }

  private renderText(text: string, flow: LoadedFlow, values: Record<string, unknown> = {}): string {
    if (!flow.definition.business_bindings) return substitute(text, values);
    const safe = Object.fromEntries(Object.entries(values).filter(([key]) => !key.startsWith('business.') && !key.startsWith('_')));
    const vars = { ...safe, ...flow.businessVars };
    if (variablesIn(text).some(key => key.startsWith('business.') && !hasValue(vars[key]))) {
      // The configured fallback cannot recurse or expose unresolved bindings.
      return substitute(flow.fallbackMessage, vars);
    }
    return substitute(text, vars);
  }

  // ── Sending + logging ─────────────────────────────────────────────

  private async sendText(
    session: CustomFlowSessionRow,
    text: string,
    buttons?: Array<{ id: string; title: string }>,
  ): Promise<void> {
    try {
      if (buttons) {
        await this.deps.sender.sendButtons({ to: session.whatsapp_number, body: text, buttons });
      } else {
        await this.deps.sender.sendText({ to: session.whatsapp_number, text });
      }
      await this.log(session, session.current_node_id, 'out', null, text);
    } catch (err) {
      // A failed send is logged, never silently dropped.
      await this.log(session, session.current_node_id, 'out', null, `SEND FAILED: ${text}`);
      throw err;
    }
  }

  private async sendImage(session: CustomFlowSessionRow, imageUrl: string, caption: string): Promise<void> {
    try {
      await this.deps.sender.sendImage({ to: session.whatsapp_number, imageUrl, caption });
      await this.log(session, session.current_node_id, 'out', null, caption);
    } catch (err) {
      await this.log(session, session.current_node_id, 'out', null, `SEND FAILED: ${caption}`);
      throw err;
    }
  }

  private async log(
    session: CustomFlowSessionRow,
    nodeId: string | null,
    direction: 'in' | 'out',
    input: string | null,
    output: string | null,
  ): Promise<void> {
    try {
      const { error } = await this.deps.supabase.from('custom_flow_logs').insert({
        business_id: session.business_id,
        flow_id: session.flow_id,
        session_id: session.id,
        node_id: nodeId,
        direction,
        input: input ? input.slice(0, LOG_INPUT_MAX) : null,
        output: output ? output.slice(0, LOG_OUTPUT_MAX) : null,
      });
      if (error) {
        reportFailure(error, {
          area: 'custom_flow', op: 'log_insert', businessId: session.business_id,
          flowId: session.flow_id, sessionId: session.id, level: 'warning',
        });
      }
    } catch {
      // Logging must never break the conversation.
    }
  }
}

/** Private folder for one run's uploads: <business>/<flow>/<run>. */
function uploadFolder(session: CustomFlowSessionRow): string {
  return `${session.business_id}/${session.flow_id}/${session.id}`;
}

/** Replace {{variable}} tokens from vars; unknown variables render empty. */
export function substitute(template: string, vars: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g, (_match, key: string) => {
    const value = vars[key];
    if (value === undefined || value === null) return '';
    return String(value);
  });
}

/** Row data as template variables (values stringified on substitution). */
export function rowVars(data: Record<string, unknown>): Record<string, unknown> {
  return { ...data };
}

/**
 * Entry point used by BotService.handleMessage. Returns handled:false when
 * no custom session is active and the message is not an entry keyword.
 */
export async function tryHandleCustomFlow(args: {
  supabase: SupabaseClient;
  sender: MessageSender;
  businessId: string | null;
  from: string;
  text: string;
  messageType?: string;
  /** True when the customer's bot session is in a card-PIN step. PIN input must never reach the engine (it would be consumed and logged). */
  isPinStep?: boolean;
  /** Exact business-code detector (injected by BotService). */
  isBusinessCode?: (text: string) => Promise<boolean>;
  /** Starts an existing capability flow for a handoff step (injected by BotService). */
  handOff?: CapabilityHandoff;
}): Promise<boolean> {
  if (!args.businessId) return false;
  // PIN steps win over the custom session: the input is a card PIN and must
  // never be consumed or logged by the engine.
  if (args.isPinStep) return false;
  const text = (args.text || '').trim();
  // Only plain text and the engine's own postbacks belong to a custom flow.
  // Anything else — images, location, voice, and other features' buttons
  // ("I've Paid", reminder confirm/cancel, order/ticket postbacks) — passes
  // through to the normal bot.
  if (args.messageType && args.messageType !== 'text') {
    if (!text.startsWith(MENU_POSTBACK_PREFIX) && !text.startsWith('cf-resume:')) return false;
  }
  const engine = new CustomFlowEngine({ supabase: args.supabase, sender: args.sender, handOff: args.handOff });
  const result = await engine.handleMessage({
    businessId: args.businessId,
    from: args.from,
    text: args.text,
    isBusinessCode: args.isBusinessCode,
  });
  return result.handled;
}
