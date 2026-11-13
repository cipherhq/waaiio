-- M539: Make admin_passkey_approvals' service_role rights explicit (Owner decision 2026-11-13).
--
-- M538 revoked PUBLIC/anon/authenticated and granted service_role SELECT,
-- INSERT, DELETE, but left service_role's default privileges in place.
-- Production's defaults give service_role every table right; staging's give
-- fewer, so the final ACL differed by environment. Revoking everything from
-- service_role first, then granting exactly the three rights the server uses,
-- makes the ACL identical everywhere and least-privilege.
--
-- M538 is already on main and immutable, so this is a separate migration.
-- Apply it together with M538. Every other M538 object already has an
-- explicit ACL (admin_session_mfa_state: all revoked, EXECUTE to service_role).
BEGIN;

REVOKE ALL ON TABLE public.admin_passkey_approvals FROM service_role;
GRANT SELECT, INSERT, DELETE ON TABLE public.admin_passkey_approvals TO service_role;

COMMIT;
