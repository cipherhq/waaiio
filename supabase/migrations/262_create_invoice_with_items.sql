CREATE OR REPLACE FUNCTION public.create_invoice_with_items(
  p_invoice JSONB,
  p_items JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_invoice_id UUID;
  v_reference_code TEXT;
  v_item JSONB;
  v_sort INTEGER := 0;
BEGIN
  -- Insert invoice
  INSERT INTO public.invoices (
    business_id, customer_name, customer_phone, customer_email, customer_address,
    subtotal, tax_rate, tax_amount, discount_type, discount_value, discount_amount,
    total_amount, currency, issue_date, due_date, notes, terms,
    is_recurring, recurring_frequency, recurring_next_date, recurring_end_date, status
  ) VALUES (
    (p_invoice->>'business_id')::UUID,
    p_invoice->>'customer_name',
    p_invoice->>'customer_phone',
    p_invoice->>'customer_email',
    p_invoice->>'customer_address',
    (p_invoice->>'subtotal')::NUMERIC,
    (p_invoice->>'tax_rate')::NUMERIC,
    (p_invoice->>'tax_amount')::NUMERIC,
    p_invoice->>'discount_type',
    (p_invoice->>'discount_value')::NUMERIC,
    (p_invoice->>'discount_amount')::NUMERIC,
    (p_invoice->>'total_amount')::NUMERIC,
    p_invoice->>'currency',
    (p_invoice->>'issue_date')::DATE,
    (p_invoice->>'due_date')::DATE,
    p_invoice->>'notes',
    p_invoice->>'terms',
    COALESCE((p_invoice->>'is_recurring')::BOOLEAN, false),
    p_invoice->>'recurring_frequency',
    (p_invoice->>'recurring_next_date')::DATE,
    (p_invoice->>'recurring_end_date')::DATE,
    COALESCE(p_invoice->>'status', 'draft')
  )
  RETURNING id, reference_code INTO v_invoice_id, v_reference_code;

  -- Insert all items in the same transaction
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    INSERT INTO public.invoice_items (
      invoice_id, description, quantity, unit_price, amount, sort_order
    ) VALUES (
      v_invoice_id,
      v_item->>'description',
      (v_item->>'quantity')::NUMERIC,
      (v_item->>'unit_price')::NUMERIC,
      (v_item->>'amount')::NUMERIC,
      v_sort
    );
    v_sort := v_sort + 1;
  END LOOP;

  RETURN jsonb_build_object('id', v_invoice_id, 'reference_code', v_reference_code);
END;
$$;


-- ── 4. Replace package session deduction RPC ────────────
-- Fixes from migration 247:
-- - UNIQUE(booking_id) not UNIQUE(enrollment_id, booking_id) — prevents replay selecting another enrollment
-- - Validates booking belongs to business and service
-- - Uses search_path='' with schema-qualified refs

