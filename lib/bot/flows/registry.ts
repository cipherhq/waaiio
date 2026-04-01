import type { FlowType } from '@/lib/constants';
import type { FlowDefinition } from './types';
import { schedulingFlow } from './scheduling.flow';
import { paymentFlow } from './payment.flow';
import { orderingFlow } from './ordering.flow';
import { ticketingFlow } from './ticketing.flow';

const FLOW_REGISTRY: Record<FlowType, FlowDefinition> = {
  scheduling: schedulingFlow,
  payment: paymentFlow,
  ordering: orderingFlow,
  ticketing: ticketingFlow,
};

export function getFlowDefinition(type: FlowType): FlowDefinition {
  return FLOW_REGISTRY[type];
}

export function getFlowStep(type: FlowType, stepId: string) {
  const flow = FLOW_REGISTRY[type];
  return flow.steps.find(s => s.id === stepId) || null;
}
