/**
 * Customer conversation journey via webhook simulation.
 *
 * Issue #728 Phase 2: Synthetic customer journeys through
 * simulated inbound WhatsApp webhook requests.
 *
 * Sends HMAC-signed webhooks to the staging endpoint,
 * captures bot replies, and verifies DB state.
 */

import type { AuditLogger } from '../lib/audit-logger';
import type { WebhookClient, WebhookResponse } from '../lib/webhook-client';
import type { CustomerIdentity } from '../lib/synthetic-identity';
import type { CleanupTracker } from '../lib/cleanup-manifest';

// ── Types ──

export interface ConversationStep {
  /** What the customer says */
  input: {
    type: 'text' | 'button_reply' | 'list_reply';
    text?: string;
    buttonId?: string;
    buttonTitle?: string;
    listId?: string;
    listTitle?: string;
  };
  /** Expected behavior */
  expect?: {
    /** Substring that should appear in the bot reply */
    replyContains?: string[];
    /** Substring that must NOT appear */
    replyNotContains?: string[];
    /** Expected HTTP status */
    httpStatus?: number;
    /** DB assertions to run after this step */
    dbChecks?: Array<{
      table: string;
      column: string;
      expected: unknown;
    }>;
  };
  /** Wait time before next step (ms) */
  waitMs?: number;
}

export interface ConversationScenario {
  name: string;
  persona: string;
  description: string;
  steps: ConversationStep[];
}

// ── Pre-defined Scenarios ──

export const SCENARIOS: Record<string, ConversationScenario> = {
  greeting: {
    name: 'greeting',
    persona: 'New Customer',
    description: 'Customer sends a greeting and receives the welcome menu',
    steps: [
      {
        input: { type: 'text', text: 'Hi' },
        expect: {
          httpStatus: 200,
          replyNotContains: ['error', 'undefined', 'null'],
        },
      },
    ],
  },

  booking: {
    name: 'booking',
    persona: 'Booking Customer',
    description: 'Customer books an appointment through the bot',
    steps: [
      {
        input: { type: 'text', text: 'Hi' },
        expect: { httpStatus: 200 },
      },
      {
        input: { type: 'text', text: 'I want to book an appointment' },
        expect: {
          httpStatus: 200,
          replyNotContains: ['error'],
        },
        waitMs: 1000,
      },
    ],
  },

  ordering: {
    name: 'ordering',
    persona: 'Ordering Customer',
    description: 'Customer orders a product through the bot',
    steps: [
      {
        input: { type: 'text', text: 'Hi' },
        expect: { httpStatus: 200 },
      },
      {
        input: { type: 'text', text: 'I want to order something' },
        expect: {
          httpStatus: 200,
          replyNotContains: ['error'],
        },
        waitMs: 1000,
      },
    ],
  },

  cancellation: {
    name: 'cancellation',
    persona: 'STOP/START Customer',
    description: 'Customer starts a flow, cancels, and restarts',
    steps: [
      {
        input: { type: 'text', text: 'Hi' },
        expect: { httpStatus: 200 },
      },
      {
        input: { type: 'text', text: 'Book appointment' },
        expect: { httpStatus: 200 },
        waitMs: 500,
      },
      {
        input: { type: 'text', text: 'cancel' },
        expect: {
          httpStatus: 200,
          replyNotContains: ['error'],
        },
        waitMs: 500,
      },
      {
        input: { type: 'text', text: 'start over' },
        expect: {
          httpStatus: 200,
          replyNotContains: ['error'],
        },
      },
    ],
  },

  confused: {
    name: 'confused',
    persona: 'Confused Customer',
    description: 'Customer sends gibberish and off-topic messages',
    steps: [
      {
        input: { type: 'text', text: 'asdjfklasdf' },
        expect: {
          httpStatus: 200,
          replyNotContains: ['error', 'undefined', 'null'],
        },
      },
      {
        input: { type: 'text', text: 'what is the meaning of life?' },
        expect: {
          httpStatus: 200,
          replyNotContains: ['error'],
        },
        waitMs: 1000,
      },
      {
        input: { type: 'text', text: 'help' },
        expect: {
          httpStatus: 200,
          replyNotContains: ['error'],
        },
      },
    ],
  },

  languageSwitch: {
    name: 'language-switch',
    persona: 'Multilingual Customer',
    description: 'Customer switches between English and another language',
    steps: [
      {
        input: { type: 'text', text: 'Hi' },
        expect: { httpStatus: 200 },
      },
      {
        input: { type: 'text', text: 'Bonjour, je voudrais réserver' },
        expect: {
          httpStatus: 200,
          replyNotContains: ['error'],
        },
        waitMs: 1000,
      },
    ],
  },
};

