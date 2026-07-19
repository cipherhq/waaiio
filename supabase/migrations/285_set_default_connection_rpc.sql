-- ═══════════════════════════════════════════════════════
-- 285: Atomic set-default-connection RPC + constraints
-- ═══════════════════════════════════════════════════════

-- One non-revoked secret per payout connection
CREATE UNIQUE INDEX IF NOT EXISTS idx_connection_secrets_one_active
  ON public.business_connection_secrets (payout_account_id)
  WHERE revoked_at IS NULL;

-- Prevent browser clients from directly updating sensitive fields
-- (connection_status, is_default, health_status, connection_mode)
-- Owner can only update safe display fields via RLS
-- Sensitive mutations go through server-side RPCs/API routes
