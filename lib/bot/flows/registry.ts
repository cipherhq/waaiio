import type { FlowType } from '@/lib/constants';
import type { FlowDefinition, FlowStepConfig } from './types';
import { schedulingFlow } from './scheduling.flow';
import { paymentFlow } from './payment.flow';
import { orderingFlow } from './ordering.flow';
import { ticketingFlow } from './ticketing.flow';
import { reservationFlow } from './reservation.flow';
import { capabilitySelectionFlow } from './capability-selection.flow';
import { crowdfundingFlow } from './crowdfunding.flow';
import { recurringManageFlow } from './recurring-manage.flow';
import { queueCheckinFlow } from './queue-checkin.flow';
import { feedbackFlow } from './feedback.flow';
import { waitlistFlow } from './waitlist.flow';
import { appointmentFlow } from './appointment.flow';
import { chatFlow } from './chat.flow';
import { loyaltyFlow } from './loyalty.flow';
import { invoiceFlow } from './invoice.flow';
import { surveyFlow } from './survey.flow';
import { pollFlow } from './poll.flow';

const FLOW_REGISTRY: Record<FlowType, FlowDefinition> = {
  scheduling: schedulingFlow,
  appointment: appointmentFlow,
  payment: paymentFlow,
  ordering: orderingFlow,
  ticketing: ticketingFlow,
  reservation: reservationFlow,
  queue: queueCheckinFlow,
};

/** Extended registry including pseudo-flows */
const EXTENDED_REGISTRY: Record<string, FlowDefinition> = {
  ...FLOW_REGISTRY,
  'capability-selection': capabilitySelectionFlow,
  appointment: appointmentFlow,
  crowdfunding: crowdfundingFlow,
  'recurring-manage': recurringManageFlow,
  feedback: feedbackFlow,
  waitlist: waitlistFlow,
  chat: chatFlow,
  loyalty: loyaltyFlow,
  invoice: invoiceFlow,
  survey: surveyFlow,
  poll: pollFlow,
};

export function getFlowDefinition(type: FlowType): FlowDefinition {
  return FLOW_REGISTRY[type];
}

export function getFlowStep(type: FlowType, stepId: string) {
  const flow = FLOW_REGISTRY[type];
  return flow.steps.find(s => s.id === stepId) || null;
}

/**
 * Search ALL flows (including extended) for a step by ID.
 * Used for capability selection → flow handoff where the next step
 * may be in a different flow than the current one.
 */
export function getFlowStepAcrossFlows(stepId: string): { step: FlowStepConfig; flowType: string } | null {
  for (const [flowType, flow] of Object.entries(EXTENDED_REGISTRY)) {
    const step = flow.steps.find(s => s.id === stepId);
    if (step) return { step, flowType };
  }
  return null;
}

/** Get the extended flow definition (includes pseudo-flows) */
export function getExtendedFlowDefinition(type: string): FlowDefinition | null {
  return EXTENDED_REGISTRY[type] || null;
}
