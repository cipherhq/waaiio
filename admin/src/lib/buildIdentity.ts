export type LogicalAdminEnvironment =
  | 'production'
  | 'staging'
  | 'development'
  | 'unverified';

export interface RawAdminBuildIdentity {
  logicalEnvironment?: string;
  commitSha?: string;
  deploymentId?: string;
  projectId?: string;
  vercelTarget?: string;
  apiUrl?: string;
}

export interface AdminBuildIdentity {
  logicalEnvironment: LogicalAdminEnvironment;
  commitSha: string | null;
  deploymentId: string | null;
  projectId: string | null;
  vercelTarget: string | null;
  apiOrigin: string | null;
  verified: boolean;
}

declare const __WAAIIO_ADMIN_BUILD_IDENTITY__: RawAdminBuildIdentity | undefined;

const ALLOWED_ENVIRONMENTS = new Set<LogicalAdminEnvironment>([
  'production',
  'staging',
  'development',
  'unverified',
]);

function clean(value: string | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function normalizeEnvironment(value: string | undefined): LogicalAdminEnvironment {
  const normalized = value?.trim().toLowerCase() as LogicalAdminEnvironment | undefined;
  return normalized && ALLOWED_ENVIRONMENTS.has(normalized) ? normalized : 'unverified';
}

function safeOrigin(value: string | undefined): string | null {
  const normalized = clean(value);
  if (!normalized) return null;
  try {
    return new URL(normalized).origin;
  } catch {
    return null;
  }
}

export function normalizeAdminBuildIdentity(raw: RawAdminBuildIdentity): AdminBuildIdentity {
  const logicalEnvironment = normalizeEnvironment(raw.logicalEnvironment);

  return {
    logicalEnvironment,
    commitSha: clean(raw.commitSha),
    deploymentId: clean(raw.deploymentId),
    projectId: clean(raw.projectId),
    vercelTarget: clean(raw.vercelTarget),
    apiOrigin: safeOrigin(raw.apiUrl),
    verified: logicalEnvironment !== 'unverified',
  };
}

export function shortBuildId(value: string | null, length = 10): string {
  if (!value) return 'unknown';
  return value.length <= length ? value : value.slice(0, length);
}

const injectedIdentity: RawAdminBuildIdentity =
  typeof __WAAIIO_ADMIN_BUILD_IDENTITY__ !== 'undefined'
    ? __WAAIIO_ADMIN_BUILD_IDENTITY__
    : {};

export const ADMIN_BUILD_IDENTITY = normalizeAdminBuildIdentity(injectedIdentity);
