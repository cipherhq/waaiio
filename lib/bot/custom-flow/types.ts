// ─────────────────────────────────────────────────────────────────────
// Waaiio Custom Flow — data-driven flow definitions (Issue #1013)
// Phase 1 node set: message, menu, lookup.
// Later phases add: ask, list, image, booking, payment_link,
// broadcast_opt_in, human_handoff, end. A node type is a platform change;
// a customer need is first tested against combinations of these nodes.
// ─────────────────────────────────────────────────────────────────────

export type CustomFlowNodeType = 'message' | 'menu' | 'lookup';

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

export type CustomFlowNode =
  | CustomFlowMessageNode
  | CustomFlowMenuNode
  | CustomFlowLookupNode;

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
