// ─────────────────────────────────────────────────────────────────────
// Waaiio Custom Flow — data-driven runtime (Issue #1013, Phase 1)
//
// Runs Message / Menu / Lookup nodes from a published definition.
// No customer logic lives in this file: every word the customer sees
// comes from the definition or its data tables. When the tables do not
// have an answer, the engine says so (no_match / fallback) — it never
// invents one.
//
// Entry: tryHandleCustomFlow() is called from BotService.handleMessage
// after STOP/restart/PIN interceptors and before keyword matching and
// the code-flow executor, so an active custom session owns the input.
// It returns { handled: false } when no custom session is active and
// the message is not an entry keyword, leaving existing routing untouched.
// ─────────────────────────────────────────────────────────────────────

import type { SupabaseClient } from '@supabase/supabase-js';
import type { MessageSender } from '@/lib/channels/message-sender';
import { parseDefinition, validateDefinition } from './definition';
import {
  loadActiveSession,
  createSession,
  updateSessionCas,
  closeSession,
  isSessionExpired,
  CUSTOM_FLOW_SESSION_TTL_HOURS,
} from './session';
import type {
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

const GLOBAL_MENU_WORDS = new Set(['menu', 'main menu', 'start over', 'restart', 'back']);
const GLOBAL_HELP_WORDS = new Set(['help']);
const GLOBAL_EXIT_WORDS = new Set(['cancel', 'exit', 'quit', 'goodbye', 'bye']);
const GLOBAL_HUMAN_WORDS = new Set(['human', 'agent', 'talk to a human', 'talk to someone', 'support']);

export const DEFAULT_CLOSE_TEXT =
  'Thanks for chatting with us! Send Hi anytime to start again.';
export const DEFAULT_HUMAN_TEXT =
  'Thanks — a person from the team will reply here shortly.';

const LOG_INPUT_MAX = 2000;
const LOG_OUTPUT_MAX = 4000;

interface EngineDeps {
  supabase: SupabaseClient;
  sender: MessageSender;
}

interface LoadedFlow {
  id: string;
  name: string;
  greeting: string;
  fallbackMessage: string;
  entryKeyword: string | null;
  publishedVersion: number;
  definition: CustomFlowDefinition;
}

export class CustomFlowEngine {
  constructor(private readonly deps: EngineDeps) {}

  // ── Entry point (called from BotService) ──────────────────────────

  async handleMessage(args: {
    businessId: string;
    from: string;
    text: string;
  }): Promise<CustomFlowHandleResult> {
    const { businessId, from } = args;
    const text = (args.text || '').trim();
    const { supabase } = this.deps;

    // Bind the tenant before any send (S-1 hard-stop guard).
    this.deps.sender.bindBusiness?.(businessId);

    const session = await loadActiveSession(supabase, businessId, from);

    if (session) {
      return this.handleWithSession(session, text);
    }

    // No active session: only an entry keyword can start a flow.
    const keyword = text.split(/\s+/)[0]?.toUpperCase() ?? '';
    if (!keyword) return { handled: false };
    const flow = await this.loadPublishedFlowByKeyword(businessId, keyword);
    if (!flow) return { handled: false };

    const started = await this.startFlow(flow, businessId, from);
    return { handled: started };
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
      await closeSession(supabase, session.id);
      return { handled: false };
    }

    await this.log(session, null, 'in', text, null);

    // Resume prompt answers are consumed here, before node input.
    if (this.isResumePending(session)) {
      return this.handleResumeAnswer(session, flow, text);
    }

    const node = flow.definition.nodes.find((n) => n.id === session.current_node_id);
    if (!node) {
      await this.log(session, null, 'out', null, 'Flow node not found; session closed.');
      await closeSession(supabase, session.id);
      return { handled: true };
    }

    return this.handleNodeInput(session, flow, node, text);
  }

  private async handleExpiredSession(
    session: CustomFlowSessionRow,
    text: string,
  ): Promise<CustomFlowHandleResult> {
    const { supabase } = this.deps;
    const flow = await this.loadPublishedFlowById(session.business_id, session.flow_id);
    if (!flow) {
      await closeSession(supabase, session.id);
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
        await closeSession(supabase, session.id);
        return { handled: true };
      }
      await this.renderNode(fresh, flow, node);
      return { handled: true };
    }

    if (isRestart) {
      await closeSession(supabase, session.id);
      await this.startFlow(flow, session.business_id, session.whatsapp_number);
      return { handled: true };
    }

    // Anything else: repeat the offer once (no loop — the prompt is the reply).
    await this.sendText(session, 'Would you like to continue where you left off, or start again?', [
      { id: RESUME_CONTINUE_POSTBACK, title: 'Continue' },
      { id: RESUME_RESTART_POSTBACK, title: 'Start again' },
    ]);
    return { handled: true };
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
      await closeSession(supabase, session.id);
      return false;
    }

    // Greeting first, then the start node. When the start node is a menu
    // whose text IS the greeting, send it once as the menu (buttons
    // included) instead of twice as plain text + menu.
    const startIsMenuWithGreetingText =
      startNode.type === 'menu' && substitute(startNode.text, {}) === flow.greeting;
    if (!startIsMenuWithGreetingText) {
      await this.sendText(session, flow.greeting);
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
      await this.sendText(session, flow.fallbackMessage);
      await this.goToNode(session, flow, flow.definition.start_node ?? flow.definition.nodes[0].id);
      return { handled: true };
    }
    if (GLOBAL_EXIT_WORDS.has(normalized)) {
      await this.sendText(session, DEFAULT_CLOSE_TEXT);
      await closeSession(this.deps.supabase, session.id);
      return { handled: true };
    }
    if (GLOBAL_HUMAN_WORDS.has(normalized)) {
      await this.sendText(session, DEFAULT_HUMAN_TEXT);
      await updateSessionCas(this.deps.supabase, session, {
        fields: { ...session.fields, _handoff_requested: true },
      });
      return { handled: true };
    }

    switch (node.type) {
      case 'menu':
        return this.handleMenuInput(session, flow, node, text);
      case 'lookup':
        return this.handleLookupInput(session, flow, node, text);
      case 'message':
        // Message nodes never wait for input; reaching one with input means
        // the chain stalled. Re-render it and move on.
        await this.renderNode(session, flow, node);
        return { handled: true };
      default:
        await this.sendText(session, flow.fallbackMessage);
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
    await this.sendText(session, flow.fallbackMessage);
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
    const rows = await this.loadTableRows(session.business_id, flow.id, node.table);
    const match = this.findRow(rows, node.search_fields, query);

    if (!match) {
      await this.sendText(session, substitute(node.no_match, { query }));
      // Stay on the lookup node so the customer can try another search.
      return { handled: true };
    }

    const reply = substitute(node.reply, rowVars(match.data));
    await this.sendText(session, reply);
    const nextId = node.next ?? flow.definition.start_node ?? flow.definition.nodes[0].id;
    await this.goToNode(session, flow, nextId);
    return { handled: true };
  }

  // ── Rendering ─────────────────────────────────────────────────────

  /** Render a node and advance the session to wherever it leads. */
  private async renderNode(
    session: CustomFlowSessionRow,
    flow: LoadedFlow,
    node: CustomFlowNode,
  ): Promise<void> {
    switch (node.type) {
      case 'message': {
        const text = substitute(node.text, session.fields);
        if (node.image) {
          await this.sendImage(session, node.image, text);
        } else {
          await this.sendText(session, text);
        }
        if (node.next) {
          await this.goToNode(session, flow, node.next);
        } else {
          await closeSession(this.deps.supabase, session.id);
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
          await this.sendText(session, substitute(node.prompt, session.fields));
        }
        return;
      }
      default:
        return;
    }
  }

  private async renderMenu(
    session: CustomFlowSessionRow,
    flow: LoadedFlow,
    node: Extract<CustomFlowNode, { type: 'menu' }>,
  ): Promise<void> {
    const body = substitute(node.text, session.fields);
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

  /** Move the session to a node and render it. */
  private async goToNode(
    session: CustomFlowSessionRow,
    flow: LoadedFlow,
    nodeId: string,
  ): Promise<void> {
    const node = flow.definition.nodes.find((n) => n.id === nodeId);
    if (!node) {
      // Broken link in the definition: fall back to the start node.
      const startId = flow.definition.start_node ?? flow.definition.nodes[0]?.id;
      if (!startId || startId === nodeId) {
        await closeSession(this.deps.supabase, session.id);
        return;
      }
      await this.goToNode(session, flow, startId);
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
    await this.renderNode(fresh, flow, node);
  }

  // ── Lookup ────────────────────────────────────────────────────────

  private async loadTableRows(
    businessId: string,
    flowId: string,
    tableName: string,
  ): Promise<CustomFlowTableRow[]> {
    const { supabase } = this.deps;
    const { data: table, error: tableError } = await supabase
      .from('custom_flow_tables')
      .select('id')
      .eq('business_id', businessId)
      .eq('flow_id', flowId)
      .eq('name', tableName)
      .maybeSingle();
    if (tableError || !table) return [];
    const { data: rows, error } = await supabase
      .from('custom_flow_table_rows')
      .select('id, row_code, data, position, hidden')
      .eq('business_id', businessId)
      .eq('table_id', (table as { id: string }).id)
      .eq('hidden', false)
      .order('position', { ascending: true });
    if (error || !rows) return [];
    return rows as unknown as CustomFlowTableRow[];
  }

  /** Exact row_code match first, then case-insensitive substring across search fields. */
  private findRow(
    rows: CustomFlowTableRow[],
    searchFields: string[],
    query: string,
  ): CustomFlowTableRow | null {
    const q = query.trim().toLowerCase();
    if (!q) return null;
    const byCode = rows.find((row) => row.row_code.toLowerCase() === q);
    if (byCode) return byCode;
    for (const row of rows) {
      for (const field of searchFields) {
        const value = row.data[field];
        if (value === undefined || value === null) continue;
        if (String(value).toLowerCase().includes(q)) return row;
      }
    }
    return null;
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
    return this.toLoadedFlow(data);
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
    return this.toLoadedFlow(data);
  }

  private toLoadedFlow(row: Record<string, unknown>): LoadedFlow | null {
    const definition = parseDefinition(row.published_definition);
    if (!definition) return null;
    // Fail closed: a published definition that no longer validates is
    // treated as unavailable (logged by the caller path), never guessed at.
    if (validateDefinition(definition).length > 0) return null;
    return {
      id: String(row.id),
      name: String(row.name ?? ''),
      greeting: String(row.greeting ?? ''),
      fallbackMessage: String(row.fallback_message ?? ''),
      entryKeyword: (row.entry_keyword as string | null) ?? null,
      publishedVersion: Number(row.published_version ?? 1),
      definition,
    };
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
      await this.deps.supabase.from('custom_flow_logs').insert({
        business_id: session.business_id,
        flow_id: session.flow_id,
        session_id: session.id,
        node_id: nodeId,
        direction,
        input: input ? input.slice(0, LOG_INPUT_MAX) : null,
        output: output ? output.slice(0, LOG_OUTPUT_MAX) : null,
      });
    } catch {
      // Logging must never break the conversation.
    }
  }
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
}): Promise<boolean> {
  if (!args.businessId) return false;
  const engine = new CustomFlowEngine({ supabase: args.supabase, sender: args.sender });
  const result = await engine.handleMessage({
    businessId: args.businessId,
    from: args.from,
    text: args.text,
  });
  return result.handled;
}
