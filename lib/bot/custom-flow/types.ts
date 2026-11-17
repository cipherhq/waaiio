// ─────────────────────────────────────────────────────────────────────
// Waaiio Custom Flow — data-driven flow definitions (Issue #1013)
// Phase 1 node set: message, menu, lookup. Phase 2 (#1086) adds handoff.
// Phase 3 (#1085) adds ask. Later phases add: list, image, broadcast_opt_in, end. A node type is a platform change;
// a customer need is first tested against combinations of these nodes.
// ─────────────────────────────────────────────────────────────────────

import type { BusinessField, GuidedMetadata } from './data';

export type CustomFlowNodeType = 'message' | 'menu' | 'lookup' | 'handoff' | 'ask';

export interface CustomFlowMessageNode {
  id: string;
  type: 'message';
  /** Text with {{variable}} substitution from session fields / row data. */
  text: string;
  /** Optional image URL sent with the text as caption. */
  image?: string | null;
  /** Next node id, or null to end the flow. */
  next: string | null;
}

export interface CustomFlowMenuOption {
  label: string;
  next: string;
}

export interface CustomFlowMenuNode {
  id: string;
  type: 'menu';
  text: string;
  /** WhatsApp allows max 3 buttons per message; longer menus render as a list. */
  options: CustomFlowMenuOption[];
}

export interface CustomFlowLookupNode {
  id: string;
  type: 'lookup';
  /** Table name (custom_flow_tables.name) within this flow. */
  table: string;
  /** Row fields searched by the customer's typed text (case-insensitive). */
  search_fields: string[];
  /** Optional prompt shown when the node is reached (e.g. "Type an artist's name"). */
  prompt?: string;
  /** Reply template with {{column}} substitution from the matched row. */
  reply: string;
  /** Message when nothing matches. Never invent an answer. */
  no_match: string;
  /**
   * Next node after the reply. Defaults to the flow's start node (main menu)
   * when omitted, so a lookup answer always leaves the customer somewhere.
   */
  next?: string | null;
}

/** Existing capabilities a flow can hand the customer over to (#1086). */
export type CustomFlowHandoffCapability = 'ticketing' | 'giving' | 'payment' | 'chat';

/**
 * Hands the customer to an existing capability flow, which runs unchanged
 * from its first step (its own payment, "I've Paid", confirmation and
 * next-steps menu). Terminal for the custom flow: there is no `next`.
 */
export interface CustomFlowHandoffNode {
  id: string;
  type: 'handoff';
  capability: CustomFlowHandoffCapability;
  /**
   * Optional record of this business to start with: an event (ticketing) or
   * a giving/payment option (services row). Never set for chat.
   */
  record_id?: string | null;
}

/** Kinds of answer an ask step accepts (#1085). Mirrored by the M546 CHECK. */
export type CustomFlowAnswerType = 'yes_no' | 'choice' | 'date' | 'text' | 'file';

/**
 * Asks the customer one question and saves the answer privately for the
 * business (custom_flow_answers, M546), then moves on. A wrong answer is
 * re-asked and never saved.
 */
export interface CustomFlowAskNode {
  id: string;
  type: 'ask';
  answer_type: CustomFlowAnswerType;
  /** The question as the customer sees it. */
  question: string;
  /** Pick one: 2–10 choices (3 or fewer show as buttons, more as a list). */
  options?: string[];
  /** Date: also accept dates before today (default: today or later). */
  allow_past?: boolean;
  /** Sent when an answer can't be used; a plain default is used when empty. */
  retry_message?: string;
  /** Next node id, or null to end the flow. */
  next: string | null;
}

export type CustomFlowNode =
  | CustomFlowMessageNode
  | CustomFlowMenuNode
  | CustomFlowLookupNode
  | CustomFlowHandoffNode
  | CustomFlowAskNode;

export interface CustomFlowDefinition {
  id: string;
  tenant_id?: string;
  name: string;
  status: 'draft' | 'published';
  greeting: string;
  fallback_message: string;
  /** Uppercase entry keyword (e.g. AFROFEST). Null means no keyword entry. */
  entry_keyword?: string | null;
  language?: string;
  timezone?: string;
  currency?: string;
  /** First node rendered when the flow starts. Defaults to nodes[0]. */
  start_node?: string;
  nodes: CustomFlowNode[];
  /** Table names this flow may read. */
  tables?: string[];
  business_bindings?: BusinessField[];
  guided?: GuidedMetadata;
}

export interface CustomFlowTableColumn {
  name: string;
  /** Field data type, e.g. text, number, money, date, time, choice, yes_no. */
  type: string;
  label?: string;
}

export interface CustomFlowTableRow {
  id: string;
  row_code: string;
  data: Record<string, unknown>;
  position: number;
  hidden: boolean;
}

export interface CustomFlowSessionRow {
  id: string;
  business_id: string;
  whatsapp_number: string;
  flow_id: string;
  flow_version: number;
  current_node_id: string;
  fields: Record<string, unknown>;
  version: number;
  is_active: boolean;
  expires_at: string;
}

/** Result of asking the engine to handle one inbound message. */
export interface CustomFlowHandleResult {
  /** True when the engine owned the message (session active or flow started). */
  handled: boolean;
}
