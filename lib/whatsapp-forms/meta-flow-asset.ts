/**
 * #591 Phase 2 — Meta Flow Asset Service.
 *
 * Service abstraction for the Meta WhatsApp Flows lifecycle API.
 * All functions are typed and validated, but NO live API calls are made
 * in this phase. Every function throws MetaFlowApiError with
 * "provider calls not authorized" if actually invoked — real fetch()
 * calls will be enabled in a future phase after provider authorization.
 *
 * Meta Flows API reference:
 * https://developers.facebook.com/docs/whatsapp/flows/reference/flowsapi
 */

// ── Types ──

export class MetaFlowApiError extends Error {
  public readonly statusCode?: number;
  public readonly metaErrorCode?: number;

  constructor(message: string, statusCode?: number, metaErrorCode?: number) {
    super(message);
    this.name = 'MetaFlowApiError';
    this.statusCode = statusCode;
    this.metaErrorCode = metaErrorCode;
  }
}

export type FlowCategory = 'SIGN_UP' | 'SIGN_IN' | 'APPOINTMENT_BOOKING' | 'LEAD_GENERATION' |
  'CONTACT_US' | 'CUSTOMER_SUPPORT' | 'SURVEY' | 'OTHER';

export interface FlowAssetResult {
  flowId: string;
  name: string;
  status: string;
}

export interface FlowStatusResult {
  flowId: string;
  name: string;
  status: 'DRAFT' | 'PUBLISHED' | 'DEPRECATED' | 'BLOCKED' | 'THROTTLED';
  categories: FlowCategory[];
  validationErrors?: Array<{ error: string; error_type: string; message: string }>;
}

export interface FlowUploadResult {
  flowId: string;
  success: boolean;
  validationErrors?: Array<{ error: string; error_type: string; message: string }>;
}

export interface FlowPublishResult {
  flowId: string;
  success: boolean;
}

export interface FlowDeprecateResult {
  flowId: string;
  success: boolean;
}

// ── Validation helpers ──

const UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

function validateToken(metaAccessToken: string): void {
  if (!metaAccessToken || typeof metaAccessToken !== 'string' || metaAccessToken.trim().length < 10) {
    throw new MetaFlowApiError('A valid Meta access token is required.');
  }
}

function validateFlowId(flowId: string): void {
  if (!flowId || typeof flowId !== 'string' || flowId.trim().length === 0) {
    throw new MetaFlowApiError('A valid flow ID is required.');
  }
}

function validateWabaId(wabaId: string): void {
  if (!wabaId || typeof wabaId !== 'string' || wabaId.trim().length === 0) {
    throw new MetaFlowApiError('A valid WABA ID is required.');
  }
}

function notAuthorized(): never {
  throw new MetaFlowApiError(
    'Provider calls not authorized. Meta Flow API calls require separate provider authorization.',
    403,
  );
}

// ── Public API ──

/**
 * Create a new Flow asset under a WhatsApp Business Account.
 * POST /{WABA_ID}/flows
 *
 * @throws MetaFlowApiError — always in Phase 2 (provider calls not authorized)
 */
export async function createFlowAsset(
  metaAccessToken: string,
  wabaId: string,
  name: string,
  categories: FlowCategory[],
): Promise<FlowAssetResult> {
  validateToken(metaAccessToken);
  validateWabaId(wabaId);

  if (!name || typeof name !== 'string' || name.trim().length === 0 || name.trim().length > 128) {
    throw new MetaFlowApiError('Flow name must be 1–128 characters.');
  }
  if (!Array.isArray(categories) || categories.length === 0) {
    throw new MetaFlowApiError('At least one flow category is required.');
  }

  // Phase 2 gate: no live API calls
  notAuthorized();
}

/**
 * Upload Flow JSON to an existing Flow asset.
 * POST /{flow_id}/assets
 *
 * @throws MetaFlowApiError — always in Phase 2 (provider calls not authorized)
 */
export async function uploadFlowJson(
  metaAccessToken: string,
  flowId: string,
  flowJson: Record<string, unknown>,
): Promise<FlowUploadResult> {
  validateToken(metaAccessToken);
  validateFlowId(flowId);

  if (!flowJson || typeof flowJson !== 'object' || Array.isArray(flowJson)) {
    throw new MetaFlowApiError('Flow JSON must be a non-null object.');
  }
  if (!flowJson.version || !flowJson.screens) {
    throw new MetaFlowApiError('Flow JSON must contain version and screens properties.');
  }

  // Phase 2 gate: no live API calls
  notAuthorized();
}

/**
 * Publish a Flow asset (transitions DRAFT → PUBLISHED).
 * POST /{flow_id}/publish
 *
 * @throws MetaFlowApiError — always in Phase 2 (provider calls not authorized)
 */
export async function publishFlow(
  metaAccessToken: string,
  flowId: string,
): Promise<FlowPublishResult> {
  validateToken(metaAccessToken);
  validateFlowId(flowId);

  // Phase 2 gate: no live API calls
  notAuthorized();
}

/**
 * Get the current status of a Flow asset.
 * GET /{flow_id}
 *
 * @throws MetaFlowApiError — always in Phase 2 (provider calls not authorized)
 */
export async function getFlowStatus(
  metaAccessToken: string,
  flowId: string,
): Promise<FlowStatusResult> {
  validateToken(metaAccessToken);
  validateFlowId(flowId);

  // Phase 2 gate: no live API calls
  notAuthorized();
}

/**
 * Deprecate a published Flow asset.
 * POST /{flow_id}/deprecate
 *
 * @throws MetaFlowApiError — always in Phase 2 (provider calls not authorized)
 */
export async function deprecateFlow(
  metaAccessToken: string,
  flowId: string,
): Promise<FlowDeprecateResult> {
  validateToken(metaAccessToken);
  validateFlowId(flowId);

  // Phase 2 gate: no live API calls
  notAuthorized();
}
