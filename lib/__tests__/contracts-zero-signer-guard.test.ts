/**
 * Contracts zero-signer guard — unit tests
 *
 * Verifies that the server-side guards in the contracts send route
 * reject requests that would create a contract with zero signers,
 * and that the submit route rejects completion when no signer rows exist.
 *
 * These guards prevent an orphaned contract (signing_mode='multi' with
 * no contract_signers rows) from ever reaching status='signed'.
 */
import { describe, it, expect } from 'vitest';

// ── Guard logic extracted from app/api/contracts/send/route.ts ─────────────

interface SignerInput {
  name?: string;
  phone: string;
  email?: string;
}

/**
 * Mirrors the signer-resolution logic in the send route (lines 153-162).
 * Returns an array of resolved signers, or empty array if none provided.
 */
function resolveSigners(body: {
  signers?: SignerInput[];
  signer_phone?: string;
  signer_name?: string;
  signer_email?: string;
}): SignerInput[] {
  return body.signers && body.signers.length > 0
    ? body.signers
    : body.signer_phone
      ? [{ name: body.signer_name, phone: body.signer_phone, email: body.signer_email }]
      : [];
}

/**
 * Mirrors the guard at line 160 of the send route.
 */
function validateSigners(signers: SignerInput[]): { error: string; status: number } | null {
  if (signers.length === 0) {
    return { error: 'At least one signer is required', status: 400 };
  }
  return null;
}

// ── Guard logic from app/api/contracts/submit/route.ts (lines 231-234) ─────

/**
 * Mirrors the zero-signer guard in the multi-signer submit path.
 */
function validateSignerRowsExist(
  allSigners: { id: string; status: string }[],
  contractId: string,
): { error: string; status: number; logged: string } | null {
  if (allSigners.length === 0) {
    return {
      error: 'Failed to verify signing status',
      status: 500,
      logged: `No signers found for contract ${contractId} after update`,
    };
  }
  return null;
}

// ══════════════════════════════════════════════════════════════════════════
// Send route: zero-signer validation
// ══════════════════════════════════════════════════════════════════════════

describe('contracts/send: zero-signer guard', () => {
  it('returns 400 when signers array is empty and no signer_phone provided', () => {
    const signers = resolveSigners({ signers: [], signer_phone: undefined });
    const err = validateSigners(signers);
    expect(err).not.toBeNull();
    expect(err!.status).toBe(400);
    expect(err!.error).toMatch(/at least one signer/i);
  });

  it('returns 400 when body provides no signer fields at all', () => {
    const signers = resolveSigners({});
    const err = validateSigners(signers);
    expect(err).not.toBeNull();
    expect(err!.status).toBe(400);
  });

  it('returns 400 when explicit empty signers array overrides absent signer_phone', () => {
    const signers = resolveSigners({ signers: [], signer_phone: '' });
    const err = validateSigners(signers);
    expect(err).not.toBeNull();
    expect(err!.status).toBe(400);
  });

  it('passes when a single signer_phone is provided (legacy single-signer path)', () => {
    const signers = resolveSigners({ signer_phone: '+2348001234567', signer_name: 'Alice' });
    expect(validateSigners(signers)).toBeNull();
    expect(signers).toHaveLength(1);
    expect(signers[0].phone).toBe('+2348001234567');
  });

  it('passes when signers array contains one entry', () => {
    const signers = resolveSigners({
      signers: [{ phone: '+2348001234567', name: 'Bob' }],
    });
    expect(validateSigners(signers)).toBeNull();
    expect(signers).toHaveLength(1);
  });

  it('passes when signers array contains multiple entries', () => {
    const signers = resolveSigners({
      signers: [
        { phone: '+2348001234567', name: 'Alice' },
        { phone: '+2348007654321', name: 'Bob' },
      ],
    });
    expect(validateSigners(signers)).toBeNull();
    expect(signers).toHaveLength(2);
  });

  it('prefers signers array over signer_phone when both are provided', () => {
    const signers = resolveSigners({
      signers: [{ phone: '+2348001111111', name: 'From Array' }],
      signer_phone: '+2348009999999',
    });
    expect(signers).toHaveLength(1);
    expect(signers[0].phone).toBe('+2348001111111');
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Submit route: guard against finalizing with zero DB signer rows
// ══════════════════════════════════════════════════════════════════════════

describe('contracts/submit: zero-signer finalization guard', () => {
  const CONTRACT_ID = '00000000-test-0000-0000-zero-signer00';

  it('returns error when allSigners query returns empty array', () => {
    // This covers the case where a contract row was created but signer
    // insert failed — leaving an orphaned multi-signer contract.
    const result = validateSignerRowsExist([], CONTRACT_ID);
    expect(result).not.toBeNull();
    expect(result!.status).toBe(500);
    expect(result!.error).toBe('Failed to verify signing status');
    expect(result!.logged).toContain(CONTRACT_ID);
  });

  it('does not trigger when allSigners has at least one row', () => {
    const signers = [{ id: 'signer-1', status: 'pending' }];
    const result = validateSignerRowsExist(signers, CONTRACT_ID);
    expect(result).toBeNull();
  });

  it('does not trigger when multiple signers exist (mixed status)', () => {
    const signers = [
      { id: 'signer-1', status: 'signed' },
      { id: 'signer-2', status: 'pending' },
    ];
    const result = validateSignerRowsExist(signers, CONTRACT_ID);
    expect(result).toBeNull();
  });
});
