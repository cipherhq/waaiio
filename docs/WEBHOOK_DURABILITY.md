# Meta Webhook Failure and Retry Behavior

## Current Architecture

### Flow
1. Meta sends POST to `/api/webhook/meta-cloud`
2. Route verifies HMAC signature
3. For each message in the batch:
   a. Insert event into `processed_webhook_events` with `status='processing'`
   b. If event already exists and `status='completed'` → skip (dedup)
   c. If event is `status='processing'` and `last_attempted_at` > 60s → treat as stale, retry
   d. If event is `status='failed'` → retry (increment attempts)
   e. Process message synchronously (await bot.handleMessage)
   f. On success: update to `status='completed'`
   g. On failure: update to `status='failed'` + store error
4. Return HTTP 200

### What works
- **Deduplication:** Completed events are never reprocessed
- **Atomic claim:** Unique `event_id` constraint prevents two workers from claiming the same event
- **Stale detection:** Processing events older than 60s are treated as crashed
- **Failure recording:** Processing errors are stored with error message
- **Batch safety:** One message failure doesn't block others in the same batch
- **Concurrent safety:** Second delivery of same message skips if in-progress or completed

### Gap 1: No raw payload stored

The `processed_webhook_events` table does NOT have a `payload` column. When processing
fails, only `event_id`, `last_error`, and `attempts` are recorded — the original message
content is lost. A retry worker cannot reconstruct and replay the failed message.

### Gap 2: Stale claim is not atomic

The stale detection (line 405-416) uses SELECT + UPDATE, not an atomic claim. Two
concurrent workers could both read `status='failed'`, both pass the check, and both
attempt to process the same event.

### Gap 3: No durable retry after HTTP 200

The route always returns 200 to Meta. If processing fails:
- Event is marked `failed` in the database
- Meta will NOT retry (it received 200)
- No cron/worker picks up failed events for retry
- The failure is recorded but unrecoverable (payload not stored)

**Why 200 is returned even on failure:**
- Meta retries failed deliveries (non-200) up to 3 times over 12 hours
- Each retry contains the ENTIRE batch (all messages in that entry)
- If one message in a batch fails and we return non-200, Meta retries ALL messages
- Successfully processed messages would be re-delivered → must be deduplicated
- Current dedup handles this, but the retry volume multiplies under load

### Risk assessment
- **Severity:** Medium (not High — see justification)
- **Impact:** Occasional lost conversational messages when processing fails
- **Frequency:** Low (processing failures are caught and error-messaged to user)
- **Mitigation:** User receives "Sorry, we encountered an error. Please try again."
- **Why Medium, not High:**
  - No financial data is lost (payments recorded separately in payments table)
  - No booking/order corruption (atomic RPCs protect those)
  - Only conversational state is affected (bot session progress)
  - User can retry by sending the message again
  - The failure requires an exception AFTER event claim (uncommon)
  - No cross-tenant exposure or money loss

### Status: IN PROGRESS

Gaps 1-3 require architectural work beyond this PR:
1. Add `payload JSONB` column to `processed_webhook_events`
2. Store raw webhook body before processing
3. Use atomic UPDATE ... RETURNING for stale claims
4. Add retry cron with exponential backoff

### Proposed solution (not implemented in this PR)

Add a lightweight cron job:

```sql
-- Find retryable events
SELECT event_id, gateway, event_type, payload
FROM processed_webhook_events
WHERE status = 'failed'
  AND attempts < 3
  AND last_attempted_at < NOW() - INTERVAL '5 minutes'
ORDER BY first_received_at
LIMIT 10;
```

The cron would:
1. Claim events (update status → 'processing', increment attempts)
2. Re-process using stored payload
3. Mark completed or failed
4. Exponential backoff: 5min, 15min, 45min

This is a resilience improvement, not a Critical/High defect. Messages that fail processing already send an error reply to the user, who can retry manually.
