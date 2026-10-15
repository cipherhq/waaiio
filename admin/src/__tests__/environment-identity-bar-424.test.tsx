import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { EnvironmentIdentityBar } from '@/components/EnvironmentIdentityBar';
import type { AdminBuildIdentity } from '@/lib/buildIdentity';

function identity(overrides: Partial<AdminBuildIdentity> = {}): AdminBuildIdentity {
  return {
    logicalEnvironment: 'staging',
    commitSha: 'abcdef1234567890',
    deploymentId: 'dpl_1234567890',
    projectId: 'prj_1234567890',
    vercelTarget: 'production',
    apiOrigin: 'https://staging.waaiio.example',
    verified: true,
    ...overrides,
  };
}

describe('#424 persistent Admin environment identity UI', () => {
  it('shows STAGING from trusted logical identity even when Vercel target says production', () => {
    render(<EnvironmentIdentityBar identity={identity()} />);

    expect(screen.getByText('STAGING')).toBeInTheDocument();
    expect(screen.getByText(/Admin SHA:/i)).toBeInTheDocument();
    expect(screen.getByText('abcdef1234')).toBeInTheDocument();
    expect(screen.getByText('https://staging.waaiio.example')).toBeInTheDocument();
    expect(screen.getByText(/Vercel target:/i)).toBeInTheDocument();
    expect(screen.getByText('production')).toBeInTheDocument();
  });

  it('shows PRODUCTION prominently for a verified production build', () => {
    render(<EnvironmentIdentityBar identity={identity({
      logicalEnvironment: 'production',
      apiOrigin: 'https://www.waaiio.com',
    })} />);

    expect(screen.getByText('PRODUCTION')).toBeInTheDocument();
    expect(screen.getByText('https://www.waaiio.com')).toBeInTheDocument();
  });

  it('shows UNVERIFIED and a warning rather than guessing', () => {
    render(<EnvironmentIdentityBar identity={identity({
      logicalEnvironment: 'unverified',
      verified: false,
      commitSha: null,
      apiOrigin: null,
    })} />);

    expect(screen.getByText('UNVERIFIED')).toBeInTheDocument();
    expect(screen.getByText(/Logical environment is not configured/i)).toBeInTheDocument();
    expect(screen.getByText('unknown')).toBeInTheDocument();
  });
});
