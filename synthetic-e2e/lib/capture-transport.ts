/**
 * Capture-only WhatsApp transport.
 *
 * Intercepts all outbound WhatsApp sends and captures them for inspection
 * without making any actual Meta Cloud API calls.
 *
 * Issue #728 safety gate 3: Assert zero Meta outbound API calls.
 * This is the primary safety mechanism — even if a real access token
 * is accidentally configured, no messages will be sent.
 */

import { assertNotMetaGraphApi } from './environment-guard';

// ── Types ──

export interface CapturedMessage {
  id: string;
  timestamp: string;
  to: string;
  type: 'text' | 'buttons' | 'list' | 'image' | 'template' | 'reaction' | 'unknown';
  content: unknown;
  /** The raw API request body that would have been sent */
  rawBody?: unknown;
  /** Journey context for correlation */
  journeyId?: string;
  stepIndex?: number;
}

export interface CaptureTransportStats {
  totalCaptured: number;
  byType: Record<string, number>;
  metaApiCallsBlocked: number;
}

// ── Transport ──

/**
 * In-memory capture transport that records all outbound messages.
 * Thread-safe for single-process test runs.
 */
export class CaptureTransport {
  private messages: CapturedMessage[] = [];
  private metaApiCallsBlocked = 0;

  /**
   * Record an outbound message. Called in place of the real Meta API send.
   */
  capture(message: Omit<CapturedMessage, 'id' | 'timestamp'>): CapturedMessage {
    const captured: CapturedMessage = {
      ...message,
      id: `cap_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      timestamp: new Date().toISOString(),
    };
    this.messages.push(captured);
    return captured;
  }

  /**
   * Assert that a URL is not a real Meta API endpoint.
   * Increments the blocked counter and throws.
   */
  blockMetaApiCall(url: string): never {
    this.metaApiCallsBlocked++;
    assertNotMetaGraphApi(url);
    // If assertNotMetaGraphApi didn't throw (shouldn't happen), throw anyway
    throw new Error(`FAIL-CLOSED: Meta API call blocked: ${url}`);
  }

  /**
   * Get all captured messages, optionally filtered by journey.
   */
  getMessages(journeyId?: string): CapturedMessage[] {
    if (journeyId) {
      return this.messages.filter(m => m.journeyId === journeyId);
    }
    return [...this.messages];
  }

  /**
   * Get the most recent captured message.
   */
  getLastMessage(): CapturedMessage | undefined {
    return this.messages[this.messages.length - 1];
  }

  /**
   * Get capture statistics.
   */
  getStats(): CaptureTransportStats {
    const byType: Record<string, number> = {};
    for (const msg of this.messages) {
      byType[msg.type] = (byType[msg.type] || 0) + 1;
    }
    return {
      totalCaptured: this.messages.length,
      byType,
      metaApiCallsBlocked: this.metaApiCallsBlocked,
    };
  }

  /**
   * Clear all captured messages. Used between test runs.
   */
  reset(): void {
    this.messages = [];
    this.metaApiCallsBlocked = 0;
  }

  /**
   * Assert that zero real Meta API calls were attempted.
   * This is the key safety assertion for issue #728.
   */
  assertZeroMetaCalls(): void {
    if (this.metaApiCallsBlocked > 0) {
      throw new Error(
        `SAFETY VIOLATION: ${this.metaApiCallsBlocked} Meta API call(s) were attempted ` +
        `and blocked during this test run. Investigate the call path.`
      );
    }
  }
}

/**
 * Global singleton for the current test run.
 * Reset between runs via resetGlobalCapture().
 */
let globalCapture: CaptureTransport | null = null;

export function getGlobalCapture(): CaptureTransport {
  if (!globalCapture) {
    globalCapture = new CaptureTransport();
  }
  return globalCapture;
}

export function resetGlobalCapture(): void {
  globalCapture?.reset();
  globalCapture = null;
}
