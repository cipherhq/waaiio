-- Dashboard aggregate RPC functions
-- Replaces client-side JS reduce over potentially thousands of rows with server-side SUM.

-- Sum revenue for a business (from platform_fees)
CREATE OR REPLACE FUNCTION get_business_revenue(p_business_id uuid)
RETURNS bigint LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(SUM(transaction_amount), 0)::bigint
  FROM platform_fees
  WHERE business_id = p_business_id AND refunded_at IS NULL;
$$;

-- Sum order revenue for a business
CREATE OR REPLACE FUNCTION get_order_revenue(p_business_id uuid)
RETURNS bigint LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(SUM(total_amount), 0)::bigint
  FROM orders
  WHERE business_id = p_business_id
    AND deleted_at IS NULL
    AND status IN ('confirmed', 'processing', 'ready', 'shipped', 'delivered');
$$;

-- Sum outstanding invoices for a business
CREATE OR REPLACE FUNCTION get_outstanding_invoices(p_business_id uuid)
RETURNS bigint LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(SUM(total_amount), 0)::bigint
  FROM invoices
  WHERE business_id = p_business_id
    AND status IN ('sent', 'viewed', 'overdue');
$$;

-- Grant execute to dashboard users and service role
GRANT EXECUTE ON FUNCTION get_business_revenue(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION get_order_revenue(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION get_outstanding_invoices(uuid) TO authenticated, service_role;
