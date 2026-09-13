/**
 * Bot Flow Message Instrumentation (#267)
 *
 * Scoped per-execution collector for customer-facing bot-flow messages.
 * Counts logical sender invocations, not transport attempts.
 */

export interface MessageRecord {
  flowType: string;
  stepName: string;
  messageType: 'text' | 'buttons' | 'list' | 'image' | 'document' | 'template' | 'other';
  isTemplate: boolean;
  activeCapability: string | null;
  outcome: 'resolved' | 'explicit_failure' | 'thrown_error';
}

export interface ExecutionSummary {
  executionId: string;
  businessId: string;
  completeness: 'complete' | 'incomplete';
  totalMessages: number;
  resolvedCount: number;
  failureCount: number;
  errorCount: number;
  startedAt: Date;
  completedAt: Date | null;
}

export class FlowExecutionCollector {
  readonly executionId: string;
  readonly businessId: string;
  private records: MessageRecord[] = [];
  private startedAt = new Date();
  private completedAt: Date | null = null;
  private _completeness: 'complete' | 'incomplete' = 'incomplete';
  private _frozenFlowType: string = '';
  private _frozenStepName: string = '';
  private _frozenCapability: string | null = null;

  constructor(executionId: string, businessId: string) {
    this.executionId = executionId;
    this.businessId = businessId;
  }

  /** Freeze attribution context before callback execution */
  freezeContext(flowType: string, stepName: string, activeCapability: string | null) {
    this._frozenFlowType = flowType;
    this._frozenStepName = stepName;
    this._frozenCapability = activeCapability;
  }

  /** Record a logical message send invocation */
  record(messageType: MessageRecord['messageType'], isTemplate: boolean, outcome: MessageRecord['outcome']) {
    this.records.push({
      flowType: this._frozenFlowType,
      stepName: this._frozenStepName,
      messageType,
      isTemplate,
      activeCapability: this._frozenCapability,
      outcome,
    });
  }

  /** Mark execution as complete */
  markComplete() {
    this._completeness = 'complete';
    this.completedAt = new Date();
  }

  /** Mark execution as incomplete */
  markIncomplete() {
    this._completeness = 'incomplete';
    this.completedAt = new Date();
  }

  get summary(): ExecutionSummary {
    return {
      executionId: this.executionId,
      businessId: this.businessId,
      completeness: this._completeness,
      totalMessages: this.records.length,
      resolvedCount: this.records.filter(r => r.outcome === 'resolved').length,
      failureCount: this.records.filter(r => r.outcome === 'explicit_failure').length,
      errorCount: this.records.filter(r => r.outcome === 'thrown_error').length,
      startedAt: this.startedAt,
      completedAt: this.completedAt,
    };
  }

  /** Get aggregate rows keyed by flow+step+type+template+capability */
  get aggregates(): Map<string, { count: number; resolved: number; failures: number; errors: number }> {
    const map = new Map<string, { flowType: string; stepName: string; messageType: string; isTemplate: boolean; activeCapability: string | null; count: number; resolved: number; failures: number; errors: number }>();
    for (const r of this.records) {
      const key = `${r.flowType}|${r.stepName}|${r.messageType}|${r.isTemplate}|${r.activeCapability ?? ''}`;
      const existing = map.get(key);
      if (existing) {
        existing.count++;
        if (r.outcome === 'resolved') existing.resolved++;
        else if (r.outcome === 'explicit_failure') existing.failures++;
        else existing.errors++;
      } else {
        map.set(key, {
          flowType: r.flowType, stepName: r.stepName, messageType: r.messageType,
          isTemplate: r.isTemplate, activeCapability: r.activeCapability,
          count: 1,
          resolved: r.outcome === 'resolved' ? 1 : 0,
          failures: r.outcome === 'explicit_failure' ? 1 : 0,
          errors: r.outcome === 'thrown_error' ? 1 : 0,
        });
      }
    }
    return map as unknown as Map<string, { count: number; resolved: number; failures: number; errors: number }>;
  }

  get rawAggregates() {
    const map = new Map<string, { flowType: string; stepName: string; messageType: string; isTemplate: boolean; activeCapability: string | null; count: number; resolved: number; failures: number; errors: number }>();
    for (const r of this.records) {
      const key = `${r.flowType}|${r.stepName}|${r.messageType}|${r.isTemplate}|${r.activeCapability ?? ''}`;
      const existing = map.get(key);
      if (existing) {
        existing.count++;
        if (r.outcome === 'resolved') existing.resolved++;
        else if (r.outcome === 'explicit_failure') existing.failures++;
        else existing.errors++;
      } else {
        map.set(key, {
          flowType: r.flowType, stepName: r.stepName, messageType: r.messageType,
          isTemplate: r.isTemplate, activeCapability: r.activeCapability,
          count: 1,
          resolved: r.outcome === 'resolved' ? 1 : 0,
          failures: r.outcome === 'explicit_failure' ? 1 : 0,
          errors: r.outcome === 'thrown_error' ? 1 : 0,
        });
      }
    }
    return map;
  }
}

/** Create a scoped sender wrapper that records customer message sends */
export function createScopedSender<T extends Record<string, unknown>>(
  originalSender: T,
  collector: FlowExecutionCollector,
): T {
  // Methods that represent customer-facing message sends
  const COUNTED_METHODS = new Set(['sendText', 'sendButtons', 'sendList', 'sendImage', 'sendDocument', 'sendTemplate', 'sendMessage']);

  const METHOD_TYPE_MAP: Record<string, MessageRecord['messageType']> = {
    sendText: 'text',
    sendButtons: 'buttons',
    sendList: 'list',
    sendImage: 'image',
    sendDocument: 'document',
    sendTemplate: 'template',
    sendMessage: 'other',
  };

  return new Proxy(originalSender, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof prop !== 'string' || typeof value !== 'function') return value;

      if (!COUNTED_METHODS.has(prop)) return value;

      // Return a wrapper that records the invocation
      return async function (this: unknown, ...args: unknown[]) {
        const messageType = METHOD_TYPE_MAP[prop] || 'other';
        const isTemplate = prop === 'sendTemplate';

        try {
          const result = await (value as Function).apply(target, args);
          // Check for explicit failure in result
          if (result && typeof result === 'object' && 'success' in result && (result as Record<string, unknown>).success === false) {
            collector.record(messageType, isTemplate, 'explicit_failure');
          } else {
            collector.record(messageType, isTemplate, 'resolved');
          }
          return result;
        } catch (error) {
          collector.record(messageType, isTemplate, 'thrown_error');
          throw error; // Re-throw unchanged
        }
      };
    },
  }) as T;
}

/** Generate a unique execution ID */
export function generateExecutionId(): string {
  return `exec_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}
