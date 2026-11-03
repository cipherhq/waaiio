WITH pe AS (
 SELECT p.*,CASE WHEN booking_id IS NOT NULL THEN 'booking_id' WHEN invoice_id IS NOT NULL THEN 'invoice_id' WHEN order_id IS NOT NULL THEN 'order_id' END kind,
 COALESCE(booking_id,invoice_id,order_id) entity_id FROM public.payments p
), candidates AS (
 SELECT p.id,p.business_id,p.kind,p.entity_id,p.status,p.currency,
 (SELECT count(*) FROM pe s WHERE s.business_id=p.business_id AND (to_jsonb(s)->>p.kind)::uuid=p.entity_id) sibling_count,
 (SELECT count(*) FROM public.platform_fees f WHERE f.business_id=p.business_id AND (to_jsonb(f)->>p.kind)::uuid=p.entity_id AND f.payment_id IS NULL) legacy_fee_count,
 (SELECT count(*) FROM public.platform_fees f WHERE (to_jsonb(f)->>p.kind)::uuid=p.entity_id AND (f.business_id IS DISTINCT FROM p.business_id OR f.is_direct_transfer IS DISTINCT FROM false OR f.payment_id IS NOT NULL)) unsafe_fee_count
 FROM pe p WHERE p.kind IS NOT NULL
), ambiguous AS (
 SELECT * FROM candidates WHERE legacy_fee_count>0 AND (sibling_count<>1 OR legacy_fee_count<>1)
), unresolved AS (
 SELECT f.business_id,'unlinked_platform_held_fee' reason,'platform_fees' source_table,f.id source_id
 FROM public.platform_fees f WHERE f.is_direct_transfer=false AND f.payment_id IS NULL
 UNION ALL SELECT f.business_id,'linked_platform_fee_currency_or_identity','platform_fees',f.id
 FROM public.platform_fees f LEFT JOIN public.payments p ON p.id=f.payment_id
 WHERE f.is_direct_transfer=false AND f.payment_id IS NOT NULL AND (p.id IS NULL OR p.business_id IS DISTINCT FROM f.business_id OR p.currency IS NULL OR p.currency !~ '^[A-Z]{3}$' OR (f.booking_id IS NOT NULL AND f.booking_id IS DISTINCT FROM p.booking_id) OR (f.invoice_id IS NOT NULL AND f.invoice_id IS DISTINCT FROM p.invoice_id) OR (f.order_id IS NOT NULL AND f.order_id IS DISTINCT FROM p.order_id))
 UNION ALL SELECT business_id,'payout_currency_unclassified','business_payouts',id FROM public.business_payouts WHERE currency IS NULL OR currency !~ '^[A-Z]{3}$'
 UNION ALL SELECT business_id,'adjustment_currency_unclassified','payout_adjustments',id FROM public.payout_adjustments WHERE currency IS NULL OR currency !~ '^[A-Z]{3}$'
), domains AS (SELECT DISTINCT business_id FROM unresolved WHERE business_id IS NOT NULL), snapshots AS (
 SELECT 'businesses' source_table,b.id,b.id business_id,encode(sha256(convert_to(to_jsonb(b)::text,'UTF8')),'hex') row_sha256 FROM public.businesses b JOIN domains d ON d.business_id=b.id
 UNION ALL SELECT 'platform_fees',f.id,f.business_id,encode(sha256(convert_to(to_jsonb(f)::text,'UTF8')),'hex') FROM public.platform_fees f JOIN domains d USING(business_id)
 UNION ALL SELECT 'business_payouts',p.id,p.business_id,encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') FROM public.business_payouts p JOIN domains d USING(business_id)
 UNION ALL SELECT 'payout_adjustments',a.id,a.business_id,encode(sha256(convert_to(to_jsonb(a)::text,'UTF8')),'hex') FROM public.payout_adjustments a JOIN domains d USING(business_id)
 UNION ALL SELECT 'refunds',r.id,r.business_id,encode(sha256(convert_to(to_jsonb(r)::text,'UTF8')),'hex') FROM public.refunds r JOIN domains d USING(business_id)
 UNION ALL SELECT 'payments',p.id,p.business_id,encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') FROM public.payments p JOIN domains d USING(business_id)
)
SELECT jsonb_build_object(
 'observed_at',transaction_timestamp(),'database',current_database(),'read_only',current_setting('transaction_read_only'),
 'domains',COALESCE((SELECT jsonb_agg(jsonb_build_object('business_id',d.business_id,'status',b.status,'payout_mode',b.payout_mode,'reasons',(SELECT jsonb_agg(to_jsonb(u) ORDER BY reason,source_id) FROM unresolved u WHERE u.business_id=d.business_id)) ORDER BY d.business_id) FROM domains d LEFT JOIN public.businesses b ON b.id=d.business_id),'[]'),
 'ambiguous_payments',COALESCE((SELECT jsonb_agg(to_jsonb(a) ORDER BY business_id,entity_id,id) FROM ambiguous a),'[]'),
 'membership_inputs',COALESCE((SELECT jsonb_agg(jsonb_build_object('payment_id',a.id,'business_id',a.business_id,'entity_kind',a.kind,'entity_id',a.entity_id,'status',a.status,'currency',a.currency,'payment_row_sha256',encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex'),'fee_ids',(SELECT jsonb_agg(f.id ORDER BY f.id) FROM public.platform_fees f WHERE (to_jsonb(f)->>a.kind)::uuid=a.entity_id)) ORDER BY a.business_id,a.id) FROM ambiguous a JOIN public.payments p ON p.id=a.id WHERE unsafe_fee_count=0),'[]'),
 'unsupported_ambiguous_count',(SELECT count(*) FROM ambiguous WHERE unsafe_fee_count<>0),
 'unknown_custody_fee_count',(SELECT count(*) FROM public.platform_fees WHERE is_direct_transfer IS NULL),
 'global_inflight_refunds',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',id,'business_id',business_id,'payment_id',payment_id,'status',status,'row_sha256',encode(sha256(convert_to(to_jsonb(r)::text,'UTF8')),'hex')) ORDER BY id) FROM public.refunds r WHERE status IN('pending','provider_pending','provider_ambiguous','provider_success_unfinalized')),'[]'),
 'domain_inflight_payouts',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',p.id,'business_id',p.business_id,'status',p.status,'row_sha256',encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex')) ORDER BY p.id) FROM public.business_payouts p JOIN domains d USING(business_id) WHERE p.status IN('approved','processing','review_required')),'[]'),
 'before_rows',COALESCE((SELECT jsonb_agg(to_jsonb(s) ORDER BY source_table,id) FROM snapshots s),'[]'),
 'counts',jsonb_build_object('hold_businesses',(SELECT count(*) FROM domains),'membership_payments',(SELECT count(*) FROM ambiguous WHERE unsafe_fee_count=0),'unlinked_fees_all',(SELECT count(*) FROM public.platform_fees WHERE payment_id IS NULL),'unlinked_held_fees',(SELECT count(*) FROM public.platform_fees WHERE payment_id IS NULL AND is_direct_transfer=false),'null_currency_payouts',(SELECT count(*) FROM public.business_payouts WHERE currency IS NULL))
) AS enrollment_discovery;
