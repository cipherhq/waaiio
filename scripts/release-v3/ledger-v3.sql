-- Release V3 migration ledger reading (schema 8). Read-only. One row per ledger
-- row. row_sha256 covers the whole row (version, statements, name, created_by,
-- idempotency_key, rollback). statement_sha256 is set only when the row holds
-- exactly one statement; new migrations are applied as one whole-file statement.
SELECT version, name,
 CASE WHEN statements IS NULL THEN NULL ELSE cardinality(statements) END AS statement_count,
 CASE WHEN cardinality(statements)=1 THEN encode(sha256(convert_to(statements[1],'UTF8')),'hex') END AS statement_sha256,
 encode(sha256(convert_to(to_jsonb(m)::text,'UTF8')),'hex') AS row_sha256
FROM supabase_migrations.schema_migrations m ORDER BY version COLLATE "C";
