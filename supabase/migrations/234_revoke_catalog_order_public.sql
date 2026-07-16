-- Revoke public/anon/authenticated execution of the atomic catalog order function.
-- Only service_role should be able to call this (via the API route).
-- The function is SECURITY DEFINER so unauthorized callers could create fake orders.

REVOKE ALL ON FUNCTION create_catalog_order_atomic(UUID, UUID, TEXT, TEXT, TEXT, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION create_catalog_order_atomic(UUID, UUID, TEXT, TEXT, TEXT, JSONB) FROM anon;
REVOKE ALL ON FUNCTION create_catalog_order_atomic(UUID, UUID, TEXT, TEXT, TEXT, JSONB) FROM authenticated;
GRANT EXECUTE ON FUNCTION create_catalog_order_atomic(UUID, UUID, TEXT, TEXT, TEXT, JSONB) TO service_role;
