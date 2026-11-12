/** #591 — Server-side Meta Flow asset lifecycle. No mutation retries. */
import { nativeFormsEnabled } from './release-gate';

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
  wabaId?: string;
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

const PROVIDER_ID = /^[0-9]{1,64}$/;

function validateToken(metaAccessToken: string): void {
  if (!metaAccessToken || typeof metaAccessToken !== 'string' || metaAccessToken.trim().length < 10) {
    throw new MetaFlowApiError('A valid Meta access token is required.');
  }
}

function validateFlowId(flowId: string): void {
  if (!flowId || typeof flowId !== 'string' || !PROVIDER_ID.test(flowId)) {
    throw new MetaFlowApiError('A valid flow ID is required.');
  }
}

function validateWabaId(wabaId: string): void {
  if (!wabaId || typeof wabaId !== 'string' || !PROVIDER_ID.test(wabaId)) {
    throw new MetaFlowApiError('A valid WABA ID is required.');
  }
}

async function request(token: string, path: string, body?: Record<string, unknown> | FormData): Promise<Record<string, unknown>> {
  if (!nativeFormsEnabled()) {
    throw new MetaFlowApiError('Provider calls not authorized. Native forms are not enabled.', 403);
  }
  const version = process.env.META_GRAPH_API_VERSION || 'v22.0';
  if (!/^v\d+\.0$/.test(version)) throw new MetaFlowApiError('Invalid Graph API version.');
  const multipart = body instanceof FormData;
  let response: Response;
  try {
    response = await fetch(`https://graph.facebook.com/${version}/${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${token}`, ...(body && !multipart ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? (multipart ? body : JSON.stringify(body)) : undefined,
      signal: AbortSignal.timeout(15_000),
      cache: 'no-store',
      redirect: 'error',
    });
  } catch {
    // Ambiguous mutation outcomes must be inspected, never automatically retried.
    throw new MetaFlowApiError('Meta Flow request did not complete. Check provider state before retrying.', 502);
  }
  let data: Record<string, unknown>;
  try { data = await response.json(); } catch { throw new MetaFlowApiError('Invalid Meta Flow response.', 502); }
  if (!response.ok || data.error) {
    const code = (data.error as { code?: number } | undefined)?.code;
    // Do not echo provider error text, request URLs, credentials or submitted data.
    throw new MetaFlowApiError('Meta rejected the Flow request.', response.status, code);
  }
  return data;
}

function errors(data: Record<string, unknown>): FlowUploadResult['validationErrors'] {
  return Array.isArray(data.validation_errors) ? data.validation_errors as FlowUploadResult['validationErrors'] : undefined;
}

// ── Public API ──

/**
 * Create a new Flow asset under a WhatsApp Business Account.
 * POST /{WABA_ID}/flows
 *
 * @throws MetaFlowApiError when disabled, invalid, or the provider rejects the request.
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

  const allowed = new Set<FlowCategory>(['SIGN_UP', 'SIGN_IN', 'APPOINTMENT_BOOKING', 'LEAD_GENERATION', 'CONTACT_US', 'CUSTOMER_SUPPORT', 'SURVEY', 'OTHER']);
  if (categories.some(category => !allowed.has(category))) throw new MetaFlowApiError('Invalid flow category.');
  const data = await request(metaAccessToken, `${wabaId}/flows`, { name: name.trim(), categories });
  if (typeof data.id !== 'string' || !PROVIDER_ID.test(data.id)) throw new MetaFlowApiError('Meta did not return a valid Flow ID.', 502);
  return { flowId: data.id, name: name.trim(), status: 'DRAFT' };
}

/**
 * Upload Flow JSON to an existing Flow asset.
 * POST /{flow_id}/assets
 *
 * @throws MetaFlowApiError when disabled, invalid, or the provider rejects the request.
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

  const body = new FormData();
  body.set('name', 'flow.json');
  body.set('asset_type', 'FLOW_JSON');
  body.set('file', new Blob([JSON.stringify(flowJson)], { type: 'application/json' }), 'flow.json');
  const data = await request(metaAccessToken, `${flowId}/assets`, body);
  return { flowId, success: data.success === true && !errors(data)?.length, validationErrors: errors(data) };
}

/**
 * Publish a Flow asset (transitions DRAFT → PUBLISHED).
 * POST /{flow_id}/publish
 *
 * @throws MetaFlowApiError when disabled, invalid, or the provider rejects the request.
 */
export async function publishFlow(
  metaAccessToken: string,
  flowId: string,
): Promise<FlowPublishResult> {
  validateToken(metaAccessToken);
  validateFlowId(flowId);

  const data = await request(metaAccessToken, `${flowId}/publish`, {});
  return { flowId, success: data.success === true };
}

/**
 * Get the current status of a Flow asset.
 * GET /{flow_id}
 *
 * @throws MetaFlowApiError when disabled, invalid, or the provider rejects the request.
 */
export async function getFlowStatus(
  metaAccessToken: string,
  flowId: string,
): Promise<FlowStatusResult> {
  validateToken(metaAccessToken);
  validateFlowId(flowId);

  const data = await request(metaAccessToken, `${flowId}?fields=id,name,status,categories,validation_errors,whatsapp_business_account`);
  if (data.id !== flowId || !['DRAFT', 'PUBLISHED', 'DEPRECATED', 'BLOCKED', 'THROTTLED'].includes(String(data.status))) {
    throw new MetaFlowApiError('Invalid Meta Flow status response.', 502);
  }
  return { flowId, name: String(data.name || ''), status: data.status as FlowStatusResult['status'],
    categories: Array.isArray(data.categories) ? data.categories as FlowCategory[] : [], validationErrors: errors(data),
    wabaId: (data.whatsapp_business_account as { id?: string } | undefined)?.id };
}

/**
 * Deprecate a published Flow asset.
 * POST /{flow_id}/deprecate
 *
 * @throws MetaFlowApiError when disabled, invalid, or the provider rejects the request.
 */
export async function deprecateFlow(
  metaAccessToken: string,
  flowId: string,
): Promise<FlowDeprecateResult> {
  validateToken(metaAccessToken);
  validateFlowId(flowId);

  const data = await request(metaAccessToken, `${flowId}/deprecate`, {});
  return { flowId, success: data.success === true };
}
