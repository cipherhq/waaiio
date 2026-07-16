/**
 * Simple in-memory circuit breaker for external API calls.
 *
 * States:
 *  - closed: requests pass through normally
 *  - open: requests are rejected immediately (service assumed down)
 *  - half-open: one probe request allowed to test recovery
 *
 * After FAILURE_THRESHOLD consecutive failures the circuit opens.
 * After RESET_TIMEOUT_MS the circuit moves to half-open and allows one probe.
 * A success in half-open closes the circuit; a failure re-opens it.
 */

import * as Sentry from '@sentry/nextjs';

interface CircuitState {
  failures: number;
  lastFailure: number;
  state: 'closed' | 'open' | 'half-open';
}

const circuits = new Map<string, CircuitState>();

const FAILURE_THRESHOLD = 5;
const RESET_TIMEOUT_MS = 30_000; // 30 seconds

function getOrCreate(service: string): CircuitState {
  let state = circuits.get(service);
  if (!state) {
    state = { failures: 0, lastFailure: 0, state: 'closed' };
    circuits.set(service, state);
  }
  return state;
}

/**
 * Returns true if the circuit is open (service should NOT be called).
 * Automatically transitions open → half-open after the reset timeout.
 */
export function isCircuitOpen(service: string): boolean {
  const circuit = getOrCreate(service);

  if (circuit.state === 'closed') return false;

  if (circuit.state === 'open') {
    // Check if enough time has passed to allow a probe
    if (Date.now() - circuit.lastFailure >= RESET_TIMEOUT_MS) {
      circuit.state = 'half-open';
      Sentry.captureMessage(`Circuit breaker recovered: ${service}`, {
        level: 'info',
        tags: { component: 'circuit-breaker', circuit: service },
      });
      return false; // allow one probe request
    }
    return true; // still open
  }

  // half-open — allow the probe
  return false;
}

/**
 * Record a successful call. Resets the circuit to closed.
 */
export function recordSuccess(service: string): void {
  const circuit = getOrCreate(service);
  const wasOpen = circuit.state === 'half-open' || circuit.state === 'open';
  circuit.failures = 0;
  circuit.state = 'closed';
  if (wasOpen) {
    Sentry.captureMessage(`Circuit breaker recovered: ${service}`, {
      level: 'info',
      tags: { component: 'circuit-breaker', circuit: service },
    });
  }
}

/**
 * Record a failed call. Opens the circuit if threshold is reached.
 */
export function recordFailure(service: string): void {
  const circuit = getOrCreate(service);
  circuit.failures += 1;
  circuit.lastFailure = Date.now();

  if (circuit.failures >= FAILURE_THRESHOLD && circuit.state !== 'open') {
    circuit.state = 'open';
    Sentry.captureMessage(`Circuit breaker OPEN: ${service}`, {
      level: 'fatal',
      tags: { component: 'circuit-breaker', circuit: service },
    });
  }
}

/**
 * Get current circuit state for monitoring/logging.
 */
export function getCircuitState(service: string): CircuitState {
  return { ...getOrCreate(service) };
}

export class CircuitBreakerOpenError extends Error {
  constructor(service: string) {
    super(`Circuit breaker open for "${service}" — service is temporarily unavailable`);
    this.name = 'CircuitBreakerOpenError';
  }
}