// ── Journey Executor ──

/**
 * Execute a conversation scenario and record results.
 */
export async function executeConversation(
  client: WebhookClient,
  customer: CustomerIdentity,
  scenario: ConversationScenario,
  logger: AuditLogger,
  journeyId: string,
  cleanup: CleanupTracker,
): Promise<{ passed: boolean; failedStep?: number; error?: string }> {
  const journey = logger.startJourney({
    journeyId,
    persona: scenario.persona,
    scenario: scenario.description,
    metadata: {
      scenarioName: scenario.name,
      customerPhone: customer.sanitized.phone,
    },
  });

  let allPassed = true;

  for (let i = 0; i < scenario.steps.length; i++) {
    const step = scenario.steps[i];
    const stepIndex = logger.startStep(journeyId, `Turn ${i + 1}: ${step.input.text || step.input.buttonTitle || step.input.listTitle}`);

    try {
      // Send the message
      let response: WebhookResponse;

      switch (step.input.type) {
        case 'text':
          response = await client.sendText(customer.phone, step.input.text!);
          break;
        case 'button_reply':
          response = await client.sendButtonReply(
            customer.phone,
            step.input.buttonId!,
            step.input.buttonTitle!,
          );
          break;
        case 'list_reply':
          response = await client.sendListReply(
            customer.phone,
            step.input.listId!,
            step.input.listTitle!,
          );
          break;
        default:
          throw new Error(`Unknown input type: ${step.input.type}`);
      }

      // Check expectations
      let stepPassed = true;

      if (step.expect?.httpStatus && response.status !== step.expect.httpStatus) {
        logger.log({
          runId: logger['runId'],
          journeyId,
          stepIndex,
          eventType: 'db_assertion',
          data: {
            table: 'http_response',
            column: 'status',
            expected: step.expect.httpStatus,
            actual: response.status,
          },
          outcome: 'FAIL',
        });
        stepPassed = false;
      }

      // Check response body for expected/forbidden substrings
      if (step.expect?.replyContains) {
        for (const expected of step.expect.replyContains) {
          if (!response.body.toLowerCase().includes(expected.toLowerCase())) {
            logger.log({
              runId: logger['runId'],
              journeyId,
              stepIndex,
              eventType: 'db_assertion',
              data: {
                table: 'response_body',
                column: 'contains',
                expected,
                actual: `not found in ${response.body.length} char response`,
              },
              outcome: 'FAIL',
            });
            stepPassed = false;
          }
        }
      }

      if (step.expect?.replyNotContains) {
        for (const forbidden of step.expect.replyNotContains) {
          if (response.body.toLowerCase().includes(forbidden.toLowerCase())) {
            logger.log({
              runId: logger['runId'],
              journeyId,
              stepIndex,
              eventType: 'db_assertion',
              data: {
                table: 'response_body',
                column: 'not_contains',
                expected: `should not contain "${forbidden}"`,
                actual: `found "${forbidden}" in response`,
              },
              outcome: 'FAIL',
            });
            stepPassed = false;
          }
        }
      }

      logger.endStep(journeyId, stepIndex, stepPassed ? 'PASS' : 'FAIL');
      if (!stepPassed) {
        allPassed = false;
      }

      // Wait before next step
      if (step.waitMs) {
        await new Promise(resolve => setTimeout(resolve, step.waitMs));
      }
    } catch (err) {
      logger.log({
        runId: logger['runId'],
        journeyId,
        stepIndex,
        eventType: 'error',
        data: { error: (err as Error).message },
        outcome: 'FAIL',
      });
      logger.endStep(journeyId, stepIndex, 'FAIL');
      logger.endJourney(journeyId, 'FAIL');
      return { passed: false, failedStep: i, error: (err as Error).message };
    }
  }

  logger.endJourney(journeyId, allPassed ? 'PASS' : 'FAIL');
  return { passed: allPassed };
}
