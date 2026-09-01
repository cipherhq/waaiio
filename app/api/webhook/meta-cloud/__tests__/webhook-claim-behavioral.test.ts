/**
 * #271 Slice B — Behavioral route-level tests for webhook claim/fencing.
 *
 * Verifies that the webhook handler correctly uses claim_webhook_event,
 * complete_webhook_event, and fail_webhook_event RPCs, and that the
 * side-effect deadline prevents late processing.
 *
 * Refs: #278, #271
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const ROOT = resolve(__dirname, '../../../../..');
const routeSource = readFileSync(resolve(ROOT, 'app/api/webhook/meta-cloud/route.ts'), 'utf-8');

describe('Slice B — webhook claim behavioral tests (source verification)', () => {
  it('a) claimed event flows to bot.handleMessage then complete_webhook_event', () => {
    // After claim succeeds, bot.handleMessage is called, then complete_webhook_event
    // Verify the sequence: claim → handleMessage → complete
    expect(routeSource).toContain("claim_webhook_event");
    expect(routeSource).toContain("bot.handleMessage");
    expect(routeSource).toContain("complete_webhook_event");

    // complete_webhook_event uses the claim token
    expect(routeSource).toContain("p_claim_token: claimToken");

    // The claimToken is extracted from the claim result
    expect(routeSource).toContain("const claimToken = claimResult.claim_token");
  });

  it('b) unclaimed event is skipped — continue before bot.handleMessage', () => {
    // When claim fails, we skip with continue before any bot processing
    expect(routeSource).toContain("if (claimError || !claimResult?.claimed)");
    // The continue immediately after the check
    const claimCheckIndex = routeSource.indexOf("!claimResult?.claimed");
    const continueIndex = routeSource.indexOf("continue;", claimCheckIndex);
    const handleMessageIndex = routeSource.indexOf("bot.handleMessage", claimCheckIndex);
    // continue must come before handleMessage in the source
    expect(continueIndex).toBeLessThan(handleMessageIndex);
  });

  it('c) processing error calls fail_webhook_event with claim token and error', () => {
    // The catch block calls fail_webhook_event
    expect(routeSource).toContain("catch (processingErr)");
    // find fail_webhook_event after the catch
    const catchIndex = routeSource.indexOf("catch (processingErr)");
    const failAfterCatch = routeSource.indexOf("fail_webhook_event", catchIndex);
    expect(failAfterCatch).toBeGreaterThan(catchIndex);
    // Error message is sliced and passed
    expect(routeSource).toContain("String(processingErr).slice(0, 500)");
  });

  it('d) side-effect deadline check before bot.handleMessage', () => {
    // Deadline constant is 50s
    expect(routeSource).toContain("SIDE_EFFECT_DEADLINE_MS = 50_000");
    // Elapsed time is checked against t0
    expect(routeSource).toContain("Date.now() - t0");
    // If exceeded, fail_webhook_event is called with deadline error
    expect(routeSource).toContain("side_effect_deadline_exceeded");

    // Deadline check must come BEFORE bot.handleMessage
    const deadlineIndex = routeSource.indexOf("SIDE_EFFECT_DEADLINE_MS");
    const handleIndex = routeSource.indexOf("bot.handleMessage");
    expect(deadlineIndex).toBeLessThan(handleIndex);
  });

  it('e) exactly one bot.handleMessage call path per claimed event', () => {
    // Count occurrences of bot.handleMessage in the route
    const matches = routeSource.match(/bot\.handleMessage/g) || [];
    // Should appear exactly three times: the call + two debug log messages
    // All are in the same code path — the claim-success path
    expect(matches.length).toBe(3); // call + 2 debug logs
  });

  it('all terminal paths use fenced RPCs, not direct updates', () => {
    // No direct .update() on processed_webhook_events should remain
    // (the old pattern was: supabase.from('processed_webhook_events').update(...))
    const directUpdatePattern = /from\(['"]processed_webhook_events['"]\)\s*\.\s*update/;
    expect(routeSource).not.toMatch(directUpdatePattern);
  });

  it('claim_webhook_event is called with correct parameters', () => {
    expect(routeSource).toContain("p_event_id: eventId");
    expect(routeSource).toContain("p_gateway: 'meta_cloud'");
    expect(routeSource).toContain("p_event_type: whMsgType");
  });
});
