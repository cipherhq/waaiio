import { AlertTriangle, BadgeCheck, Server } from 'lucide-react';
import {
  ADMIN_BUILD_IDENTITY,
  shortBuildId,
  type AdminBuildIdentity,
  type LogicalAdminEnvironment,
} from '@/lib/buildIdentity';

const LABELS: Record<LogicalAdminEnvironment, string> = {
  production: 'PRODUCTION',
  staging: 'STAGING',
  development: 'DEVELOPMENT',
  unverified: 'UNVERIFIED',
};

const STYLES: Record<LogicalAdminEnvironment, string> = {
  production: 'border-red-300 bg-red-50 text-red-900',
  staging: 'border-amber-300 bg-amber-50 text-amber-900',
  development: 'border-slate-300 bg-slate-50 text-slate-700',
  unverified: 'border-red-400 bg-red-100 text-red-950',
};

export function EnvironmentIdentityBar({
  identity = ADMIN_BUILD_IDENTITY,
}: {
  identity?: AdminBuildIdentity;
}) {
  const environment = identity.logicalEnvironment;
  const isUnverified = environment === 'unverified';

  return (
    <div
      data-testid="admin-environment-identity"
      className={`shrink-0 border-b px-4 py-2 sm:px-6 lg:px-8 ${STYLES[environment]}`}
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
        <div className="flex items-center gap-1.5 font-bold tracking-wide">
          {isUnverified ? (
            <AlertTriangle className="h-4 w-4" aria-hidden="true" />
          ) : (
            <BadgeCheck className="h-4 w-4" aria-hidden="true" />
          )}
          <span>{LABELS[environment]}</span>
        </div>

        <div className="flex items-center gap-1.5">
          <Server className="h-3.5 w-3.5 opacity-70" aria-hidden="true" />
          <span>
            Admin SHA: <code className="font-mono font-semibold">{shortBuildId(identity.commitSha)}</code>
          </span>
        </div>

        {identity.deploymentId && (
          <span title={identity.deploymentId}>
            Deployment: <code className="font-mono">{shortBuildId(identity.deploymentId, 12)}</code>
          </span>
        )}

        {identity.projectId && (
          <span title={identity.projectId}>
            Project: <code className="font-mono">{shortBuildId(identity.projectId, 12)}</code>
          </span>
        )}

        {identity.apiOrigin && (
          <span>
            API: <code className="font-mono">{identity.apiOrigin}</code>
          </span>
        )}

        {identity.vercelTarget && (
          <span className="opacity-70">
            Vercel target: <code className="font-mono">{identity.vercelTarget}</code>
          </span>
        )}

        {isUnverified && (
          <span className="font-semibold">
            Logical environment is not configured. Do not infer production/staging from hostname or Vercel target.
          </span>
        )}
      </div>
    </div>
  );
}
