-- Secure revenue RPCs — add ownership check
-- Returns 0 for non-owners instead of raising an exception so the dashboard doesn't break

CREATE OR REPLACE FUNCTION get_business_revenue(p_business_id uuid)
RETURNS bigint LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM businesses WHERE id = p_business_id AND owner_id = auth.uid()) THEN
    RETURN 0;
  END IF;
  RETURN (SELECT COALESCE(SUM(transaction_amount), 0)::bigint FROM platform_fees WHERE business_id = p_business_id AND refunded_at IS NULL);
END;
$$;

CREATE OR REPLACE FUNCTION get_order_revenue(p_business_id uuid)
RETURNS bigint LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM businesses WHERE id = p_business_id AND owner_id = auth.uid()) THEN
    RETURN 0;
  END IF;
  RETURN (SELECT COALESCE(SUM(total_amount), 0)::bigint FROM orders WHERE business_id = p_business_id AND deleted_at IS NULL AND status IN ('confirmed','processing','ready','shipped','delivered'));
END;
$$;

CREATE OR REPLACE FUNCTION get_outstanding_invoices(p_business_id uuid)
RETURNS bigint LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM businesses WHERE id = p_business_id AND owner_id = auth.uid()) THEN
    RETURN 0;
  END IF;
  RETURN (SELECT COALESCE(SUM(total_amount), 0)::bigint FROM invoices WHERE business_id = p_business_id AND status IN ('sent','viewed','overdue'));
END;
$$;

-- Keep existing grants
GRANT EXECUTE ON FUNCTION get_business_revenue(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION get_order_revenue(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION get_outstanding_invoices(uuid) TO authenticated, service_role;
