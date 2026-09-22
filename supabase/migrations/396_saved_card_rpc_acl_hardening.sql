-- Migration 396: harden saved-card RPC ACLs to service_role only.
-- Corrects direct/default EXECUTE grants observed after M395 in production.
DO $$
DECLARE
  f regprocedure;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.provision_stripe_customer_cas(text,text,text,text)'::regprocedure,
    'public.dispatch_customer_provisioning(uuid)'::regprocedure,
    'public.confirm_customer_provisioning(uuid,text)'::regprocedure,
    'public.claim_provider_cleanup_operation(text,integer,integer)'::regprocedure,
    'public.complete_provider_cleanup_operation(uuid,uuid,text)'::regprocedure,
    'public.release_provider_cleanup_operation(uuid,uuid,text)'::regprocedure,
    'public.create_provider_consented_offer(uuid,text,uuid,text,text,timestamptz,text,uuid,uuid)'::regprocedure,
    'public.commit_saved_card_offer(uuid,text,uuid,text,integer)'::regprocedure,
    'public.confirm_saved_card_offer(uuid,text)'::regprocedure,
    'public.atomic_stripe_revoke_and_enqueue(uuid,text,text)'::regprocedure,
    'public.claim_stale_customer_provisioning(text,integer,integer)'::regprocedure,
    'public.complete_customer_recovery(uuid,uuid,text,text,text)'::regprocedure,
    'public.claim_activation_delivery(integer)'::regprocedure,
    'public.complete_activation_delivery(uuid,uuid)'::regprocedure,
    'public.release_activation_delivery(uuid,uuid)'::regprocedure,
    'public.mark_activation_send_started(uuid,uuid)'::regprocedure
  ]
  LOOP
    EXECUTE format('REVOKE ALL PRIVILEGES ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('REVOKE ALL PRIVILEGES ON FUNCTION %s FROM anon', f);
    EXECUTE format('REVOKE ALL PRIVILEGES ON FUNCTION %s FROM authenticated', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
  END LOOP;
END
$$;
