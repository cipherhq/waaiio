-- Migration 545: short-lived WhatsApp delivery waits (#1070).
-- The server registers a row right after sending a WhatsApp image or document
-- it wants delivered before the next message, the Meta status webhook moves
-- the row forward (sent -> delivered -> read; failed always wins), and the
-- sender deletes its rows when the bounded wait ends. Rows exist only for
-- awaited messages and only for seconds. Server-only: RLS on, no client
-- policies, service_role is the only role with table privileges.

CREATE TABLE IF NOT EXISTS public.whatsapp_delivery_waits (
  wamid TEXT PRIMARY KEY CHECK (length(btrim(wamid)) BETWEEN 1 AND 255),
  status TEXT NOT NULL DEFAULT 'sent' CHECK (status IN ('sent', 'delivered', 'read', 'failed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_whatsapp_delivery_waits_created_at
  ON public.whatsapp_delivery_waits (created_at);

ALTER TABLE public.whatsapp_delivery_waits ENABLE ROW LEVEL SECURITY;

REVOKE ALL PRIVILEGES ON public.whatsapp_delivery_waits FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL PRIVILEGES ON public.whatsapp_delivery_waits FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL PRIVILEGES ON public.whatsapp_delivery_waits FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    REVOKE ALL PRIVILEGES ON public.whatsapp_delivery_waits FROM service_role;
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.whatsapp_delivery_waits TO service_role;
  END IF;
END $$;

-- Migration self-check: final state must match the contract above.
DO $$
DECLARE
  v_table REGCLASS := 'public.whatsapp_delivery_waits'::regclass;
  v_priv TEXT;
BEGIN
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = v_table) THEN
    RAISE EXCEPTION 'M545 verification failed: RLS is not enabled on whatsapp_delivery_waits';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'whatsapp_delivery_waits') THEN
    RAISE EXCEPTION 'M545 verification failed: whatsapp_delivery_waits must have no client policies';
  END IF;

  FOREACH v_priv IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') AND has_table_privilege('anon', v_table, v_priv) THEN
      RAISE EXCEPTION 'M545 verification failed: anon has % on whatsapp_delivery_waits', v_priv;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') AND has_table_privilege('authenticated', v_table, v_priv) THEN
      RAISE EXCEPTION 'M545 verification failed: authenticated has % on whatsapp_delivery_waits', v_priv;
    END IF;
  END LOOP;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    FOREACH v_priv IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE'] LOOP
      IF NOT has_table_privilege('service_role', v_table, v_priv) THEN
        RAISE EXCEPTION 'M545 verification failed: service_role lacks % on whatsapp_delivery_waits', v_priv;
      END IF;
    END LOOP;
    IF has_table_privilege('service_role', v_table, 'TRUNCATE') THEN
      RAISE EXCEPTION 'M545 verification failed: service_role must not have TRUNCATE on whatsapp_delivery_waits';
    END IF;
  END IF;
END $$;
